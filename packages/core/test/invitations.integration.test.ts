import { createHash, randomUUID } from 'node:crypto'
import { createDb, loadRootEnv, runMigrations, schema, type Db, type MemberRole } from '@esaf/db'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  acceptInvitation,
  acceptInvitationAsUser,
  accessLevel,
  AccessDeniedError,
  changeRole,
  createInvitation,
  createInvitationAsOperator,
  createPasswordResetLink,
  createPasswordResetLinkAsOperator,
  decideMembership,
  describeInvitation,
  describeInviteTarget,
  DomainError,
  grantRoleAsOperator,
  InvitationError,
  listInvitations,
  loadViewer,
  requestPasswordReset,
  resetPasswordWithLink,
  revokeInvitation,
  setMemberAccess,
  submitAccessRequest,
  type Viewer,
} from '../src/index.ts'

loadRootEnv()
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

const { invitation, auditEvent, membership, person, personCohort, cohort, personEmail, user } =
  schema

describe.skipIf(!url)('invitasjoner og lenker for nytt passord', () => {
  let db: Db
  let owner: Viewer
  let admin: Viewer
  let moderator: Viewer
  let member: Viewer
  const ids: Record<string, string> = {}

  beforeAll(async () => {
    await runMigrations(url!)
    db = createDb(url!)
  })
  afterAll(() => db?.close())

  async function account(name: string, options: { verified?: boolean; twoFactor?: boolean } = {}) {
    const id = randomUUID()
    await db.insert(user).values({
      id,
      name,
      email: `${name.toLowerCase()}@example.test`,
      emailVerified: options.verified ?? true,
      twoFactorEnabled: options.twoFactor ?? true,
    })
    ids[name] = id
    return id
  }

  async function withRole(name: string, role: MemberRole) {
    const id = await account(name)
    const v = await loadViewer(db, id)
    await decideMembership(db, owner, { personId: v!.personId!, decision: 'approve' })
    if (role !== 'member') await changeRole(db, owner, { personId: v!.personId!, role })
    return loadViewer(db, id)
  }

  /** En profil fra kullisten, uten konto, i ES 2019. */
  async function profile(fullName: string, email?: string) {
    const [p] = await db
      .insert(person)
      .values({ fullName, source: 'import' })
      .returning({ id: person.id })
    await db.insert(membership).values({ personId: p!.id, status: 'active' })
    await db.insert(cohort).values({ graduationYear: 2019 }).onConflictDoNothing()
    const [c] = await db.select().from(cohort).where(eq(cohort.graduationYear, 2019))
    await db.insert(personCohort).values({ personId: p!.id, cohortId: c!.id })
    if (email) await db.insert(personEmail).values({ email, personId: p!.id, source: 'import' })
    return p!.id
  }

  beforeEach(async () => {
    await db.execute(
      sql`truncate ${invitation}, ${schema.notification}, ${schema.accessRequest}, ${auditEvent}, ${membership}, ${personCohort}, ${personEmail}, ${person}, ${cohort}, ${schema.session}, ${schema.account}, ${user} cascade`,
    )
    await account('Eier')
    await grantRoleAsOperator(db, { email: 'eier@example.test', reason: 'test' })
    owner = await loadViewer(db, ids.Eier!)
    admin = await withRole('Admin', 'admin')
    moderator = await withRole('Moderator', 'moderator')
    member = await withRole('Medlem', 'member')
  })

  async function outcome(promise: Promise<unknown>) {
    try {
      await promise
      return 'allowed'
    } catch (error) {
      if (error instanceof InvitationError) return error.code
      if (error instanceof AccessDeniedError) return error.reason
      if (error instanceof DomainError) return error.message
      throw error
    }
  }

  const audit = (action: string) =>
    db.select().from(auditEvent).where(eq(auditEvent.action, action))

  describe('tokenet', () => {
    it('lagres bare som SHA-256, aldri i klartekst, og har 256 bit', async () => {
      const link = await createInvitation(db, admin, { email: 'Ny@Example.test' })
      expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(Buffer.from(link.token, 'base64url')).toHaveLength(32)
      expect(link.email).toBe('ny@example.test')
      // Til e-posten: hvem som inviterte.
      expect(link.createdByName).toBe('Admin')
      const rows = await db.select().from(invitation)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.tokenHash).toBe(createHash('sha256').update(link.token).digest('hex'))
      const everything = JSON.stringify(await db.execute(sql`select * from ${invitation}`)).concat(
        JSON.stringify(await db.select().from(auditEvent)),
      )
      expect(everything).not.toContain(link.token)
    })

    it('ukjente, misdannede og feil slags lenker gir bare «ugyldig»', async () => {
      const link = await createInvitation(db, admin, { email: 'ny@example.test' })
      expect(await describeInvitation(db, 'x'.repeat(43), 'invite')).toEqual({ status: 'invalid' })
      expect(await describeInvitation(db, "' or 1=1 --", 'invite')).toEqual({ status: 'invalid' })
      expect(await describeInvitation(db, link.token, 'password_reset')).toEqual({
        status: 'invalid',
      })
      expect(
        await outcome(resetPasswordWithLink(db, { token: link.token, passwordHash: 'x' })),
      ).toBe('not_found')
      const details = await describeInvitation(db, link.token, 'invite')
      expect(details).toMatchObject({
        status: 'pending',
        email: 'ny@example.test',
        role: 'member',
        invitedBy: 'Admin',
        account: 'none',
      })
    })

    it('virker bare én gang', async () => {
      const { token } = await createInvitation(db, admin, { email: 'ny@example.test' })
      const first = await acceptInvitation(db, {
        token,
        passwordHash: 'hash',
        fullName: 'Ny Person',
      })
      expect(accessLevel(await loadViewer(db, first.userId))).toBe('member')
      expect(
        await outcome(acceptInvitation(db, { token, passwordHash: 'hash', fullName: 'Ny Person' })),
      ).toBe('used')
      expect(await describeInvitation(db, token, 'invite')).toEqual({ status: 'used' })
    })

    it('går ut etter sju dager', async () => {
      const link = await createInvitation(db, admin, { email: 'ny@example.test' })
      const days = (link.expiresAt.getTime() - Date.now()) / 86_400_000
      expect(days).toBeGreaterThan(6.99)
      expect(days).toBeLessThanOrEqual(7)
      await db.update(invitation).set({ expiresAt: new Date(Date.now() - 1000) })
      expect(await describeInvitation(db, link.token, 'invite')).toEqual({ status: 'expired' })
      expect(
        await outcome(
          acceptInvitation(db, { token: link.token, passwordHash: 'h', fullName: 'Ny' }),
        ),
      ).toBe('expired')
      expect(await db.select().from(user).where(eq(user.email, 'ny@example.test'))).toEqual([])
    })

    it('kan trekkes tilbake, og en ny lenke til samme adresse erstatter den forrige', async () => {
      const first = await createInvitation(db, admin, { email: 'ny@example.test' })
      const second = await createInvitation(db, admin, { email: 'ny@example.test' })
      expect(await describeInvitation(db, first.token, 'invite')).toEqual({ status: 'revoked' })
      expect((await audit('invitation.create'))[1]!.details).toMatchObject({ replaced: 1 })

      expect(await outcome(revokeInvitation(db, member, { id: second.id }))).toBe('forbidden')
      await revokeInvitation(db, admin, { id: second.id })
      expect(
        await outcome(
          acceptInvitation(db, { token: second.token, passwordHash: 'h', fullName: 'Ny' }),
        ),
      ).toBe('revoked')
      expect(await outcome(revokeInvitation(db, admin, { id: second.id }))).toBe(
        'Lenken er ikke aktiv lenger.',
      )
      const [revoked] = await audit('invitation.revoke')
      expect(revoked).toMatchObject({ actorPersonId: admin!.personId })
    })

    it('er bundet til adressen: en annen konto kan ikke ta den imot', async () => {
      const { token } = await createInvitation(db, admin, { email: 'ny@example.test' })
      expect(await outcome(acceptInvitationAsUser(db, member, token))).toBe('wrong_email')
      expect(await describeInvitation(db, token, 'invite')).toMatchObject({ status: 'pending' })
    })
  })

  describe('roller', () => {
    it('admins inviterer medlemmer, bare hovedadmins inviterer med en rolle', async () => {
      expect(await outcome(createInvitation(db, admin, { email: 'a@example.test' }))).toBe(
        'allowed',
      )
      for (const role of ['moderator', 'admin', 'owner'] as const) {
        expect(await outcome(createInvitation(db, admin, { email: 'b@example.test', role }))).toBe(
          'Bare en hovedadmin kan invitere med en rolle.',
        )
        expect(
          await outcome(createInvitation(db, owner, { email: `ny-${role}@example.test`, role })),
        ).toBe('allowed')
      }
      expect(await outcome(createInvitation(db, moderator, { email: 'c@example.test' }))).toBe(
        'forbidden',
      )
      expect(await outcome(createInvitation(db, member, { email: 'c@example.test' }))).toBe(
        'forbidden',
      )
      expect(await outcome(createInvitation(db, null, { email: 'c@example.test' }))).toBe(
        'unauthenticated',
      )
      const weak = await loadViewer(db, ids.Admin!)
      await db.update(user).set({ twoFactorEnabled: false }).where(eq(user.id, ids.Admin!))
      expect(
        await outcome(
          createInvitation(db, { ...weak!, twoFactorEnabled: false }, { email: 'c@example.test' }),
        ),
      ).toBe('strong_auth_required')
    })

    it('den inviterte får rollen fra invitasjonen', async () => {
      const { token } = await createInvitation(db, owner, {
        email: 'ny@example.test',
        role: 'admin',
      })
      const { personId } = await acceptInvitation(db, {
        token,
        passwordHash: 'h',
        fullName: 'Ny Admin',
      })
      const [m] = await db.select().from(membership).where(eq(membership.personId, personId))
      expect(m).toMatchObject({
        status: 'active',
        role: 'admin',
        decidedByPersonId: owner!.personId,
      })
    })

    it('aktive medlemmer inviteres ikke; rollen endres under Medlemmer', async () => {
      expect(await outcome(createInvitation(db, owner, { email: 'medlem@example.test' }))).toMatch(
        /aktivt medlem/,
      )
    })
  })

  describe('profiler', () => {
    it('kobler kontoen til profilen, med kull og uten en ekstra person', async () => {
      const profileId = await profile('Kari Nordmann', 'kari@example.test')
      const before = (await db.select().from(person)).length
      const { token } = await createInvitation(db, admin, {
        email: 'kari@example.test',
        personId: profileId,
      })
      expect(await describeInvitation(db, token, 'invite')).toMatchObject({
        profile: { fullName: 'Kari Nordmann', years: [2019] },
      })
      // Navnet fra kullisten beholdes, uansett hva som sendes inn.
      const result = await acceptInvitation(db, { token, passwordHash: 'h', fullName: 'Noe annet' })
      expect(result.personId).toBe(profileId)
      expect((await db.select().from(person)).length).toBe(before)
      const [p] = await db.select().from(person).where(eq(person.id, profileId))
      expect(p).toMatchObject({ userId: result.userId, fullName: 'Kari Nordmann' })
      expect(p!.claimedAt).not.toBeNull()
      const [u] = await db.select().from(user).where(eq(user.id, result.userId))
      expect(u).toMatchObject({ emailVerified: true, name: 'Kari Nordmann' })
      const viewer = await loadViewer(db, result.userId)
      expect(viewer).toMatchObject({ personId: profileId, membership: { status: 'active' } })
      const [used] = await audit('invitation.use')
      expect(used).toMatchObject({ actorPersonId: profileId, subjectPersonId: profileId })
      expect(used!.details).toMatchObject({
        profileLinked: true,
        account: 'new',
        method: 'password',
      })
      // Velkomstvarselet, som ved godkjenning.
      expect(await db.select().from(schema.notification)).not.toHaveLength(0)
    })

    it('foreslår profiler med samme adresse, og sier fra om kontoer', async () => {
      const profileId = await profile('Kari Nordmann', 'kari@example.test')
      expect(await describeInviteTarget(db, admin, ' KARI@example.test ')).toEqual({
        profiles: [{ personId: profileId, fullName: 'Kari Nordmann', years: [2019] }],
        account: null,
      })
      expect((await describeInviteTarget(db, admin, 'medlem@example.test')).account).toMatchObject({
        verified: true,
        status: 'active',
      })
      expect(await outcome(describeInviteTarget(db, member, 'kari@example.test'))).toBe('forbidden')
    })

    it('profiler som er tatt i bruk, kan ikke inviteres til', async () => {
      expect(
        await outcome(
          createInvitation(db, admin, { email: 'x@example.test', personId: member!.personId }),
        ),
      ).toBe('Profilen er allerede tatt i bruk av en konto.')
    })

    it('blir profilen tatt i bruk etter at invitasjonen ble laget, avvises den', async () => {
      const profileId = await profile('Kari Nordmann')
      const first = await createInvitation(db, admin, {
        email: 'a@example.test',
        personId: profileId,
      })
      const second = await createInvitation(db, admin, {
        email: 'b@example.test',
        personId: profileId,
      })
      await acceptInvitation(db, { token: first.token, passwordHash: 'h' })
      expect(await outcome(acceptInvitation(db, { token: second.token, passwordHash: 'h' }))).toBe(
        'profile_claimed',
      )
      // Ingenting er skrevet, og lenken kan fortsatt trekkes tilbake.
      expect(await db.select().from(user).where(eq(user.email, 'b@example.test'))).toEqual([])
      expect(await describeInvitation(db, second.token, 'invite')).toMatchObject({
        status: 'pending',
      })
    })

    it('uten profil må personen skrive inn navnet, og blir en ny person', async () => {
      const { token } = await createInvitation(db, admin, { email: 'ny@example.test' })
      expect(await outcome(acceptInvitation(db, { token, passwordHash: 'h', fullName: ' ' }))).toBe(
        'name_required',
      )
      const { personId } = await acceptInvitation(db, {
        token,
        passwordHash: 'h',
        fullName: ' Ola Nordmann ',
      })
      const [p] = await db.select().from(person).where(eq(person.id, personId))
      expect(p).toMatchObject({ fullName: 'Ola Nordmann', source: 'signup' })
      expect(
        await db.select().from(personEmail).where(eq(personEmail.email, 'ny@example.test')),
      ).toMatchObject([{ personId }])
    })

    it('uten passord (passkey) lages kontoen uten passord', async () => {
      const { token } = await createInvitation(db, admin, { email: 'ny@example.test' })
      const { userId } = await acceptInvitation(db, { token, passwordHash: null, fullName: 'Ny' })
      expect(
        await db.select().from(schema.account).where(eq(schema.account.userId, userId)),
      ).toEqual([])
      expect((await audit('invitation.use'))[0]!.details).toMatchObject({ method: 'passkey' })
    })
  })

  describe('eksisterende kontoer', () => {
    it('en bekreftet konto må logge inn; da blir den aktivt medlem og forespørselen godkjent', async () => {
      const id = await account('Soker')
      const profileId = await profile('Søker Fra Lista', 'soker@example.test')
      const pending = await loadViewer(db, id)
      await submitAccessRequest(db, pending, {
        profilePersonId: profileId,
        fullName: 'Søker Fra Lista',
        graduationYear: 2019,
        linkedinUrl: '',
        note: '',
      })
      const { token } = await createInvitation(db, admin, { email: 'soker@example.test' })
      expect(await describeInvitation(db, token, 'invite')).toMatchObject({ account: 'verified' })
      expect(await outcome(acceptInvitation(db, { token, passwordHash: 'h' }))).toBe(
        'account_exists',
      )
      expect(await outcome(acceptInvitationAsUser(db, null, token))).toBe('unauthenticated')

      const { personId } = await acceptInvitationAsUser(db, pending, token)
      // Profilen personen selv valgte (med samme adresse) brukes, siden admin ikke valgte en.
      expect(personId).toBe(profileId)
      const viewer = await loadViewer(db, id)
      expect(accessLevel(viewer)).toBe('member')
      expect(viewer!.personId).toBe(profileId)
      const [request] = await db.select().from(schema.accessRequest)
      expect(request).toMatchObject({ status: 'approved', profilePersonId: profileId })
      expect((await audit('invitation.use'))[0]!.details).toMatchObject({
        account: 'existing',
        previousStatus: 'pending',
        profileLinked: true,
      })
      expect(await outcome(acceptInvitationAsUser(db, viewer, token))).toBe('used')
    })

    it('en deaktivert konto får tilgang igjen, men ikke en annen profil', async () => {
      const id = await account('Borte')
      const v = await loadViewer(db, id)
      await decideMembership(db, owner, { personId: v!.personId!, decision: 'reject' })
      const other = await profile('Noen Andre')
      const withProfile = await createInvitation(db, admin, {
        email: 'borte@example.test',
        personId: other,
      })
      expect(await outcome(acceptInvitationAsUser(db, v, withProfile.token))).toBe('already_linked')
      const plain = await createInvitation(db, admin, { email: 'borte@example.test' })
      await acceptInvitationAsUser(db, v, plain.token)
      expect(accessLevel(await loadViewer(db, id))).toBe('member')
    })

    it('en høyere rolle tas aldri fra den som allerede har den', async () => {
      // Medlemmet deaktiveres ikke; en invitasjon med lavere rolle lages av operatøren direkte.
      const [row] = await db
        .insert(invitation)
        .values({
          email: 'admin@example.test',
          tokenHash: createHash('sha256').update('A'.repeat(43)).digest('hex'),
          role: 'member',
          expiresAt: new Date(Date.now() + 60_000),
        })
        .returning()
      expect(row).toBeDefined()
      await acceptInvitationAsUser(db, admin, 'A'.repeat(43))
      const [m] = await db
        .select()
        .from(membership)
        .where(eq(membership.personId, admin!.personId!))
      expect(m!.role).toBe('admin')
    })

    it('en konto som aldri ble bekreftet, overtas av den som har lenken', async () => {
      const id = await account('Ubekreftet', { verified: false, twoFactor: false })
      await db.insert(schema.account).values({
        id: randomUUID(),
        accountId: id,
        providerId: 'credential',
        userId: id,
        password: 'gammel-hash',
      })
      await db.insert(schema.session).values({
        id: randomUUID(),
        token: randomUUID(),
        userId: id,
        expiresAt: new Date(Date.now() + 60_000),
      })
      const { token } = await createInvitation(db, admin, { email: 'ubekreftet@example.test' })
      expect(await describeInvitation(db, token, 'invite')).toMatchObject({ account: 'unverified' })
      const result = await acceptInvitation(db, {
        token,
        passwordHash: 'ny-hash',
        fullName: 'Ubekreftet',
      })
      expect(result.userId).toBe(id)
      expect(await db.select().from(schema.session).where(eq(schema.session.userId, id))).toEqual(
        [],
      )
      const accounts = await db.select().from(schema.account).where(eq(schema.account.userId, id))
      expect(accounts.map((a) => a.password)).toEqual(['ny-hash'])
      expect(accessLevel(await loadViewer(db, id))).toBe('member')
    })
  })

  describe('lenke for nytt passord', () => {
    async function sessionFor(userId: string) {
      await db.insert(schema.session).values({
        id: randomUUID(),
        token: randomUUID(),
        userId,
        expiresAt: new Date(Date.now() + 60_000),
      })
    }

    it('følger reglene for deaktivering', async () => {
      const other = await withRole('Annen', 'owner')
      const reason = 'Glemt passord'
      const p = (v: Viewer) => v!.personId!
      expect(
        await outcome(createPasswordResetLink(db, admin, { personId: p(member), reason })),
      ).toBe('allowed')
      expect(
        await outcome(createPasswordResetLink(db, admin, { personId: p(moderator), reason })),
      ).toBe('allowed')
      expect(
        await outcome(createPasswordResetLink(db, admin, { personId: p(owner), reason })),
      ).toBe('Bare en hovedadmin kan lage en slik lenke for en admin.')
      expect(
        await outcome(createPasswordResetLink(db, owner, { personId: p(admin), reason })),
      ).toBe('allowed')
      expect(
        await outcome(createPasswordResetLink(db, owner, { personId: p(other), reason })),
      ).toBe('allowed')
      expect(
        await outcome(createPasswordResetLink(db, owner, { personId: p(owner), reason })),
      ).toMatch(/deg selv/)
      expect(
        await outcome(createPasswordResetLink(db, moderator, { personId: p(member), reason })),
      ).toBe('forbidden')
      expect(
        await outcome(createPasswordResetLink(db, admin, { personId: p(member), reason: ' ' })),
      ).toMatch(/begrunnelse/)
      const profileId = await profile('Uten Konto')
      expect(
        await outcome(createPasswordResetLink(db, admin, { personId: profileId, reason })),
      ).toBe('Personen har ingen konto.')
    })

    it('setter passordet, logger ut alle økter og virker én gang', async () => {
      await db.insert(schema.account).values({
        id: randomUUID(),
        accountId: ids.Medlem!,
        providerId: 'credential',
        userId: ids.Medlem!,
        password: 'gammel-hash',
      })
      await sessionFor(ids.Medlem!)
      await sessionFor(ids.Admin!)
      const link = await createPasswordResetLink(db, admin, {
        personId: member!.personId!,
        reason: 'Glemt passord',
      })
      expect(link.kind).toBe('password_reset')
      expect(await describeInvitation(db, link.token, 'invite')).toEqual({ status: 'invalid' })
      expect(await outcome(acceptInvitation(db, { token: link.token, passwordHash: 'h' }))).toBe(
        'not_found',
      )
      expect(await describeInvitation(db, link.token, 'password_reset')).toMatchObject({
        status: 'pending',
        email: 'medlem@example.test',
      })

      await resetPasswordWithLink(db, { token: link.token, passwordHash: 'ny-hash' })
      const sessions = await db.select().from(schema.session)
      expect(sessions.map((s) => s.userId)).toEqual([ids.Admin])
      const [credential] = await db
        .select()
        .from(schema.account)
        .where(eq(schema.account.userId, ids.Medlem!))
      expect(credential!.password).toBe('ny-hash')
      // Tofaktor røres ikke.
      const [u] = await db.select().from(user).where(eq(user.id, ids.Medlem!))
      expect(u!.twoFactorEnabled).toBe(true)
      expect(
        await outcome(resetPasswordWithLink(db, { token: link.token, passwordHash: 'x' })),
      ).toBe('used')
      expect((await audit('password_link.create'))[0]).toMatchObject({
        actorPersonId: admin!.personId,
        subjectPersonId: member!.personId,
        details: { reason: 'Glemt passord' },
      })
      expect((await audit('password_link.use'))[0]).toMatchObject({
        subjectPersonId: member!.personId,
      })
    })

    it('kontoer uten passord (bare passkey) får et', async () => {
      const link = await createPasswordResetLink(db, admin, {
        personId: member!.personId!,
        reason: 'Mistet passkeyen',
      })
      await resetPasswordWithLink(db, { token: link.token, passwordHash: 'ny-hash' })
      const accounts = await db
        .select()
        .from(schema.account)
        .where(
          and(eq(schema.account.userId, ids.Medlem!), eq(schema.account.providerId, 'credential')),
        )
      expect(accounts.map((a) => a.password)).toEqual(['ny-hash'])
    })
  })

  describe('«Glemt passord?»', () => {
    const minutes = (n: number) => n * 60 * 1000

    it('en ukjent eller ugyldig adresse gir ingen lenke, og ingenting lagres', async () => {
      expect(await requestPasswordReset(db, { email: 'ingen@example.test' })).toBeNull()
      expect(await requestPasswordReset(db, { email: 'ikke en adresse' })).toBeNull()
      expect(await requestPasswordReset(db, { email: '' })).toBeNull()
      expect(await db.select().from(invitation)).toEqual([])
      expect(await audit('password_link.request')).toEqual([])
    })

    it('en kjent adresse får en lenke som virker i en time, og det logges', async () => {
      const before = Date.now()
      const link = await requestPasswordReset(db, { email: '  MEDLEM@example.test ' })
      expect(link).toMatchObject({
        kind: 'password_reset',
        email: 'medlem@example.test',
        requestedBySelf: true,
        createdByName: 'Medlem',
      })
      const ttl = link!.expiresAt.getTime() - before
      expect(ttl).toBeGreaterThan(minutes(59))
      expect(ttl).toBeLessThanOrEqual(minutes(60) + 5000)

      const [row] = await db.select().from(invitation)
      expect(row).toMatchObject({
        kind: 'password_reset',
        personId: member!.personId,
        // Personen selv, ikke operatøren, står som den som laget lenken.
        createdByPersonId: member!.personId,
        requestedBySelf: true,
      })
      expect(await audit('password_link.request')).toMatchObject([
        { actorPersonId: member!.personId, subjectPersonId: member!.personId },
      ])
      expect(await audit('password_link.create')).toEqual([])

      const [view] = await listInvitations(db, admin)
      expect(view).toMatchObject({
        requestedBySelf: true,
        createdBy: { fullName: 'Medlem' },
        status: 'pending',
      })
    })

    it('lenken setter nytt passord og logger ut alle økter, uten å logge inn', async () => {
      await db.insert(schema.session).values({
        id: randomUUID(),
        token: randomUUID(),
        userId: ids.Medlem!,
        expiresAt: new Date(Date.now() + 60_000),
      })
      const link = await requestPasswordReset(db, { email: 'medlem@example.test' })
      expect(await describeInvitation(db, link!.token, 'password_reset')).toMatchObject({
        status: 'pending',
        email: 'medlem@example.test',
      })
      expect(await describeInvitation(db, link!.token, 'invite')).toEqual({ status: 'invalid' })
      const { userId } = await resetPasswordWithLink(db, {
        token: link!.token,
        passwordHash: 'ny-hash',
      })
      expect(userId).toBe(ids.Medlem)
      expect(await db.select().from(schema.session)).toEqual([])
      const [credential] = await db
        .select()
        .from(schema.account)
        .where(eq(schema.account.userId, ids.Medlem!))
      expect(credential!.password).toBe('ny-hash')
      expect(
        await outcome(resetPasswordWithLink(db, { token: link!.token, passwordHash: 'x' })),
      ).toBe('used')
    })

    it('én forespørsel per adresse hvert andre minutt', async () => {
      const first = await requestPasswordReset(db, { email: 'medlem@example.test' })
      expect(first).not.toBeNull()
      expect(await requestPasswordReset(db, { email: 'medlem@example.test' })).toBeNull()
      // Grensen gjelder adressen, ikke alle.
      expect(await requestPasswordReset(db, { email: 'admin@example.test' })).not.toBeNull()
      expect(await db.select().from(invitation)).toHaveLength(2)

      // En lenke fra en admin teller ikke med.
      await db
        .update(invitation)
        .set({ createdAt: new Date(Date.now() - minutes(3)) })
        .where(eq(invitation.id, first!.id))
      await createPasswordResetLink(db, admin, {
        personId: member!.personId!,
        reason: 'Glemt passord',
      })
      const second = await requestPasswordReset(db, { email: 'medlem@example.test' })
      expect(second).not.toBeNull()
      expect(await audit('password_link.request')).toHaveLength(3)
    })

    it('erstatter en ventende lenke til samme adresse, også fra en admin', async () => {
      const fromAdmin = await createPasswordResetLink(db, admin, {
        personId: member!.personId!,
        reason: 'Glemt passord',
      })
      const own = await requestPasswordReset(db, { email: 'medlem@example.test' })
      expect(await describeInvitation(db, fromAdmin.token, 'password_reset')).toEqual({
        status: 'revoked',
      })
      expect(await describeInvitation(db, own!.token, 'password_reset')).toMatchObject({
        status: 'pending',
      })
      expect((await audit('password_link.request'))[0]!.details).toMatchObject({ replaced: 1 })
    })

    it('deaktiverte og avslåtte kontoer får ingen lenke', async () => {
      await setMemberAccess(db, admin, {
        personId: member!.personId!,
        active: false,
        reason: 'Sluttet',
      })
      expect(await requestPasswordReset(db, { email: 'medlem@example.test' })).toBeNull()
      expect(await db.select().from(invitation)).toEqual([])
    })

    it('en konto uten person (aldri bekreftet) får en lenke uten person, og blir bekreftet når den brukes', async () => {
      await account('Ubekreftet', { verified: false, twoFactor: false })
      const link = await requestPasswordReset(db, { email: 'ubekreftet@example.test' })
      expect(link).toMatchObject({ requestedBySelf: true, createdByName: null })
      const [row] = await db.select().from(invitation)
      expect(row).toMatchObject({ personId: null, createdByPersonId: null, requestedBySelf: true })
      expect(await audit('password_link.request')).toMatchObject([
        {
          actorPersonId: null,
          subjectPersonId: null,
          details: { email: 'ubekreftet@example.test' },
        },
      ])
      // Oversikten viser den ikke som laget av operatøren.
      const [view] = await listInvitations(db, admin)
      expect(view).toMatchObject({ requestedBySelf: true, createdBy: null })

      await resetPasswordWithLink(db, { token: link!.token, passwordHash: 'ny-hash' })
      const [u] = await db.select().from(user).where(eq(user.id, ids.Ubekreftet!))
      expect(u!.emailVerified).toBe(true)
    })

    it('lenker fra en admin er ikke bedt om selv, og står med admin som den som laget dem', async () => {
      const link = await createPasswordResetLink(db, admin, {
        personId: member!.personId!,
        reason: 'Glemt passord',
      })
      expect(link).toMatchObject({ requestedBySelf: false, createdByName: 'Admin' })
      const ttl = link.expiresAt.getTime() - Date.now()
      expect(ttl).toBeGreaterThan(6 * 24 * 60 * minutes(1))
    })
  })

  describe('operatøren', () => {
    it('kan invitere den første hovedadmin, og det logges uten utfører', async () => {
      const link = await createInvitationAsOperator(db, {
        email: 'Leder@Example.test',
        role: 'owner',
        reason: 'Styreleder 2026',
      })
      const [row] = await db.select().from(invitation)
      expect(row).toMatchObject({
        createdByPersonId: null,
        role: 'owner',
        email: 'leder@example.test',
      })
      expect((await audit('invitation.create'))[0]).toMatchObject({
        actorPersonId: null,
        details: { role: 'owner', reason: 'Styreleder 2026' },
      })
      expect(await describeInvitation(db, link.token, 'invite')).toMatchObject({ invitedBy: null })
      // E-posten sier da «Styret i ESAF».
      expect(link).toMatchObject({ createdByName: null, requestedBySelf: false })
      const { userId } = await acceptInvitation(db, {
        token: link.token,
        passwordHash: 'h',
        fullName: 'Leder',
      })
      expect((await loadViewer(db, userId))!.membership).toEqual({
        status: 'active',
        role: 'owner',
      })
    })

    it('kan lage en lenke for nytt passord', async () => {
      const link = await createPasswordResetLinkAsOperator(db, {
        email: 'EIER@example.test',
        reason: 'Glemt passord',
      })
      expect(link).toMatchObject({ fullName: 'Eier', kind: 'password_reset' })
      expect((await audit('password_link.create'))[0]).toMatchObject({ actorPersonId: null })
      expect(
        await outcome(
          createPasswordResetLinkAsOperator(db, { email: 'ingen@example.test', reason: 'x y z' }),
        ),
      ).toMatch(/Fant ingen konto/)
    })
  })

  it('oversikten viser status, og krever members.review', async () => {
    const used = await createInvitation(db, admin, { email: 'brukt@example.test' })
    await acceptInvitation(db, { token: used.token, passwordHash: 'h', fullName: 'Brukt Person' })
    await createInvitation(db, admin, { email: 'venter@example.test' })
    const revoked = await createInvitation(db, admin, { email: 'trukket@example.test' })
    await revokeInvitation(db, admin, { id: revoked.id })
    const expired = await createInvitation(db, admin, { email: 'gammel@example.test' })
    await db
      .update(invitation)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invitation.id, expired.id))

    const list = await listInvitations(db, admin)
    const status = Object.fromEntries(list.map((i) => [i.email, i.status]))
    expect(status).toEqual({
      'brukt@example.test': 'used',
      'venter@example.test': 'pending',
      'trukket@example.test': 'revoked',
      'gammel@example.test': 'expired',
    })
    expect(list.find((i) => i.status === 'used')).toMatchObject({
      usedBy: { fullName: 'Brukt Person' },
      createdBy: { fullName: 'Admin' },
    })
    expect(await outcome(listInvitations(db, moderator))).toBe('forbidden')
  })
})
