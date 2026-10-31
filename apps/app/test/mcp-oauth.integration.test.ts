import { createHash, randomBytes } from 'node:crypto'
import {
  authenticateOAuthAccessToken,
  can,
  disconnectMcpClient,
  grantRoleAsOperator,
  loadViewer,
} from '@esaf/core'
import { createDb, loadRootEnv, runMigrations, schema, sql, type Db } from '@esaf/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createAuth, mcpResourceUrl } from '../src/server/auth-config.server.ts'
import { oauthQueryValid, resumeAuthorizationUrl } from '../src/server/oauth-query.ts'
import {
  browser as newBrowser,
  eq,
  origin,
  password,
  SoftwareAuthenticator,
} from './auth-helpers.ts'

/**
 * Hele OAuth-flyten for MCP-klienter mot en ekte Better Auth-instans og
 * testdatabasen, slik Claude Code gjør den: registrering, innlogging,
 * godkjenning, kode mot nøkler (med PKCE), fornyelse og frakobling. Dekker også
 * at bare admins i en sterk økt kan godkjenne.
 */

loadRootEnv()
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

const SECRET = 'test-hemmelighet-som-er-lang-nok-for-better-auth'
const RESOURCE = mcpResourceUrl(origin)
const REDIRECT = 'http://localhost:33418/callback'

