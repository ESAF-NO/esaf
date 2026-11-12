import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  authenticateOAuthAccessToken,
  createApiToken,
  createDiskStorage,
  createProfile,
  decideMembership,
  disconnectMcpClient,
  DomainError,
  grantRoleAsOperator,
  hashOAuthToken,
  listAuditEvents,
  listMcpConnections,
  loadViewer,
  pruneOAuth,
  withEmailLog,
  type EmailMessage,
  type ObjectStorage,
  type Viewer,
} from '@esaf/core'
import { createDb, loadRootEnv, runMigrations, schema, type Db } from '@esaf/db'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { eq, isNotNull, sql } from 'drizzle-orm'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MCP_RECIPES, MCP_TOOL_GROUPS } from '../src/catalog.ts'
import { createAdminMcpHttpHandler } from '../src/index.ts'

loadRootEnv()
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

const APP_URL = 'http://localhost:3000'
const ENDPOINT = `${APP_URL}/api/mcp`
const METADATA = `${APP_URL}/.well-known/oauth-protected-resource/api/mcp`

const png = (size = 400) =>
  sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 200, g: 40, b: 40, alpha: 1 },
    },
  })
    .png()
    .toBuffer()

describe.skipIf(!url)('MCP-serveren over HTTP', () => {
  let db: Db
  let dir: string
  let storage: ObjectStorage
  let owner: Viewer
  let admin: Viewer
  let handle: (request: Request) => Promise<Response>
  const mailbox: EmailMessage[] = []
  /** Adressene verktøyene har bedt om å hente bilder fra. */
  const fetched: string[] = []

  beforeAll(async () => {
    await runMigrations(url!)
    db = createDb(url!)
    dir = await mkdtemp(join(tmpdir(), 'esaf-mcp-'))
    storage = createDiskStorage(dir)
    handle = createAdminMcpHttpHandler({
      db,
      storage,
      appUrl: APP_URL,
      resource: ENDPOINT,
      resourceMetadataUrl: METADATA,
      clientAddress: (request) => request.headers.get('x-test-address') ?? '203.0.113.7',
      // Logget som i appen, med en postkasse i stedet for Cloudflare.
      mailer: withEmailLog(db, {
        provider: 'console',
        send: async (m) => void mailbox.push(m),
      }),
      // Forutsigbar «modell»: rakett, romfart og space er samme begrep.
      embedder: {
        model: 'test-model',
        async embed(texts) {
          return texts.map((t) => {
            const space = (t.toLowerCase().match(/space|romfart|rakett|satellitt/g) ?? []).length
            const len = Math.hypot(0.3, space)
            return new Float32Array([0.3 / len, space / len])
          })
        },
      },
      // Ingen nettverk i testene: bildene lages her.
      fetchImage: async (imageUrl) => {
        fetched.push(imageUrl)
        if (imageUrl.includes('mangler')) throw new DomainError('Fikk svar 404 fra example.com.')
        return png()
      },
    })
  })
  afterAll(async () => {
    await db?.close()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  async function account(name: string, { twoFactor = false } = {}) {
    const id = randomUUID()
    await db.insert(schema.user).values({
      id,
      name,
      email: `${name.toLowerCase()}@example.test`,
      emailVerified: true,
      twoFactorEnabled: twoFactor,
    })
    return id
  }

  beforeEach(async () => {
    fetched.length = 0
    await db.execute(
      sql`truncate ${schema.apiToken}, ${schema.oauthClient}, ${schema.fieldSource}, ${schema.auditEvent}, ${schema.membership}, ${schema.personCohort}, ${schema.personEmail}, ${schema.person}, ${schema.cohort}, ${schema.user}, ${schema.company}, ${schema.quote}, ${schema.invitation}, ${schema.event}, ${schema.eventParticipation}, ${schema.badge} cascade`,
    )
    for (const [name, role] of [
      ['Eier', 'owner'],
      ['Admin', 'admin'],
    ] as const) {
      await account(name, { twoFactor: true })
      await grantRoleAsOperator(db, {
        email: `${name.toLowerCase()}@example.test`,
        reason: 'test',
        role,
      })
    }
    const users = await db.select().from(schema.user)
    owner = await loadViewer(db, users.find((u) => u.name === 'Eier')!.id)
    admin = await loadViewer(db, users.find((u) => u.name === 'Admin')!.id)
  })

  const tokenFor = async (viewer: Viewer, readOnly = false) =>
    (await createApiToken(db, viewer, { name: 'Claude Code', days: 30, readOnly })).token

  /**
   * En OAuth-tilkobling slik Better Auth lagrer den etter innlogging og
   * godkjenning: klienten, godkjenningen og en tilgangsnøkkel (bare hashen).
   */
  async function oauthTokenFor(
    viewer: Viewer,
    options: { scopes?: string[]; resources?: string[]; expiresAt?: Date; clientId?: string } = {},
  ) {
    const clientId = options.clientId ?? `klient-${randomUUID()}`
    const scopes = options.scopes ?? ['mcp:read', 'mcp:write', 'offline_access']
    await db
      .insert(schema.oauthClient)
      .values({
        id: randomUUID(),
        clientId,
        name: 'Claude',
        redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
        createdAt: new Date(),
      })
      .onConflictDoNothing()
    await db.insert(schema.oauthConsent).values({
      id: randomUUID(),
      clientId,
      userId: viewer!.userId,
      scopes,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const raw = randomUUID().replaceAll('-', '')
    await db.insert(schema.oauthAccessToken).values({
      id: randomUUID(),
      token: hashOAuthToken(raw),
      clientId,
      userId: viewer!.userId,
      scopes,
      resources: options.resources ?? [ENDPOINT],
      createdAt: new Date(),
      expiresAt: options.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
    })
    return { token: `esaf_at_${raw}`, clientId }
  }

  /** En ekte MCP-klient mot håndtereren, uten nettverk. */
  async function connect(token: string) {
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(ENDPOINT), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
        fetch: (input, init) => handle(new Request(input, init)),
      }),
    )
    return client
  }

  async function call<T = Record<string, unknown>>(
    client: Client,
    name: string,
    args: object = {},
  ) {
    const result = await client.callTool({ name, arguments: args as Record<string, unknown> })
    const text = (result.content as { type: string; text: string }[])[0]!.text
    if (result.isError) throw new Error(text)
    return JSON.parse(text) as T
  }

  async function callError(client: Client, name: string, args: object = {}) {
    const result = await client.callTool({ name, arguments: args as Record<string, unknown> })
    expect(result.isError).toBe(true)
    return (result.content as { text: string }[])[0]!.text
  }

  const post = (headers: Record<string, string>) =>
    handle(
      new Request(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
    )

  describe('tilgang', () => {
    it('avviser forespørsler uten gyldig nøkkel, fra andre nettsteder og fra kontoer uten rettigheten', async () => {
      const missing = await post({})
      expect(missing.status).toBe(401)
      expect(missing.headers.get('www-authenticate')).toMatch(/^Bearer realm="ESAF"/)
      expect((await post({ authorization: `Bearer esaf_${'x'.repeat(43)}` })).status).toBe(401)

      const token = await tokenFor(admin)
      expect(
        (await post({ authorization: `Bearer ${token}`, origin: 'https://evil.example' })).status,
      ).toBe(403)

      // Rollen tas bort: nøkkelen trekkes tilbake og virker ikke lenger.
      const { changeRole } = await import('@esaf/core')
      await changeRole(db, owner, { personId: admin!.personId!, role: 'member' })
      expect((await post({ authorization: `Bearer ${token}` })).status).toBe(401)
    })

    it('401 peker på beskrivelsen av ressursen, så klienten kan logge inn selv', async () => {
      const missing = await post({})
      const challenge = missing.headers.get('www-authenticate')!
      expect(challenge).toContain(`resource_metadata="${METADATA}"`)
      expect(challenge).toContain('scope="mcp:read mcp:write offline_access"')
      expect(challenge).not.toContain('error=')
      const invalid = await post({ authorization: `Bearer esaf_at_${'x'.repeat(32)}` })
      expect(invalid.status).toBe(401)
      expect(invalid.headers.get('www-authenticate')).toContain('error="invalid_token"')
    })

    it('en OAuth-tilkobling virker som kontoen, og merkes med klienten i loggen', async () => {
      const { token, clientId } = await oauthTokenFor(admin)
      const client = await connect(token)
      const overview = await call<{ actingAs: { role: string; readOnly: boolean } }>(
        client,
        'overview',
      )
      expect(overview.actingAs).toMatchObject({ role: 'admin', readOnly: false })
      await call(client, 'create_company', { name: 'Oauth AS' })
      await client.close()
      const rows = await db
        .select({ action: schema.auditEvent.action, client: schema.auditEvent.oauthClientId })
        .from(schema.auditEvent)
        .where(isNotNull(schema.auditEvent.oauthClientId))
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((r) => r.client === clientId)).toBe(true)
      const viaMcp = await listAuditEvents(db, owner, { viaMcp: true })
      expect(viaMcp[0]!.viaMcp).toEqual({ kind: 'oauth', name: 'Claude' })
    })

    it('OAuth med bare mcp:read ser bare verktøy som leser', async () => {
      const { token } = await oauthTokenFor(owner, { scopes: ['mcp:read', 'offline_access'] })
      const client = await connect(token)
      const tools = (await client.listTools()).tools
      expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true)
      await client.close()
    })

    it('avviser utløpte nøkler, nøkler for en annen ressurs og uten MCP-rettighet', async () => {
      const expired = await oauthTokenFor(admin, { expiresAt: new Date(Date.now() - 1000) })
      expect((await post({ authorization: `Bearer ${expired.token}` })).status).toBe(401)
      const other = await oauthTokenFor(admin, { resources: ['https://example.com/api'] })
      expect((await post({ authorization: `Bearer ${other.token}` })).status).toBe(401)
      const noScope = await oauthTokenFor(admin, { scopes: ['offline_access'] })
      expect((await post({ authorization: `Bearer ${noScope.token}` })).status).toBe(401)
      const disabled = await oauthTokenFor(admin)
      await db
        .update(schema.oauthClient)
        .set({ disabled: true })
        .where(eq(schema.oauthClient.clientId, disabled.clientId))
      expect((await post({ authorization: `Bearer ${disabled.token}` })).status).toBe(401)
    })

    it('frakobling og tapt adminrolle fjerner tilkoblingen med en gang', async () => {
      const first = await oauthTokenFor(admin)
      expect((await post({ authorization: `Bearer ${first.token}` })).status).toBe(200)
      expect((await listMcpConnections(db, admin)).map((c) => c.clientId)).toEqual([first.clientId])
      await disconnectMcpClient(db, admin, first.clientId)
      expect((await post({ authorization: `Bearer ${first.token}` })).status).toBe(401)
      expect(await listMcpConnections(db, admin)).toEqual([])
      const [logged] = await listAuditEvents(db, owner, { actionPrefix: 'mcp_oauth.' })
      expect(logged).toMatchObject({ action: 'mcp_oauth.disconnect', details: { name: 'Claude' } })

      const second = await oauthTokenFor(admin)
      const { changeRole } = await import('@esaf/core')
      await changeRole(db, owner, { personId: admin!.personId!, role: 'member' })
      expect((await post({ authorization: `Bearer ${second.token}` })).status).toBe(401)
      expect(await db.$count(schema.oauthConsent)).toBe(0)
      const [change] = await listAuditEvents(db, owner, { actionPrefix: 'role.' })
      expect(change!.details).toMatchObject({ revokedConnections: 1 })
    })

    it('en OAuth-tilkobling kan ikke se eller lage nøkler og tilkoblinger', async () => {
      const { token } = await oauthTokenFor(admin)
      const viewer = await authenticateOAuthAccessToken(db, token, ENDPOINT)
      expect(viewer?.mcp).toMatchObject({ readOnly: false })
      await expect(listMcpConnections(db, viewer)).rejects.toThrow()
      await expect(
        createApiToken(db, viewer, { name: 'x', days: 1, readOnly: false }),
      ).rejects.toThrow()
    })

    it('rydder bort utløpte nøkler og klienter som aldri ble godkjent', async () => {
      const now = new Date()
      const day = 24 * 60 * 60 * 1000
      await db.insert(schema.oauthClient).values({
        id: randomUUID(),
        clientId: 'gammel',
        redirectUris: ['http://localhost:1234/callback'],
        createdAt: new Date(now.getTime() - 2 * day),
      })
      await db.insert(schema.oauthClient).values({
        id: randomUUID(),
        clientId: 'ny',
        redirectUris: ['http://localhost:1234/callback'],
        createdAt: now,
      })
      const kept = await oauthTokenFor(admin, { expiresAt: new Date(now.getTime() - 1000) })
      await db
        .update(schema.oauthClient)
        .set({ createdAt: new Date(now.getTime() - 2 * day) })
        .where(eq(schema.oauthClient.clientId, kept.clientId))
      const result = await pruneOAuth(db, now)
      expect(result).toMatchObject({ accessTokens: 1, clients: 1 })
      const left = (await db.select({ id: schema.oauthClient.clientId }).from(schema.oauthClient))
        .map((c) => c.id)
        .sort()
      // Den godkjente klienten blir, selv om nøkkelen er borte.
      expect(left).toEqual([kept.clientId, 'ny'].sort())
    })

    it('stopper mange avviste forsøk fra samme adresse', async () => {
      const statuses: number[] = []
      for (let i = 0; i < 22; i++)
        statuses.push((await post({ 'x-test-address': '198.51.100.9' })).status)
      expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true)
      expect(statuses.at(-1)).toBe(429)
    })

    it('en nøkkel med bare lesing ser bare verktøy som leser', async () => {
      const full = await connect(await tokenFor(admin))
      const read = await connect(await tokenFor(owner, true))
      const all = (await full.listTools()).tools
      const readOnly = (await read.listTools()).tools
      expect(all.length).toBeGreaterThan(60)
      expect(readOnly.every((t) => t.annotations?.readOnlyHint)).toBe(true)
      expect(readOnly.map((t) => t.name)).toContain('get_person')
      expect(readOnly.map((t) => t.name)).not.toContain('create_profiles')
      await expect(
        read.callTool({ name: 'create_company', arguments: { name: 'X' } }),
      ).rejects.toThrow(/not found/)
      const destructive = all.filter((t) => t.annotations?.destructiveHint).map((t) => t.name)
      expect(destructive).toEqual(
        expect.arrayContaining(['delete_profile', 'merge_people', 'delete_company']),
      )
      // Alle verktøy har beskrivelse og et JSON-skjema som modellen kan lese.
      for (const tool of all) {
        expect(tool.description?.length, tool.name).toBeGreaterThan(20)
        expect(tool.inputSchema.type, tool.name).toBe('object')
      }
      const { prompts } = await full.listPrompts()
      // Oversikten på adminsiden «MCP» viser nøyaktig det serveren har.
      const sorted = (names: readonly string[]) => [...names].sort()
      expect(sorted(MCP_TOOL_GROUPS.flatMap((g) => g.tools))).toEqual(
        sorted(all.map((t) => t.name)),
      )
      expect(sorted(MCP_RECIPES.map((r) => r.name))).toEqual(sorted(prompts.map((p) => p.name)))
      await full.close()
      await read.close()
    })

    it('rettighetene er kontoens egne: en admin kan ikke endre roller', async () => {
      const client = await connect(await tokenFor(admin))
      const overview = await call<{ actingAs: { role: string } }>(client, 'overview')
      expect(overview.actingAs.role).toBe('admin')
      expect(
        await callError(client, 'change_role', { personId: owner!.personId, role: 'member' }),
      ).toBe('Rollen din gir ikke tilgang til dette.')
      await client.close()
    })
  })

  describe('profiler', () => {
    it('lager et kull med bilder i to steg, og alt merkes med nøkkelen i loggen', async () => {
      await createProfile(db, admin, {
        fullName: 'Kari Nordmann',
        cohorts: [{ graduationYear: 2027, relation: 'student' }],
        emails: ['kari@example.test'],
        status: 'active',
      })
      const client = await connect(await tokenFor(admin))
      const profiles = [
        {
          ref: '1',
          fullName: 'Ola Nordmann',
          cohorts: [{ graduationYear: 2027 }],
          photoUrl: 'https://example.com/ola.jpg',
          studyBackground: 'Industriell økonomi',
        },
        { ref: '2', fullName: 'Kari Nordmann', cohorts: [{ graduationYear: 2027 }] },
        {
          ref: '3',
          fullName: 'Per Hansen',
          cohorts: [{ graduationYear: 2027 }],
          photoUrl: 'https://example.com/mangler.jpg',
        },
      ]
      const plan = await call<{
        dryRun: boolean
        counts: Record<string, number>
        rows: { status: string }[]
      }>(client, 'create_profiles', { profiles })
      expect(plan.dryRun).toBe(true)
      expect(plan.counts).toEqual({ create: 2, duplicate: 1, invalid: 0 })
      expect(fetched).toEqual([])
      expect(await db.$count(schema.person)).toBe(3)

      const done = await call<{
        created: number
        rows: { ref: string; personId: string | null; warnings: string[]; link: string | null }[]
      }>(client, 'create_profiles', { profiles, dryRun: false })
      expect(done.created).toBe(2)
      expect(fetched.sort()).toEqual([
        'https://example.com/mangler.jpg',
        'https://example.com/ola.jpg',
      ])
      const [ola, kari, per] = done.rows
      expect(ola!.link).toBe(`${APP_URL}/medlemmer/${ola!.personId}`)
      expect(kari!.personId).toBeNull()
      expect(per!.warnings[0]).toMatch(/Bildet ble ikke hentet/)

      const person = await call<{
        photo: string | null
        studyBackground: string
        cohorts: unknown[]
      }>(client, 'get_person', { personId: ola!.personId })
      expect(person.photo).toMatch(new RegExp(`^${APP_URL}/api/bilder/`))
      expect(person.studyBackground).toBe('Industriell økonomi')

      const tagged = await db
        .select({ action: schema.auditEvent.action })
        .from(schema.auditEvent)
        .where(isNotNull(schema.auditEvent.apiTokenId))
      expect(tagged.map((r) => r.action).sort()).toEqual([
        'profile.batch_create',
        'profile.create',
        'profile.create',
      ])
      const log = await call<{ action: string; viaMcp: string | null }[]>(
        client,
        'list_audit_log',
        {
          viaMcp: true,
        },
      )
      expect(log.every((e) => e.viaMcp === 'Claude Code')).toBe(true)
      await client.close()
    })

    it('oppdaterer bare feltene som sendes, med kilder, og rører aldri kontaktinfo på profiler med konto', async () => {
      const client = await connect(await tokenFor(admin))
      const [{ personId }] = (
        await call<{ rows: { personId: string }[] }>(client, 'create_profiles', {
          dryRun: false,
          profiles: [
            { fullName: 'Ada Lovelace', city: 'Oslo', cohorts: [{ graduationYear: 2020 }] },
          ],
        })
      ).rows as [{ personId: string }]

      const updated = await call<{
        contactFilled: string[]
        person: {
          city: string
          bio: string
          contact: { phone: string }
          sources: { field: string; label: string }[]
        }
      }>(client, 'update_person', {
        personId,
        bio: 'Gründer og daglig leder i Analytisk.',
        phone: '41234567',
        sources: [{ field: 'bio', url: 'https://www.analytisk.no/om', confidence: 'high' }],
      })
      expect(updated.person.city).toBe('Oslo')
      expect(updated.person.bio).toBe('Gründer og daglig leder i Analytisk.')
      expect(updated.contactFilled).toEqual(['phone'])
      expect(updated.person.contact.phone).toBe('+47 412 34 567')
      expect(updated.person.sources).toEqual([
        expect.objectContaining({ field: 'bio', label: 'analytisk.no' }),
      ])

      const experience = await call<{ company: string; experienceId: string }[]>(
        client,
        'add_experience',
        {
          personId,
          company: 'Analytisk',
          title: 'Daglig leder',
          founder: true,
        },
      )
      expect(experience).toMatchObject([{ company: 'Analytisk' }])
      expect(
        await call<unknown[]>(client, 'remove_experience', {
          personId,
          experienceId: experience[0]!.experienceId,
        }),
      ).toEqual([])

      expect(
        await callError(client, 'update_person', { personId: admin!.personId, phone: '41234567' }),
      ).toMatch(/bare personen selv/)

      // Alt eller ingenting: et annet telefonnummer enn det som står, avvises, og
      // bioen i samme kall lagres heller ikke.
      expect(
        await callError(client, 'update_person', {
          personId,
          bio: 'Noe helt annet.',
          phone: '99887766',
        }),
      ).toBeTruthy()
      const after = await call<{ bio: string; contact: { phone: string } }>(client, 'get_person', {
        personId,
      })
      expect(after.bio).toBe('Gründer og daglig leder i Analytisk.')
      expect(after.contact.phone).toBe('+47 412 34 567')

      // ES-selskapet byttes på navnet, selv om profilen har en id fra før.
      await call(client, 'update_person', { personId, esCompany: 'Gammelt AS' })
      const renamed = await call<{ person: { esCompany: { name: string } } }>(
        client,
        'update_person',
        { personId, esCompany: 'Nytt AS' },
      )
      expect(renamed.person.esCompany.name).toBe('Nytt AS')
      await client.close()
    })

    it('setter profilbilde fra en adresse, og sletter en profil med begrunnelse', async () => {
      const client = await connect(await tokenFor(admin))
      const { personId } = await createProfile(db, admin, {
        fullName: 'Med Bilde',
        cohorts: [],
        emails: [],
        status: 'active',
      })
      const photo = await call<{ photo: string }>(client, 'set_profile_photo', {
        personId,
        imageUrl: 'https://example.com/portrett.png',
        source: { label: 'entreprenorskolen.no', confidence: 'high' },
      })
      expect(photo.photo).toMatch(/\/api\/bilder\/.+-512\.webp$/)
      expect(await callError(client, 'set_profile_photo', { personId })).toMatch(/enten imageUrl/)
      expect(
        await callError(client, 'set_profile_photo', { personId, imageBase64: 'ikke base64!' }),
      ).toMatch(/base64/)

      expect(await callError(client, 'delete_profile', { personId, reason: 'x' })).toMatch(
        /Invalid|reason|tegn/i,
      )
      await call(client, 'delete_profile', { personId, reason: 'Lagt inn ved en feil' })
      expect(await db.select().from(schema.person).where(eq(schema.person.id, personId))).toEqual(
        [],
      )
      await client.close()
    })
  })

  describe('selskaper, sitater og arrangementer', () => {
    it('lager og beriker et selskap med logo, historikk, sak og sitat', async () => {
      const client = await connect(await tokenFor(admin))
      const created = await call<{ companyId: string; slug: string; status: string }>(
        client,
        'create_company',
        {
          name: 'Syrlig AS',
          website: 'syrlig.no',
          sources: [{ field: 'website', url: 'https://www.proff.no/syrlig', confidence: 'high' }],
        },
      )
      expect(created).toMatchObject({ slug: 'syrlig-as', status: 'unknown' })
      const { companyId } = created

      const updated = await call<{ tagline: string; website: string; status: string }>(
        client,
        'update_company',
        {
          companyId,
          tagline: 'Fermenterte drikker fra Trondheim',
          status: 'active',
        },
      )
      expect(updated).toMatchObject({ website: 'https://syrlig.no', status: 'active' })

      const logo = await call<{ logo: string }>(client, 'set_company_logo', {
        companyId,
        imageBase64: (await png(256)).toString('base64'),
      })
      expect(logo.logo).toMatch(/\/api\/logoer\//)

      await call(client, 'add_company_event', {
        companyId,
        year: 2019,
        type: 'founded',
        text: 'Selskapet ble grunnlagt.',
        sourceUrl: 'https://www.proff.no/syrlig',
      })
      await call(client, 'add_company_article', {
        companyId,
        url: 'https://www.adressa.no/sak?utm_source=x',
        title: 'Syrlig vokser',
        year: 2021,
      })
      await call(client, 'add_quote', {
        text: 'Vi startet på ES.',
        speakerName: 'Ola Nordmann',
        confidence: 'high',
        companyId,
        sourceUrl: 'https://www.adressa.no/sak',
      })
      const details = await call<{
        events: unknown[]
        articles: { url: string }[]
        quotes: unknown[]
        sources: { field: string }[]
      }>(client, 'get_company', { slug: 'syrlig-as' })
      expect(details.events).toHaveLength(1)
      expect(details.articles[0]!.url).toBe('https://www.adressa.no/sak')

      expect(details.quotes).toHaveLength(1)
      expect(details.sources.map((s) => s.field)).toEqual(['website'])

      const list = await call<{ total: number }>(client, 'list_companies', { missing: ['logo'] })
      expect(list.total).toBe(0)

      // Et program er selv et selskap, og viser selskapene som har vært med.
      await call(client, 'add_company_event', {
        companyId,
        year: 2020,
        month: 8,
        type: 'programme',
        programme: { name: '6am Accelerator', kind: 'accelerator', batch: 'Kull 4' },
        sourceUrl: 'https://6am.no/portfolio',
      })
      const programme = await call<{ programmeCompanies: { slug: string; batch: string }[] }>(
        client,
        'get_company',
        { slug: '6am-accelerator' },
      )
      expect(programme.programmeCompanies).toMatchObject([{ slug: 'syrlig-as', batch: 'Kull 4' }])
      const withProgramme = await call<{
        events: { type: string; programme?: { slug: string; kind: string } }[]
      }>(client, 'get_company', { slug: 'syrlig-as' })
      expect(withProgramme.events.find((e) => e.type === 'programme')?.programme).toMatchObject({
        slug: '6am-accelerator',
        kind: 'accelerator',
      })
      await client.close()
    })

    it('lager en type, et arrangement og legger til deltakere', async () => {
      const client = await connect(await tokenFor(admin))
      const type = await call<{ id: string; slug: string }>(client, 'create_event_type', {
        name: `Testkveld ${randomUUID().slice(0, 8)}`,
      })
      const { eventId } = await call<{ eventId: string }>(client, 'create_event', {
        typeId: type.id,
        name: 'Fagkveld vår 2024',
        startDate: '2024-03-01',
        datePrecision: 'semester',
      })
      await call(client, 'add_event_participants', {
        eventId,
        personIds: [admin!.personId],
        role: 'organizer',
      })
      const event = await call<{ startDate: string; groups: { people: { role: string }[] }[] }>(
        client,
        'update_event',
        { eventId, location: 'Trondheim' },
      )
      expect(event.startDate).toBe('2024-01-01')
      expect(event.groups.flatMap((g) => g.people)).toMatchObject([{ role: 'organizer' }])
      await client.close()
    })

    it('setter og fjerner et eget bilde på et merke, fra en adresse og base64', async () => {
      const client = await connect(await tokenFor(admin))
      const { badgeId, image: before } = await call<{ badgeId: string; image: string | null }>(
        client,
        'create_badge',
        {
          name: 'Bildemerke',
          description: 'Har et eget bilde.',
          icon: 'award',
          color: 'brand',
          rule: { kind: 'manual' },
        },
      )
      expect(before).toBeNull()

      const url = 'https://example.com/merke.png'
      const { image } = await call<{ image: string }>(client, 'set_badge_image', {
        badge: badgeId,
        imageUrl: url,
      })
      expect(fetched).toContain(url)
      expect(image).toMatch(/\/api\/merkebilder\/[\w-]{22}-256\.webp$/)
      const stored = await readdir(join(dir, 'merkebilder'))
      expect(stored).toHaveLength(2)

      const replaced = await call<{ image: string; icon: string }>(client, 'set_badge_image', {
        badge: 'bildemerke',
        imageBase64: (await png()).toString('base64'),
      })
      expect(replaced.image).not.toBe(image)
      expect(replaced.icon).toBe('award')
      expect(await readdir(join(dir, 'merkebilder'))).not.toEqual(stored)
      const [listed] = (
        await call<{ badgeId: string; image: string }[]>(client, 'list_badges')
      ).filter((b) => b.badgeId === badgeId)
      expect(listed!.image).toBe(replaced.image)

      expect(await callError(client, 'set_badge_image', { badge: badgeId })).toContain(
        'Oppgi enten imageUrl eller imageBase64.',
      )

      const removed = await call<{ image: string | null }>(client, 'remove_badge_image', {
        badge: badgeId,
      })
      expect(removed.image).toBeNull()
      expect(await readdir(join(dir, 'merkebilder'))).toEqual([])

      await call(client, 'set_badge_image', { badge: badgeId, imageUrl: url })
      await call(client, 'delete_badge', { badge: badgeId })
      expect(await readdir(join(dir, 'merkebilder'))).toEqual([])
      await client.close()
    })

    it('lager en stige med merker, forhåndsviser, publiserer og deler ut for hånd', async () => {
      const client = await connect(await tokenFor(admin))
      const options = await call<{ eventTypes: { id: string; slug: string }[]; icons: string[] }>(
        client,
        'badge_options',
      )
      const weekend = options.eventTypes.find((t) => t.slug === 'esaf-helgen')!.id
      expect(options.icons).toContain('tent')
      const { eventId } = await call<{ eventId: string }>(client, 'create_event', {
        typeId: weekend,
        name: 'ESAF-helgen høst 2018',
        startDate: '2018-09-07',
      })
      await call(client, 'add_event_participants', { eventId, personIds: [admin!.personId] })

      const preview = await call<{ ruleText: string; total: number }>(client, 'preview_badge', {
        rule: { kind: 'event_count', eventTypeId: weekend, count: 1 },
      })
      expect(preview).toMatchObject({ ruleText: 'Vært på ESAF-helgen', total: 1 })

      const series = await call<{ slug: string; status: string; sortOrder: number }[]>(
        client,
        'create_badge_series',
        {
          series: 'ESAF-helgen',
          icon: 'tent',
          color: 'brand',
          rule: { kind: 'event_count', eventTypeId: weekend, count: 1 },
          tiers: [
            { threshold: 3, name: 'ESAF-helgen ×3', description: 'Vært på tre ESAF-helger.' },
            { threshold: 1, name: 'ESAF-helgen', description: 'Vært på ESAF-helgen.' },
          ],
        },
      )
      expect(series.map((b) => [b.slug, b.status, b.sortOrder])).toEqual([
        ['esaf-helgen', 'draft', 100],
        ['esaf-helgen-3', 'draft', 101],
      ])

      const published = await call<{ holders: { total: number }; holderList: unknown[] }>(
        client,
        'set_badge_status',
        { badge: 'esaf-helgen', status: 'published' },
      )
      expect(published.holders.total).toBe(1)

      const manual = await call<{ badgeId: string }>(client, 'create_badge', {
        name: 'Ildsjel',
        description: 'For en helt spesiell innsats for ESAF.',
        icon: 'flame',
        color: 'amber',
        rule: { kind: 'manual' },
        publish: true,
      })
      expect(
        await call(client, 'award_badge', {
          badge: manual.badgeId,
          personIds: [owner!.personId],
          citation: 'For innsatsen med ESAF-helgen 2024',
        }),
      ).toEqual({ awarded: 1, updated: 0 })
      expect(
        await callError(client, 'award_badge', {
          badge: 'esaf-helgen',
          personIds: [owner!.personId],
        }),
      ).toMatch(/deles ut etter regelen/)

      const person = await call<{
        badges: { slug: string; source: string; citation: string | null }[]
      }>(client, 'get_person', { personId: owner!.personId })
      expect(person.badges).toMatchObject([
        { slug: 'ildsjel', source: 'manual', citation: 'For innsatsen med ESAF-helgen 2024' },
      ])
      const list = await call<{ slug: string; holders: { total: number } }[]>(
        client,
        'list_badges',
        {
          status: 'published',
        },
      )
      expect(list.map((b) => b.slug).sort()).toEqual(['esaf-helgen', 'ildsjel'])
      await client.close()
    })

    it('lager invitasjonslenker med appens adresse', async () => {
      const client = await connect(await tokenFor(admin))
      const link = await call<{ url: string; role: string }>(client, 'create_invitation', {
        email: 'ny@example.test',
      })
      expect(link.url).toMatch(new RegExp(`^${APP_URL}/invitasjon/[A-Za-z0-9_-]{43}$`))
      expect(
        await callError(client, 'create_invitation', { email: 'ny2@example.test', role: 'admin' }),
      ).toMatch(/hovedadmin/)
      await client.close()
    })
  })

  describe('e-post', () => {
    it('forklarer e-postene, sender test bare til admin selv, og viser den i loggen og tallene', async () => {
      const client = await connect(await tokenFor(admin))
      const { templates, sending } = await call<{
        sending: boolean
        templates: { kind: string; trigger: string; sampleSubject: string }[]
      }>(client, 'email_templates')
      expect(sending).toBe(true)
      expect(templates.map((t) => t.kind)).toContain('welcome')
      const preview = await call<{ subject: string; text: string; html?: string }>(
        client,
        'email_preview',
        { kind: 'welcome' },
      )
      expect(preview.subject).toBe('Du er med i ESAF')
      expect(preview.html).toBeUndefined()

      mailbox.length = 0
      const { to } = await call<{ to: string }>(client, 'send_test_email', { kind: 'invitation' })
      const [account] = await db
        .select({ email: schema.user.email })
        .from(schema.user)
        .where(eq(schema.user.id, admin!.userId))
      expect(to).toBe(account!.email)
      expect(mailbox.map((m) => [m.to, m.subject])).toEqual([
        [account!.email, '[Test] Invitasjon til ESAF'],
      ])

      const log = await call<{ kind: string; toEmail: string; person: { personId: string } }[]>(
        client,
        'list_sent_emails',
        { kind: 'test' },
      )
      expect(log).toMatchObject([
        { kind: 'test', toEmail: account!.email, person: { personId: admin!.personId } },
      ])
      const stats = await call<{ last30: { sent: number } }>(client, 'email_stats')
      expect(stats.last30.sent).toBeGreaterThanOrEqual(1)

      // En nøkkel med bare lesing kan se, men ikke sende.
      const read = await connect(await tokenFor(admin, true))
      expect((await read.listTools()).tools.map((t) => t.name)).not.toContain('send_test_email')
      await client.close()
      await read.close()
    })
  })

  describe('finne folk og ES-universet', () => {
    it('søker på hva folk kan, og søkeord gjør dem lettere å finne', async () => {
      const client = await connect(await tokenFor(admin))
      const created = await call<{ rows: { personId: string }[] }>(client, 'create_profiles', {
        dryRun: false,
        profiles: [
          {
            fullName: 'Kari Rakett',
            cohorts: [{ graduationYear: 2014 }],
            bio: 'Kari bygger rakettmotorer i Trondheim.',
          },
          {
            fullName: 'Ola Annen',
            cohorts: [{ graduationYear: 2015 }],
            bio: 'Ola selger kaffe og elsker sykling.',
          },
        ],
      })
      const [kari, ola] = created.rows.map((r) => r.personId)
      const before = await call<{ hits: { personId: string }[] }>(client, 'find_people', {
        query: 'romfart',
      })
      expect(before.hits).toEqual([])

      const todo = await call<{ items: { personId: string; status: string; text: string[] }[] }>(
        client,
        'list_people_for_tagging',
        {},
      )
      expect(todo.items.find((i) => i.personId === ola)).toMatchObject({
        status: 'missing',
        text: [expect.stringContaining('kaffe')],
      })

      const tagged = await call<{ updated: number; indexed: number }>(client, 'set_search_topics', {
        people: [
          { personId: kari, topics: ['romfart', 'space', 'rakettmotorer'] },
          { personId: ola, topics: ['kaffe', 'coffee'] },
        ],
      })
      expect(tagged.updated).toBe(2)
      expect(tagged.indexed).toBeGreaterThanOrEqual(2)
      const after = await call<{
        semantic: boolean
        hits: { personId: string; reason: string; link: string }[]
      }>(client, 'find_people', { query: 'space' })
      expect(after.semantic).toBe(true)
      expect(after.hits.map((h) => h.personId)).toEqual([kari])
      expect(after.hits[0]!.link).toBe(`${APP_URL}/medlemmer/${kari}`)
      const left = await call<{ items: { personId: string }[] }>(
        client,
        'list_people_for_tagging',
        {},
      )
      expect(left.items.map((i) => i.personId)).not.toContain(kari)
      await client.close()
    })

    it('ES-universet er en MCP App med data i structuredContent', async () => {
      const client = await connect(await tokenFor(admin))
      const { tools } = await client.listTools()
      const tool = tools.find((t) => t.name === 'show_universe')!
      expect(tool._meta).toMatchObject({ ui: { resourceUri: 'ui://esaf/universe.html' } })
      const resource = await client.readResource({ uri: 'ui://esaf/universe.html' })
      const content = resource.contents[0] as { mimeType: string; text: string }
      expect(content.mimeType).toBe('text/html;profile=mcp-app')
      expect(content.text).toContain('ES-universet')
      expect(content.text).not.toMatch(/<script[^>]+src=/)

      await call(client, 'create_profiles', {
        dryRun: false,
        profiles: [
          { fullName: 'Kari Gründer', cohorts: [{ graduationYear: 2014 }], esCompany: 'Syrlig' },
        ],
      })
      const result = await client.callTool({ name: 'show_universe', arguments: {} })
      expect((result.content as { text: string }[])[0]!.text).toMatch(/^ES-universet: \d+ personer/)
      const data = result.structuredContent as {
        appUrl: string
        people: { name: string }[]
        companies: { name: string }[]
        links: { role: string }[]
      }
      expect(data.appUrl).toBe(APP_URL)
      expect(data.people.map((p) => p.name)).toContain('Kari Gründer')
      expect(data.companies.map((c) => c.name)).toEqual(['Syrlig'])
      expect(data.links).toEqual([expect.objectContaining({ role: 'es' })])
      await client.close()
    })
  })

  it('medlemmer uten adminrolle kan ikke lage nøkler', async () => {
    const id = await account('Medlem')
    const v = await loadViewer(db, id)
    await decideMembership(db, admin, { personId: v!.personId!, decision: 'approve' })
    await expect(tokenFor(await loadViewer(db, id))).rejects.toThrow()
  })
})
