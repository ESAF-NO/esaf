import { randomUUID } from 'node:crypto'
import { createDb, loadRootEnv, runMigrations, schema, type Db } from '@esaf/db'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccessDeniedError,
  DomainError,
  applyProfileImport,
  decideAccessRequest,
  decideMembership,
  getAccessState,
  grantRoleAsOperator,
  linkAccountToProfile,
  listAccessRequests,
  listActiveMembers,
  loadViewer,
  parseProfileSheet,
  planProfileImport,
  searchUnclaimedProfiles,
  submitAccessRequest,
  type AccessRequestInput,
} from '../src/index.ts'

loadRootEnv()
const url = process.env.TEST_DATABASE_URL

// Lokalt hoppes testene over uten testdatabase. I CI skal de alltid kjøre.
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

describe.skipIf(!url)('tilgangsgrensen mot Postgres', () => {
  let db: Db

  beforeAll(async () => {
    await runMigrations(url!)
    db = createDb(url!)
  })
  afterAll(() => db?.close())
  beforeEach(async () => {
    await db.execute(
      sql`truncate ${schema.accessRequest}, ${schema.auditEvent}, ${schema.membership}, ${schema.personCohort}, ${schema.person}, ${schema.cohort}, ${schema.user} cascade`,
    )
  })

  const request = (overrides: Partial<AccessRequestInput> = {}): AccessRequestInput => ({
    profilePersonId: null,
    fullName: 'Ny Person',
    graduationYear: null,
    linkedinUrl: '',
    note: '',
    ...overrides,
  })

  async function createAccount(name: string, emailVerified = true) {
    const id = randomUUID()
    await db.insert(schema.user).values({
      id,
      name,
      email: `${name.toLowerCase()}@example.test`,
      emailVerified,
    })
    return id
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

  async function personByEmail(email: string) {
    const [row] = await db
      .select({ id: schema.person.id, userId: schema.person.userId })
      .from(schema.personEmail)
      .innerJoin(schema.person, eq(schema.person.id, schema.personEmail.personId))
      .where(eq(schema.personEmail.email, email))
    return row
  }

  async function setupAdmin() {
    const id = await createAccount('Admin')
    await grantRoleAsOperator(db, { email: 'admin@example.test', reason: 'test', role: 'admin' })
    await db.update(schema.user).set({ twoFactorEnabled: true }).where(eq(schema.user.id, id))
    return loadViewer(db, id)
  }

  it('uinnlogget og ubekreftet konto får ikke medlemsdata', async () => {
    expect(await denial(listActiveMembers(db, null))).toBe('unauthenticated')

    const unverified = await loadViewer(db, await createAccount('Uverifisert', false))
    expect(unverified?.personId).toBeNull()
    expect(await denial(listActiveMembers(db, unverified))).toBe('not_member')
  })

  it('ny bekreftet konto blir ventende, ikke medlem', async () => {
    const viewer = await loadViewer(db, await createAccount('Ny'))
    expect(viewer?.membership).toEqual({ status: 'pending', role: 'member' })
    expect(await denial(listActiveMembers(db, viewer))).toBe('not_member')
  })

  it('adminhandlinger krever adminrolle', async () => {
    const admin = await setupAdmin()
    const pending = await loadViewer(db, await createAccount('Ventende'))
    const memberId = await createAccount('Medlem')
    let member = await loadViewer(db, memberId)
    await decideMembership(db, admin, { personId: member!.personId!, decision: 'approve' })
    member = await loadViewer(db, memberId)
    expect(member?.membership?.status).toBe('active')

    const approvePending = (viewer: typeof admin) =>
      decideMembership(db, viewer, { personId: pending!.personId!, decision: 'approve' })
    expect(await denial(approvePending(null))).toBe('unauthenticated')
    expect(await denial(approvePending(pending))).toBe('not_member')
    expect(await denial(approvePending(member))).toBe('forbidden')
    expect(await denial(listAccessRequests(db, member))).toBe('forbidden')
    expect(await denial(listAccessRequests(db, pending))).toBe('not_member')
    await approvePending(admin)
    expect((await listActiveMembers(db, member)).map((m) => m.fullName).sort()).toEqual([
      'Admin',
      'Medlem',
      'Ventende',
    ])

    const audit = await db.select().from(schema.auditEvent)
    expect(audit.map((e) => e.action).sort()).toEqual([
      'membership.approve',
      'membership.approve',
      'operator.grant_role',
    ])
  })

  it('godkjenning gir aldri adminrolle, og admin kan ikke behandle seg selv', async () => {
    const admin = await setupAdmin()
    const id = await createAccount('Kandidat')
    const candidate = await loadViewer(db, id)
    await decideMembership(db, admin, { personId: candidate!.personId!, decision: 'approve' })
    expect((await loadViewer(db, id))?.membership).toEqual({ status: 'active', role: 'member' })

    await expect(
      decideMembership(db, admin, { personId: admin!.personId!, decision: 'reject' }),
    ).rejects.toBeInstanceOf(DomainError)
  })

  it('operatør kan ikke gi admin til konto med ubekreftet e-post', async () => {
    await createAccount('Angriper', false)
    await expect(
      grantRoleAsOperator(db, { email: 'angriper@example.test', reason: 'test' }),
    ).rejects.toThrow('bekreftet')
  })

  async function importSheet(csv: string, membershipStatus: 'active' | 'pending' = 'active') {
    const sheet = parseProfileSheet(csv, { yearKind: 'graduation' })
    const plan = await planProfileImport(db, sheet.rows)
    return {
      plan,
      result: await applyProfileImport(db, plan, { membershipStatus, sourceLabel: 'test.csv' }),
    }
  }

  const sheet = [
    'navn,epost,kull',
    'Fra Kulliste,kulliste@example.test,2015',
    'Uten Epost,,2015',
    'Annen Kull,annen@example.test,2016',
  ].join('\n')

  it('import lager profiler uten konto, og er idempotent', async () => {
    const first = await importSheet(sheet)
    expect(first.result).toEqual({ created: 3, existing: 0, cohortsCreated: 2 })

    const profiles = await db.select().from(schema.person)
    expect(profiles.every((p) => p.userId === null && p.source === 'import')).toBe(true)

    const again = await importSheet(sheet)
    expect(again.result).toEqual({ created: 0, existing: 3, cohortsCreated: 0 })
    expect(again.plan.map((r) => r.action === 'existing' && r.matchedBy)).toEqual([
      'email',
      'name',
      'email',
    ])
    expect(await db.select().from(schema.person)).toHaveLength(3)
  })

  it('katalogen viser både verifiserte brukere og profiler, med status', async () => {
    await importSheet(sheet)
    const admin = await setupAdmin()
    const members = await listActiveMembers(db, admin)
    expect(members.map((m) => [m.fullName, m.claimed])).toEqual([
      ['Admin', true],
      ['Annen Kull', false],
      ['Fra Kulliste', false],
      ['Uten Epost', false],
    ])
  })

  it('e-post fra kullisten gir ikke tilgang alene, men en godkjent forespørsel kobler kontoen til profilen', async () => {
    await importSheet(sheet)
    const admin = await setupAdmin()
    const profile = await personByEmail('kulliste@example.test')
    const id = await createAccount('Kulliste')
    const viewer = await loadViewer(db, id)

    // Bekreftet adresse fra lista: fortsatt ventende, og profilen er urørt.
    expect(viewer?.membership).toEqual({ status: 'pending', role: 'member' })
    expect(viewer?.personId).not.toBe(profile!.id)
    expect((await personByEmail('kulliste@example.test'))?.userId).toBeNull()
    expect(await denial(listActiveMembers(db, viewer))).toBe('not_member')

    // Søkeren ser bare profilen med sin egen adresse, og kan velge den.
    const state = await getAccessState(db, viewer)
    expect(state.match).toMatchObject({ personId: profile!.id, fullName: 'Fra Kulliste' })
    await submitAccessRequest(
      db,
      viewer,
      request({ profilePersonId: profile!.id, fullName: 'Fra Kulliste' }),
    )

    const [open] = await listAccessRequests(db, admin)
    expect(open).toMatchObject({
      email: 'kulliste@example.test',
      emailOnProfile: true,
      profile: { personId: profile!.id, years: [2015] },
    })
    await decideAccessRequest(db, admin, { requestId: open!.id, decision: 'approve' })

    const after = await loadViewer(db, id)
    expect(after?.personId).toBe(profile!.id)
    expect(after?.membership?.status).toBe('active')
    expect(await listAccessRequests(db, admin)).toEqual([])
    const audit = await db
      .select({ action: schema.auditEvent.action })
      .from(schema.auditEvent)
      .where(eq(schema.auditEvent.subjectPersonId, profile!.id))
    expect(audit.map((a) => a.action)).toContain('access.approve')
  })

  it('søkere kan ikke velge en profil som ikke har deres egen e-postadresse', async () => {
    await importSheet(sheet)
    const other = await personByEmail('annen@example.test')
    const viewer = await loadViewer(db, await createAccount('Inntrenger'))
    expect((await getAccessState(db, viewer)).match).toBeNull()
    await expect(
      submitAccessRequest(db, viewer, request({ profilePersonId: other!.id })),
    ).rejects.toThrow('e-postadressen din')
  })

  it('admin ser forslag og kan godkjenne som ny person eller koble til en profil', async () => {
    await importSheet(sheet)
    const admin = await setupAdmin()
    const ny = await loadViewer(db, await createAccount('Ny'))
    await submitAccessRequest(db, ny, request({ fullName: 'Helt Ny', graduationYear: 2019 }))
    const gammel = await loadViewer(db, await createAccount('Gammel'))
    await submitAccessRequest(db, gammel, request({ fullName: 'Uten Epost', graduationYear: 2015 }))

    const open = await listAccessRequests(db, admin)
    const forNy = open.find((r) => r.fullName === 'Helt Ny')!
    const forGammel = open.find((r) => r.fullName === 'Uten Epost')!
    expect(forNy).toMatchObject({ profile: null, emailOnProfile: false, suggestions: [] })
    expect(forGammel.suggestions).toMatchObject([{ fullName: 'Uten Epost', years: [2015] }])

    await decideAccessRequest(db, admin, { requestId: forNy.id, decision: 'approve' })
    await decideAccessRequest(db, admin, {
      requestId: forGammel.id,
      decision: 'approve',
      profilePersonId: forGammel.suggestions[0]!.personId,
    })
    const members = await listActiveMembers(db, admin)
    expect(members.find((m) => m.fullName === 'Helt Ny')?.cohorts).toEqual([
      { graduationYear: 2019, relation: 'student' },
    ])
    expect(members.find((m) => m.fullName === 'Uten Epost')?.claimed).toBe(true)
  })

  it('avslag gir ingen tilgang, og forespørselen kan ikke sendes på nytt', async () => {
    const admin = await setupAdmin()
    const id = await createAccount('Avvist')
    const viewer = await loadViewer(db, id)
    await submitAccessRequest(db, viewer, request())
    const [open] = await listAccessRequests(db, admin)
    expect(
      await denial(decideAccessRequest(db, viewer, { requestId: open!.id, decision: 'approve' })),
    ).toBe('not_member')
    await decideAccessRequest(db, admin, { requestId: open!.id, decision: 'reject' })

    const after = await loadViewer(db, id)
    expect(after?.membership?.status).toBe('inactive')
    expect(await denial(listActiveMembers(db, after))).toBe('not_member')
    await expect(submitAccessRequest(db, after, request())).rejects.toThrow('avslått')
  })

  it('operatøren godkjenner en åpen forespørsel og gir adminrolle', async () => {
    await importSheet(sheet)
    const profile = await personByEmail('kulliste@example.test')
    const id = await createAccount('Kulliste')
    const viewer = await loadViewer(db, id)
    await submitAccessRequest(
      db,
      viewer,
      request({ profilePersonId: profile!.id, fullName: 'Fra Kulliste' }),
    )
    const granted = await grantRoleAsOperator(db, {
      email: 'kulliste@example.test',
      reason: 'test',
    })
    // Standard er hovedadmin: operatøren bruker dette til å komme i gang.
    expect(granted).toEqual({ personId: profile!.id, fullName: 'Fra Kulliste', role: 'owner' })
    expect((await loadViewer(db, id))?.membership).toEqual({ status: 'active', role: 'owner' })
  })

  it('ubekreftet konto kan ikke gjøre krav på en profil', async () => {
    await importSheet(sheet)
    await loadViewer(db, await createAccount('Kulliste', false))
    const profile = await personByEmail('kulliste@example.test')
    expect(profile?.userId).toBeNull()
  })

  it('en profil importert som ventende blir aktiv først når admin godkjenner', async () => {
    await importSheet(sheet, 'pending')
    const admin = await setupAdmin()
    const profile = await personByEmail('kulliste@example.test')
    const viewer = await loadViewer(db, await createAccount('Kulliste'))
    await submitAccessRequest(db, viewer, request({ profilePersonId: profile!.id }))
    expect(await denial(listActiveMembers(db, viewer))).toBe('not_member')

    const [open] = await listAccessRequests(db, admin)
    await decideAccessRequest(db, admin, { requestId: open!.id, decision: 'approve' })
    const members = await listActiveMembers(db, admin)
    expect(members.find((m) => m.personId === profile!.id)?.claimed).toBe(true)
  })

  it('admin kan koble en ventende konto til riktig profil', async () => {
    await importSheet(sheet)
    const admin = await setupAdmin()
    const id = await createAccount('Ny')
    const pending = await loadViewer(db, id)
    const [profile] = await searchUnclaimedProfiles(db, admin, 'uten')
    expect(profile).toMatchObject({
      fullName: 'Uten Epost',
      cohortYears: [2015],
      phoneHidden: false,
    })
    // Admin ser nummeret fra telefonlista også når det er skjult for medlemmer, men merket.
    await db
      .update(schema.person)
      .set({ phone: '+47 400 00 000', phoneVisible: false })
      .where(eq(schema.person.id, profile!.personId))
    expect((await searchUnclaimedProfiles(db, admin, 'uten'))[0]).toMatchObject({
      phone: '+47 400 00 000',
      phoneHidden: true,
    })

    const link = (viewer: typeof admin) =>
      linkAccountToProfile(db, viewer, {
        pendingPersonId: pending!.personId!,
        profilePersonId: profile!.personId,
      })
    expect(await denial(link(pending))).toBe('not_member')
    expect(await denial(searchUnclaimedProfiles(db, pending, 'uten'))).toBe('not_member')

    await link(admin)
    const after = await loadViewer(db, id)
    expect(after?.personId).toBe(profile!.personId)
    expect(after?.membership?.status).toBe('active')
    expect(
      await db.select().from(schema.person).where(eq(schema.person.id, pending!.personId!)),
    ).toEqual([])
    expect(await searchUnclaimedProfiles(db, admin, 'uten')).toEqual([])

    // En profil som allerede er tatt i bruk kan ikke kobles til en annen konto.
    const other = await loadViewer(db, await createAccount('Tredje'))
    expect(other?.membership?.status).toBe('pending')
    await expect(
      linkAccountToProfile(db, admin, {
        pendingPersonId: other!.personId!,
        profilePersonId: profile!.personId,
      }),
    ).rejects.toThrow('allerede tatt i bruk')
  })
})
