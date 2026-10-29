import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import {
  accessLevel,
  AccessDeniedError,
  grantRoleAsOperator,
  listAccounts,
  loadViewer,
} from '@esaf/core'
import { createDb, loadRootEnv, runMigrations, schema, sql, type Db } from '@esaf/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createAuth } from '../src/server/auth-config.server.ts'

/**
 * Passkeys mot en ekte Better Auth-instans og testdatabasen, med en
 * programvare-autentikator i stedet for nettleseren. Dekker at passkey-økter
 * merkes og gir sterk innlogging, at passord alene ikke gjør det, og at
 * passkeys ikke kan byttes ut fra en økt som bare kom fra passordet.
 */

loadRootEnv()
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

const origin = 'http://localhost:3000'
const password = 'korrekt-hest-batteri'
const b64url = (data: Uint8Array) => Buffer.from(data).toString('base64url')
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest()
/** `column = value`, uten å dra inn drizzle-orm som egen avhengighet i appen. */
const eq = (column: unknown, value: string) => sql`${column} = ${value}`

/** Flagg i autentikatordataene: brukeren til stede (UP), bekreftet (UV), med nøkkel (AT). */
const UP = 0x01
const UV = 0x04
const AT = 0x40

/** En passkey slik en telefon eller passordhåndterer ville hatt den. */
class SoftwareAuthenticator {
  readonly credentialId = b64url(randomBytes(16))
  private readonly privateKey: KeyObject
  private readonly cose: Buffer

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    this.privateKey = privateKey
    const jwk = publicKey.export({ format: 'jwk' })
    // COSE_Key for ES256 i CBOR: {1: 2, 3: -7, -1: 1, -2: x, -3: y}.
    this.cose = Buffer.concat([
      Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
      Buffer.from(jwk.x!, 'base64url'),
      Buffer.from([0x22, 0x58, 0x20]),
      Buffer.from(jwk.y!, 'base64url'),
    ])
  }

  private authData(flags: number, attested = false) {
    const parts: Buffer[] = [sha256('localhost'), Buffer.from([flags]), Buffer.alloc(4)]
    if (attested) {
      const id = Buffer.from(this.credentialId, 'base64url')
      const length = Buffer.alloc(2)
      length.writeUInt16BE(id.length)
      parts.push(Buffer.alloc(16), length, id, this.cose)
    }
    return Buffer.concat(parts)
  }

  private clientData(type: string, challenge: string, from = origin) {
    return Buffer.from(JSON.stringify({ type, challenge, origin: from, crossOrigin: false }))
  }

  /** Svar på `navigator.credentials.create()` med attestasjon «none». */
  register(challenge: string, flags = UP | UV) {
    const authData = this.authData(flags | AT, true)
    // CBOR: {"fmt": "none", "attStmt": {}, "authData": bytes}
    const length = Buffer.alloc(2)
    length.writeUInt16BE(authData.length)
    const attestationObject = Buffer.concat([
      Buffer.from([0xa3, 0x63]),
      Buffer.from('fmt'),
      Buffer.from([0x64]),
      Buffer.from('none'),
      Buffer.from([0x67]),
      Buffer.from('attStmt'),
      Buffer.from([0xa0, 0x68]),
      Buffer.from('authData'),
      Buffer.from([0x59]),
      length,
      authData,
    ])
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(this.clientData('webauthn.create', challenge)),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    }
  }

  /** Svar på `navigator.credentials.get()`. */
  assert(challenge: string, { flags = UP | UV, from = origin } = {}) {
    const authData = this.authData(flags)
    const clientData = this.clientData('webauthn.get', challenge, from)
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientData)]), this.privateKey)
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
      },
      clientExtensionResults: {},
    }
  }

  /** Raden pluginen ville lagret ved registrering. */
  row(userId: string) {
    return {
      id: b64url(randomBytes(12)),
      userId,
      name: 'Testnøkkel',
      publicKey: this.cose.toString('base64'),
      credentialID: this.credentialId,
      counter: 0,
      deviceType: 'multiDevice',
      backedUp: true,
      transports: 'internal',
    }
  }
}