describe.skipIf(!url)('OAuth for MCP-klienter', () => {
  let db: Db
  let auth: ReturnType<typeof createAuth>

  beforeAll(async () => {
    await runMigrations(url!)
    db = createDb(url!)
    auth = createAuth({
      db,
      baseURL: origin,
      secret: SECRET,
      sendVerificationEmail: async () => {},
    })
  })
  afterAll(() => db?.close())

  beforeEach(async () => {
    await db.execute(
      sql`truncate ${schema.oauthClient}, ${schema.accessRequest}, ${schema.auditEvent}, ${schema.membership}, ${schema.personEmail}, ${schema.person}, ${schema.verification}, ${schema.user} cascade`,
    )
  })

  const browser = () => newBrowser(auth)

  async function account(email: string, role?: 'owner' | 'admin' | 'member') {
    const { user } = await auth.api.signUpEmail({ body: { email, password, name: email } })
    await db.update(schema.user).set({ emailVerified: true }).where(eq(schema.user.id, user.id))
    if (role) await grantRoleAsOperator(db, { email, reason: 'test', role })
    const key = new SoftwareAuthenticator()
    await db.insert(schema.passkey).values(key.row(user.id))
    return { userId: user.id, key }
  }

  /** En forespørsel til appen uten å følge omdirigeringer, med cookiene fra `cookies`. */
  async function request(
    path: string,
    init: {
      method?: string
      form?: Record<string, string>
      json?: unknown
      cookies?: Headers
    } = {},
  ) {
    const headers = new Headers(init.cookies)
    let body: string | undefined
    if (init.form) {
      headers.set('content-type', 'application/x-www-form-urlencoded')
      body = new URLSearchParams(init.form).toString()
    } else if (init.json !== undefined) {
      headers.set('content-type', 'application/json')
      body = JSON.stringify(init.json)
    }
    return auth.handler(
      new Request(new URL(path, origin), {
        method: init.method ?? (body ? 'POST' : 'GET'),
        headers,
        body,
      }),
    )
  }

  /** Registrerer en klient slik Claude Code gjør (RFC 7591), uten innlogging. */
  async function register() {
    const response = await request('/api/auth/oauth2/register', {
      json: {
        client_name: 'Claude Code (esaf)',
        redirect_uris: [REDIRECT],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
    })
    expect(response.status).toBe(201)
    return ((await response.json()) as { client_id: string }).client_id
  }

  function pkce() {
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    return { verifier, challenge }
  }

  const authorizePath = (clientId: string, challenge: string, scope: string) =>
    `/api/auth/oauth2/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope,
      state: 'tilstand',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: RESOURCE,
    })}`

  /** Følger flyten fra klienten til godkjenningssiden. Gir den signerte forespørselen dit. */
  async function untilConsent(
    b: ReturnType<typeof browser>,
    clientId: string,
    challenge: string,
    scope = 'mcp:read mcp:write offline_access',
  ) {
    // Uten økt: til innloggingssiden, med forespørselen signert.
    const first = await request(authorizePath(clientId, challenge, scope))
    expect(first.status).toBe(302)
    const login = new URL(first.headers.get('location')!, origin)
    expect(login.pathname).toBe('/api/mcp-oauth/logg-inn')
    const loginQuery = login.search.slice(1)
    expect(await oauthQueryValid(loginQuery, SECRET)).toBe(true)
    // Etter innloggingen starter `/api/mcp-oauth/logg-inn` forespørselen på nytt.
    const resumed = await request(resumeAuthorizationUrl(loginQuery), { cookies: b.headers() })
    expect(resumed.status).toBe(302)
    const consent = new URL(resumed.headers.get('location')!, origin)
    expect(consent.pathname).toBe('/api/mcp-oauth/godkjenn')
    return consent.search.slice(1)
  }

  /** Svaret fra godkjenningssiden, slik `decideMcpConsent` sender det. */
  const consent = async (
    b: ReturnType<typeof browser>,
    body: { accept: boolean; scope?: string; oauth_query: string },
  ) => {
    const response = await auth.api.oauth2Consent({
      headers: b.headers(),
      request: new Request(`${origin}/mcp/godkjenn`, { method: 'POST', headers: b.headers() }),
      body,
      asResponse: true,
    })
    const json = (await response.json()) as { url: string }
    if (!response.ok) throw Object.assign(new Error('consent'), { statusCode: response.status })
    return json
  }

  async function exchange(clientId: string, code: string, verifier: string) {
    const response = await request('/api/auth/oauth2/token', {
      form: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
        resource: RESOURCE,
      },
    })
    return {
      status: response.status,
      body: (await response.json()) as {
        access_token: string
        refresh_token?: string
        expires_in: number
        scope: string
        error?: string
      },
    }
  }

  it('beskriver OAuth-serveren for klientene (RFC 8414)', async () => {
    const response = await request('/.well-known/oauth-authorization-server/api/auth')
    expect(response.status).toBe(200)
    const metadata = (await response.json()) as Record<string, unknown>
    expect(metadata).toMatchObject({
      issuer: `${origin}/api/auth`,
      authorization_endpoint: `${origin}/api/auth/oauth2/authorize`,
      token_endpoint: `${origin}/api/auth/oauth2/token`,
      registration_endpoint: `${origin}/api/auth/oauth2/register`,
      code_challenge_methods_supported: ['S256'],
    })
    expect(metadata.scopes_supported).toEqual(['mcp:read', 'mcp:write', 'offline_access'])
  })

  it('koden krever PKCE, og en godkjent klient slipper siden neste gang', async () => {
    const { key } = await account('admin@example.test', 'admin')
    const clientId = await register()
    const { challenge } = pkce()
    const b = browser()
    expect((await b.signInWithPasskey(key)).status).toBe(200)
    const query = await untilConsent(b, clientId, challenge)

    const { url: back } = await consent(b, {
      accept: true,
      scope: 'mcp:read mcp:write offline_access',
      oauth_query: query,
    })
    const callback = new URL(back)
    expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT)
    expect(callback.searchParams.get('state')).toBe('tilstand')
    // Feil verifikator gir ingenting (PKCE).
    const wrong = await exchange(clientId, callback.searchParams.get('code')!, pkce().verifier)
    expect(wrong.status).toBe(400)

    // Med økt og godkjenning fra før går klienten rett tilbake med en kode.
    const second = await request(
      authorizePath(clientId, pkce().challenge, 'mcp:read mcp:write offline_access'),
      {
        cookies: b.headers(),
      },
    )
    expect(second.status).toBe(302)
    const direct = new URL(second.headers.get('location')!)
    expect(`${direct.origin}${direct.pathname}`).toBe(REDIRECT)
    expect(direct.searchParams.get('code')).toBeTruthy()
  })

  it('godkjenning gir nøkler med riktige prefikser, og frakobling stopper dem', async () => {
    const { userId, key } = await account('admin@example.test', 'admin')
    const clientId = await register()
    const { verifier, challenge } = pkce()
    const b = browser()
    await b.signInWithPasskey(key)
    const query = await untilConsent(b, clientId, challenge)
    const { url: back } = await consent(b, { accept: true, oauth_query: query })
    const code = new URL(back).searchParams.get('code')!
    const { status, body: tokens } = await exchange(clientId, code, verifier)
    expect(status).toBe(200)
    expect(tokens.access_token).toMatch(/^esaf_at_/)
    expect(tokens.refresh_token).toMatch(/^esaf_rt_/)
    expect(tokens.expires_in).toBe(3600)

    // Godkjenningen står i loggen, med klienten.
    const [connected] = await db
      .select({ action: schema.auditEvent.action, details: schema.auditEvent.details })
      .from(schema.auditEvent)
      .where(eq(schema.auditEvent.action, 'mcp_oauth.connect'))
    expect(connected?.details).toMatchObject({
      clientId,
      name: 'Claude Code (esaf)',
      readOnly: false,
      redirectHosts: ['localhost'],
    })

    // Bare hashen lagres.
    const stored = await db.select().from(schema.oauthAccessToken)
    expect(JSON.stringify(stored)).not.toContain(tokens.access_token.slice(8))

    const viewer = await authenticateOAuthAccessToken(db, tokens.access_token, RESOURCE)
    expect(viewer?.userId).toBe(userId)
    expect(viewer?.mcp).toEqual({ oauthClientId: clientId, readOnly: false })
    expect(can(viewer, 'mcp.access')).toBe(true)
    // Nøkkelen gjelder bare MCP-serveren.
    expect(
      await authenticateOAuthAccessToken(db, tokens.access_token, 'https://example.com/mcp'),
    ).toBeNull()

    // Fornyelse gir nye nøkler.
    const refreshed = await request('/api/auth/oauth2/token', {
      form: {
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token!,
        client_id: clientId,
        resource: RESOURCE,
      },
    })
    expect(refreshed.status).toBe(200)
    const next = (await refreshed.json()) as { access_token: string; refresh_token: string }
    expect(next.access_token).not.toBe(tokens.access_token)
    expect(await authenticateOAuthAccessToken(db, next.access_token, RESOURCE)).not.toBeNull()

    // Frakobling i appen: alle nøklene slutter å virke, og fornyelse går ikke.
    const owner = await loadViewer(db, userId, { signedInWithPasskey: true })
    await disconnectMcpClient(db, owner, clientId)
    expect(await authenticateOAuthAccessToken(db, next.access_token, RESOURCE)).toBeNull()
    const again = await request('/api/auth/oauth2/token', {
      form: {
        grant_type: 'refresh_token',
        refresh_token: next.refresh_token,
        client_id: clientId,
        resource: RESOURCE,
      },
    })
    expect(again.status).toBeGreaterThanOrEqual(400)
  })

  it('bare lesing: adminen kan gi mindre enn klienten ba om', async () => {
    const { key } = await account('admin@example.test', 'admin')
    const clientId = await register()
    const { verifier, challenge } = pkce()
    const b = browser()
    await b.signInWithPasskey(key)
    const query = await untilConsent(b, clientId, challenge)
    const { url: back } = await consent(b, {
      accept: true,
      scope: 'mcp:read offline_access',
      oauth_query: query,
    })
    const { body: tokens } = await exchange(
      clientId,
      new URL(back).searchParams.get('code')!,
      verifier,
    )
    const viewer = await authenticateOAuthAccessToken(db, tokens.access_token, RESOURCE)
    expect(viewer?.mcp?.readOnly).toBe(true)
  })

  it('bare admins i en sterk økt kan godkjenne', async () => {
    const member = await account('medlem@example.test', 'member')
    const admin = await account('admin@example.test', 'admin')
    const clientId = await register()
    const { challenge } = pkce()

    // Et medlem, med passkey.
    const m = browser()
    await m.signInWithPasskey(member.key)
    const memberQuery = await untilConsent(m, clientId, challenge)
    await expect(consent(m, { accept: true, oauth_query: memberQuery })).rejects.toMatchObject({
      statusCode: 403,
    })

    // En admin som bare har logget inn med passord (kontoen har passkey, men ikke tofaktor).
    const a = browser()
    expect((await a.signInWithPassword('admin@example.test')).status).toBe(200)
    const adminQuery = await untilConsent(a, clientId, challenge)
    await expect(consent(a, { accept: true, oauth_query: adminQuery })).rejects.toMatchObject({
      statusCode: 403,
    })

    // Å avvise går alltid, og sender klienten tilbake med `access_denied`.
    const { url } = await consent(m, { accept: false, oauth_query: memberQuery })
    expect(new URL(url).searchParams.get('error')).toBe('access_denied')
    expect(await db.$count(schema.oauthConsent)).toBe(0)
    void admin
  })

  it('klientene kan ikke lage, se eller slette klienter fra en økt', async () => {
    const { key } = await account('admin@example.test', 'admin')
    const b = browser()
    await b.signInWithPasskey(key)
    for (const path of ['/oauth2/get-clients', '/oauth2/get-consents']) {
      expect((await request(`/api/auth${path}`, { cookies: b.headers() })).status).toBe(404)
    }
    const created = await request('/api/auth/oauth2/create-client', {
      json: { redirect_uris: ['https://example.com/cb'] },
      cookies: b.headers(),
    })
    expect(created.status).toBe(404)
  })
})
