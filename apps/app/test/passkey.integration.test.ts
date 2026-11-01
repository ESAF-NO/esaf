import {
  accessLevel,
  AccessDeniedError,
  grantRoleAsOperator,
  listAccounts,
  loadViewer,
} from '@esaf/core'
import { createDb, loadRootEnv, runMigrations, schema, sql, type Db } from '@esaf/db'
import { getIP } from 'better-auth/api'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createAuth } from '../src/server/auth-config.server.ts'
import {
  browser as newBrowser,
  eq,
  origin,
  password,
  SoftwareAuthenticator,
  UP,
} from './auth-helpers.ts'

/**
 * Passkeys mot en ekte Better Auth-instans og testdatabasen, med en
 * programvare-autentikator i stedet for nettleseren. Dekker at passkey-økter
 * merkes og gir sterk innlogging, at passord alene ikke gjør det, og at
 * passkeys ikke kan byttes ut fra en økt som bare kom fra passordet.
 */

loadRootEnv()
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

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

  const browser = () => newBrowser(auth)

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

  it('nettleseren blir bedt om å bekrefte personen, ikke bare oppfordret', async () => {
    // Med «preferred» hopper Google Passordlagring over PIN, og svaret avvises.
    const anonymous = await browser().call('/passkey/generate-authenticate-options')
    expect(anonymous.body.userVerification).toBe('required')

    const id = await account('medlem@example.test')
    const key = await addPasskey(id)
    const b = browser()
    await b.signInWithPassword('medlem@example.test')
    const signedIn = await b.call('/passkey/generate-authenticate-options')
    expect(signedIn.body.userVerification).toBe('required')
    expect(signedIn.body.allowCredentials).toHaveLength(1)
    // Utfordringen virker fortsatt: cookien fra pluginen er med.
    expect((await b.signInWithPasskey(key)).status).toBe(200)
  })

  it('grensene for innlogging gjelder hver klient, bak Cloudflare og Traefik', () => {
    const ip = (forwardedFor: string) =>
      getIP(new Request(origin, { headers: { 'x-forwarded-for': forwardedFor } }), auth.options)
    // Cloudflare legger til klienten, Traefik adressen til cloudflared.
    expect(ip('203.0.113.7, 172.18.0.5')).toBe('203.0.113.7')
    // En forfalsket adresse foran hjelper ikke: den bakerste ukjente er klienten.
    expect(ip('198.51.100.1, 203.0.113.7, 172.18.0.5')).toBe('203.0.113.7')
    // Direkte til serveren, uten mellomledd.
    expect(ip('203.0.113.7')).toBe('203.0.113.7')
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