describe.skipIf(!url)('passkeys og sterk innlogging', () => {
  let db: Db
  let auth: ReturnType<typeof createAuth>

  beforeAll(async () => {
    await runMigrations(url!)
    db = createDb(url!)
    auth = createAuth({
      db,
      baseURL: origin,
      secret: 'test-hemmelighet-som-er-lang-nok-for-better-auth',
      sendVerificationEmail: async () => {},
    })
  })
  afterAll(() => db?.close())

  beforeEach(async () => {
    await db.execute(
      sql`truncate ${schema.accessRequest}, ${schema.auditEvent}, ${schema.membership}, ${schema.personEmail}, ${schema.person}, ${schema.verification}, ${schema.user} cascade`,
    )
  })

  /** En nettleser: holder på cookiene og sender dem med. */
  function browser() {
    const jar = new Map<string, string>()
    async function call(
      path: string,
      init: { method?: string; body?: unknown; from?: string } = {},
    ) {
      const headers = new Headers({ origin: init.from ?? origin })
      if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '))
      if (init.body !== undefined) headers.set('content-type', 'application/json')
      const response = await auth.handler(
        new Request(`${origin}/api/auth${path}`, {
          method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
          headers,
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
        }),
      )
      for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(';')
        const [name, ...value] = pair!.split('=')
        if (/max-age=0/i.test(cookie)) jar.delete(name!)
        else jar.set(name!, value.join('='))
      }
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) : null }
    }
    return {
      call,
      headers: () => new Headers({ cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') }),
      async signInWithPassword(email: string) {
        return call('/sign-in/email', { body: { email, password } })
      },
      async signInWithPasskey(
        key: SoftwareAuthenticator,
        options?: Parameters<typeof key.assert>[1],
      ) {
        const { body: challenge } = await call('/passkey/generate-authenticate-options')
        return call('/passkey/verify-authentication', {
          body: { response: key.assert(challenge.challenge, options) },
          from: options?.from,
        })
      },
      async session() {
        return auth.api.getSession({ headers: this.headers() })
      },
    }
  }

  /** En bekreftet konto med passord. Med `role` er den også aktivt medlem med rollen. */
  async function account(
    email: string,
    options: { role?: 'owner' | 'admin' | 'member'; verified?: boolean } = {},
  ) {
    const { user } = await auth.api.signUpEmail({ body: { email, password, name: email } })
    if (options.verified !== false) {
      await db.update(schema.user).set({ emailVerified: true }).where(eq(schema.user.id, user.id))
    }
    if (options.role) await grantRoleAsOperator(db, { email, reason: 'test', role: options.role })
    return user.id
  }

  async function addPasskey(userId: string) {
    const key = new SoftwareAuthenticator()
    await db.insert(schema.passkey).values(key.row(userId))
    return key
  }

  /** Hvordan appen ser den innloggede (se `getRequestViewer`). */
  async function viewerOf(b: ReturnType<typeof browser>) {
    const current = await b.session()
    return current ? loadViewer(db, current.user.id, current.session) : null
  }

  async function denial(promise: Promise<unknown>) {
    try {
      await promise
      return 'allowed'
    } catch (error) {
      if (error instanceof AccessDeniedError) return error.reason
      throw error
    }
  }

  it('innlogging med passkey gir en sterk økt, passord alene gjør ikke', async () => {
    const id = await account('eier@example.test', { role: 'owner' })
    const key = await addPasskey(id)

    const withPassword = browser()
    expect((await withPassword.signInWithPassword('eier@example.test')).status).toBe(200)
    expect((await withPassword.session())?.session.signedInWithPasskey).toBe(false)
    expect(await denial(listAccounts(db, await viewerOf(withPassword)))).toBe(
      'strong_auth_required',
    )

    const withPasskey = browser()
    const result = await withPasskey.signInWithPasskey(key)
    expect(result.status).toBe(200)
    expect((await withPasskey.session())?.session.signedInWithPasskey).toBe(true)
    expect(await denial(listAccounts(db, await viewerOf(withPasskey)))).toBe('allowed')
  })

  it('med tofaktor er økten sterk uten passkey', async () => {
    const id = await account('admin@example.test', { role: 'admin' })
    await db.update(schema.user).set({ twoFactorEnabled: true }).where(eq(schema.user.id, id))
    // Innlogging med passord stopper da ved tofaktorsteget; økten kommer først etter koden.
    const b = browser()
    const result = await b.signInWithPassword('admin@example.test')
    expect(result.body).toMatchObject({ twoFactorRedirect: true })
    expect(await b.session()).toBeNull()
    // Økten etter koden er en vanlig økt på en konto med tofaktor.
    const viewer = await loadViewer(db, id, { signedInWithPasskey: false })
    expect(await denial(listAccounts(db, viewer))).toBe('allowed')
  })

  it('økten kan ikke merkes som passkey-økt fra klienten', async () => {
    await account('medlem@example.test')
    const b = browser()
    await b.signInWithPassword('medlem@example.test')
    await b.call('/update-session', { body: { signedInWithPasskey: true } })
    expect((await b.session())?.session.signedInWithPasskey).toBe(false)
  })

  it('passkeyen må bekrefte personen med biometri eller PIN', async () => {
    const key = await addPasskey(await account('medlem@example.test'))
    const b = browser()
    const result = await b.signInWithPasskey(key, { flags: UP })
    expect(result.status).toBe(401)
    expect(result.body.code).toBe('USER_VERIFICATION_REQUIRED')
    expect(await b.session()).toBeNull()
  })

  it('svar laget for en annen opprinnelse avvises', async () => {
    const key = await addPasskey(await account('medlem@example.test'))
    const b = browser()
    const result = await b.signInWithPasskey(key, { from: 'https://esaf-phishing.example' })
    expect(result.status).toBeGreaterThanOrEqual(400)
    expect(await b.session()).toBeNull()
  })

  it('ukjente passkeys gir et generelt avslag, uten å si noe om kontoer', async () => {
    const b = browser()
    const result = await b.signInWithPasskey(new SoftwareAuthenticator())
    expect(result.status).toBe(401)
    expect(await b.session()).toBeNull()
  })

  it('ubekreftede kontoer kommer ikke inn med passkey', async () => {
    const key = await addPasskey(await account('ny@example.test', { verified: false }))
    const b = browser()
    const result = await b.signInWithPasskey(key)
    expect(result.status).toBe(403)
    expect(result.body.code).toBe('EMAIL_NOT_VERIFIED')
    expect(await b.session()).toBeNull()
  })

  it('deaktiverte medlemmer får ikke tilgang med passkey heller', async () => {
    const id = await account('borte@example.test', { role: 'admin' })
    const key = await addPasskey(id)
    await db.update(schema.membership).set({ status: 'inactive', role: 'member' })
    const b = browser()
    await b.signInWithPasskey(key)
    expect(accessLevel(await viewerOf(b))).toBe('pending')
  })

  it('å logge inn med passkey fra en passordøkt erstatter den gamle økten', async () => {
    const id = await account('eier@example.test', { role: 'owner' })
    const key = await addPasskey(id)
    const b = browser()
    await b.signInWithPassword('eier@example.test')
    const weak = await b.session()
    expect((await b.signInWithPasskey(key)).status).toBe(200)
    const strong = await b.session()
    expect(strong?.session.signedInWithPasskey).toBe(true)
    const sessions = await db
      .select({ id: schema.session.id })
      .from(schema.session)
      .where(eq(schema.session.userId, id))
    expect(sessions.map((s) => s.id)).toEqual([strong!.session.id])
    expect(sessions.map((s) => s.id)).not.toContain(weak!.session.id)
  })

  it('den første passkeyen kan legges til med passord, og brukes til å logge inn', async () => {
    const id = await account('medlem@example.test')
    const b = browser()
    await b.signInWithPassword('medlem@example.test')
    const key = new SoftwareAuthenticator()

    const options = await b.call('/passkey/generate-register-options')
    expect(options.status).toBe(200)
    // Lagres i passordhåndtereren og krever biometri eller PIN.
    expect(options.body.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      userVerification: 'required',
    })
    expect(options.body.rp).toEqual({ name: 'ESAF', id: 'localhost' })
    const added = await b.call('/passkey/verify-registration', {
      body: { response: key.register(options.body.challenge) },
    })
    expect(added.status).toBe(200)
    expect(added.body).toMatchObject({ userId: id, deviceType: 'singleDevice' })

    const later = browser()
    expect((await later.signInWithPasskey(key)).status).toBe(200)
    expect((await later.session())?.user.id).toBe(id)
  })

  it('registrering uten bekreftet person avvises', async () => {
    await account('medlem@example.test')
    const b = browser()
    await b.signInWithPassword('medlem@example.test')
    const options = await b.call('/passkey/generate-register-options')
    const result = await b.call('/passkey/verify-registration', {
      body: { response: new SoftwareAuthenticator().register(options.body.challenge, UP) },
    })
    expect(result.body.code).toBe('USER_VERIFICATION_REQUIRED')
    expect(await db.select().from(schema.passkey)).toEqual([])
  })

  it('har kontoen passkey, kan ikke en passordøkt legge til, fjerne eller slå på tofaktor', async () => {
    const id = await account('eier@example.test', { role: 'owner' })
    const key = await addPasskey(id)
    const [stored] = await db.select().from(schema.passkey)

    const weak = browser()
    await weak.signInWithPassword('eier@example.test')
    for (const attempt of [
      weak.call('/passkey/generate-register-options'),
      weak.call('/passkey/delete-passkey', { body: { id: stored!.id } }),
      weak.call('/two-factor/enable', { body: { password } }),
    ]) {
      const result = await attempt
      expect(result.status).toBe(403)
      expect(result.body.code).toBe('STRONG_AUTH_REQUIRED')
    }
    expect(await db.select().from(schema.passkey)).toHaveLength(1)
    // Å gi den nytt navn er ufarlig.
    const renamed = await weak.call('/passkey/update-passkey', {
      body: { id: stored!.id, name: 'MacBook' },
    })
    expect(renamed.status).toBe(200)

    const strong = browser()
    await strong.signInWithPasskey(key)
    expect((await strong.call('/passkey/generate-register-options')).status).toBe(200)
    expect(
      (await strong.call('/passkey/delete-passkey', { body: { id: stored!.id } })).status,
    ).toBe(200)
  })

  it('andres passkeys kan verken endres eller fjernes', async () => {
    await addPasskey(await account('annen@example.test'))
    const [stored] = await db.select().from(schema.passkey)
    await account('medlem@example.test')
    const b = browser()
    await b.signInWithPassword('medlem@example.test')
    expect((await b.call('/passkey/delete-passkey', { body: { id: stored!.id } })).status).toBe(401)
    expect(
      (await b.call('/passkey/update-passkey', { body: { id: stored!.id, name: 'Min' } })).status,
    ).toBe(401)
    expect(await db.select().from(schema.passkey)).toHaveLength(1)
  })
})
