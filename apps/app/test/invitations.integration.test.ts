import {
  accessLevel,
  createInvitationAsOperator,
  createPasswordResetLinkAsOperator,
  loadViewer,
} from '@esaf/core'
import { createDb, loadRootEnv, runMigrations, schema, sql, type Db } from '@esaf/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createAuth } from '../src/server/auth-config.server.ts'
import { browser, eq, origin, password, SoftwareAuthenticator } from './auth-helpers.ts'

/**
 * Invitasjoner og lenker for nytt passord mot en ekte Better Auth-instans og
 * testdatabasen, uten e-postleverandør: registrering er stengt på serveren,
 * kontoer lages fra invitasjoner (med passord eller passkey), og en lenke for
 * nytt passord logger ut alle økter uten å komme forbi tofaktor.
 */

loadRootEnv()
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

const secret = 'test-hemmelighet-som-er-lang-nok-for-better-auth'

describe.skipIf(!url)('invitasjoner uten e-post', () => {
  let db: Db
  /** Som i produksjon uten e-postleverandør. */
  let auth: ReturnType<typeof createAuth>

  beforeAll(async () => {
    await runMigrations(url!)
    db = createDb(url!)
    auth = createAuth({ db, baseURL: origin, secret })
  })
  afterAll(() => db?.close())

  beforeEach(async () => {
    await db.execute(
      sql`truncate ${schema.invitation}, ${schema.notification}, ${schema.accessRequest}, ${schema.auditEvent}, ${schema.membership}, ${schema.personEmail}, ${schema.person}, ${schema.verification}, ${schema.session}, ${schema.account}, ${schema.user} cascade`,
    )
  })

  async function invite(email: string, role: 'member' | 'owner' = 'member') {
    const { token } = await createInvitationAsOperator(db, { email, role })
    return token
  }

  it('registrering er stengt på serveren uten e-postleverandør', async () => {
    const b = browser(auth)
    const result = await b.call('/sign-up/email', {
      body: { email: 'ny@example.test', password, name: 'Ny' },
    })
    expect(result.status).toBe(400)
    expect(result.body.code).toBe('EMAIL_PASSWORD_SIGN_UP_DISABLED')
    expect(await db.select().from(schema.user)).toEqual([])
  })

  it('med e-postleverandør er registreringen som før', async () => {
    const sent: string[] = []
    const withEmail = createAuth({
      db,
      baseURL: origin,
      secret,
      sendVerificationEmail: async ({ user }) => {
        sent.push(user.email)
      },
    })
    const result = await browser(withEmail).call('/sign-up/email', {
      body: { email: 'ny@example.test', password, name: 'Ny' },
    })
    expect(result.status).toBe(200)
    expect(sent).toEqual(['ny@example.test'])
  })

  it('en invitasjon med passord lager en bekreftet konto, logger inn og gir medlemskap', async () => {
    const token = await invite('ny@example.test', 'owner')
    const b = browser(auth)
    const result = await b.call('/invitation/accept', {
      body: { token, password, fullName: 'Ny Hovedadmin' },
    })
    expect(result.status).toBe(200)
    const session = await b.session()
    expect(session?.user).toMatchObject({ email: 'ny@example.test', emailVerified: true })
    expect(session?.session.signedInWithPasskey).toBe(false)
    const viewer = await loadViewer(db, session!.user.id, session!.session)
    expect(accessLevel(viewer)).toBe('member')
    expect(viewer!.membership).toEqual({ status: 'active', role: 'owner' })

    // Passordet virker senere, som ved vanlig registrering.
    const later = browser(auth)
    expect((await later.signInWithPassword('ny@example.test')).status).toBe(200)
    // Og lenken virker ikke igjen.
    const again = await browser(auth).call('/invitation/accept', {
      body: { token, password, fullName: 'Noen Andre' },
    })
    expect(again.status).toBe(400)
    expect(again.body.code).toBe('INVITATION_USED')
  })

  it('passordreglene gjelder, og et avvist forsøk bruker ikke opp lenken', async () => {
    const token = await invite('ny@example.test')
    const b = browser(auth)
    const short = await b.call('/invitation/accept', {
      body: { token, password: 'for-kort', fullName: 'Ny' },
    })
    expect(short.status).toBe(400)
    expect(short.body.code).toBe('PASSWORD_TOO_SHORT')
    expect(await b.session()).toBeNull()
    const ok = await b.call('/invitation/accept', { body: { token, password, fullName: 'Ny' } })
    expect(ok.status).toBe(200)
  })

  it('ukjente og misdannede tokens avvises uten å lage noe', async () => {
    for (const token of ['', 'x'.repeat(43), "' or 1=1 --"]) {
      const result = await browser(auth).call('/invitation/accept', {
        body: { token, password, fullName: 'Ny' },
      })
      expect(result.status).toBe(400)
    }
    expect(await db.select().from(schema.user)).toEqual([])
  })

  it('en bekreftet konto med samme adresse må logge inn i stedet', async () => {
    const first = await invite('ny@example.test')
    await browser(auth).call('/invitation/accept', {
      body: { token: first, password, fullName: 'Ny' },
    })
    // Aktive medlemmer kan ikke inviteres på nytt; en deaktivert konto kan.
    await db.update(schema.membership).set({ status: 'inactive' })
    const second = await invite('ny@example.test')
    const result = await browser(auth).call('/invitation/accept', {
      body: { token: second, password: 'et-helt-annet-passord', fullName: 'Kaprer' },
    })
    expect(result.status).toBe(400)
    expect(result.body.code).toBe('INVITATION_ACCOUNT_EXISTS')
    // Det gamle passordet virker fortsatt; ingen har tatt over kontoen.
    expect((await browser(auth).signInWithPassword('ny@example.test')).status).toBe(200)
  })

  it('en invitasjon uten passord gir en økt der den første passkeyen legges til', async () => {
    const token = await invite('ny@example.test')
    const b = browser(auth)
    expect((await b.call('/invitation/accept', { body: { token, fullName: 'Ny' } })).status).toBe(
      200,
    )
    const userId = (await b.session())!.user.id
    expect(await db.select().from(schema.account).where(eq(schema.account.userId, userId))).toEqual(
      [],
    )

    const key = new SoftwareAuthenticator()
    const options = await b.call('/passkey/generate-register-options')
    expect(options.status).toBe(200)
    const added = await b.call('/passkey/verify-registration', {
      body: { response: key.register(options.body.challenge) },
    })
    expect(added.status).toBe(200)

    const later = browser(auth)
    expect((await later.signInWithPasskey(key)).status).toBe(200)
    expect((await later.session())?.user.id).toBe(userId)
    // Uten passord kommer ingen inn med passord.
    expect((await browser(auth).signInWithPassword('ny@example.test')).status).toBe(401)
  })

  describe('lenke for nytt passord', () => {
    async function member(email: string) {
      const token = await invite(email)
      const b = browser(auth)
      await b.call('/invitation/accept', { body: { token, password, fullName: 'Medlem' } })
      return b
    }

    it('setter nytt passord, logger ut alle økter og virker én gang', async () => {
      const signedIn = await member('medlem@example.test')
      expect(await signedIn.session()).not.toBeNull()
      const { token } = await createPasswordResetLinkAsOperator(db, {
        email: 'medlem@example.test',
        reason: 'Glemt passord',
      })
      const b = browser(auth)
      const fresh = 'et-nytt-og-langt-passord'
      const result = await b.call('/invitation/reset-password', {
        body: { token, password: fresh },
      })
      expect(result.status).toBe(200)
      // Lenken logger ikke inn, og den gamle økten er borte.
      expect(await b.session()).toBeNull()
      expect(await signedIn.session()).toBeNull()
      expect((await browser(auth).signInWithPassword('medlem@example.test')).status).toBe(401)
      const later = browser(auth)
      expect(
        (
          await later.call('/sign-in/email', {
            body: { email: 'medlem@example.test', password: fresh },
          })
        ).status,
      ).toBe(200)

      const again = await browser(auth).call('/invitation/reset-password', {
        body: { token, password: 'enda-et-nytt-passord' },
      })
      expect(again.body.code).toBe('INVITATION_USED')
    })

    it('kommer ikke forbi tofaktor', async () => {
      await member('medlem@example.test')
      await db
        .update(schema.user)
        .set({ twoFactorEnabled: true })
        .where(eq(schema.user.email, 'medlem@example.test'))
      const { token } = await createPasswordResetLinkAsOperator(db, {
        email: 'medlem@example.test',
        reason: 'Glemt passord',
      })
      const fresh = 'et-nytt-og-langt-passord'
      await browser(auth).call('/invitation/reset-password', { body: { token, password: fresh } })
      const b = browser(auth)
      const result = await b.call('/sign-in/email', {
        body: { email: 'medlem@example.test', password: fresh },
      })
      expect(result.body).toMatchObject({ twoFactorRedirect: true })
      expect(await b.session()).toBeNull()
    })

    it('en invitasjonslenke kan ikke brukes til å sette passord', async () => {
      await member('medlem@example.test')
      const token = await invite('annen@example.test')
      const result = await browser(auth).call('/invitation/reset-password', {
        body: { token, password: 'et-nytt-og-langt-passord' },
      })
      expect(result.status).toBe(400)
      expect(result.body.code).toBe('INVITATION_NOT_FOUND')
    })
  })
})
