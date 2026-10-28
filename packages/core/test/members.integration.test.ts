import { randomUUID } from 'node:crypto'
import { createDb, loadRootEnv, runMigrations, schema, type Db } from '@esaf/db'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccessDeniedError,
  DomainError,
  applyProfileImport,
  decideMembership,
  grantAdminAsOperator,
  linkAccountToProfile,
  listActiveMembers,
  listPendingMemberships,
  loadViewer,
  parseProfileSheet,
  planProfileImport,
  searchUnclaimedProfiles,
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
      sql`truncate ${schema.auditEvent}, ${schema.membership}, ${schema.personCohort}, ${schema.person}, ${schema.cohort}, ${schema.user} cascade`,
    )
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

  async function setupAdmin() {
    const id = await createAccount('Admin')
    await grantAdminAsOperator(db, { email: 'admin@example.test', reason: 'test' })
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
    expect(await denial(approvePending(member))).toBe('not_admin')
    expect(await denial(listPendingMemberships(db, member))).toBe('not_admin')

    expect((await listPendingMemberships(db, admin)).map((p) => p.fullName)).toEqual(['Ventende'])
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
      'operator.grant_admin',
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
      grantAdminAsOperator(db, { email: 'angriper@example.test', reason: 'test' }),
    ).rejects.toThrow('bekreftet')
  })

  async function importSheet(csv: string, membershipStatus: 'active' | 'pending' = 'active') {
    const sheet = parseProfileSheet(csv, { yearKind: 'start' })
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

  it('bekreftet konto gjør krav på profilen med samme e-post og arver medlemskapet', async () => {
    await importSheet(sheet)
    const [profile] = await db
      .select()
      .from(schema.person)
      .where(eq(schema.person.email, 'kulliste@example.test'))
    const id = await createAccount('Kulliste')
    const viewer = await loadViewer(db, id)

    expect(viewer?.personId).toBe(profile!.id)
    expect(viewer?.membership).toEqual({ status: 'active', role: 'member' })
    const [claimed] = await db.select().from(schema.person).where(eq(schema.person.userId, id))
    expect(claimed?.fullName).toBe('Fra Kulliste')
    expect(claimed?.claimedAt).toBeInstanceOf(Date)
    const audit = await db
      .select()
      .from(schema.auditEvent)
      .where(eq(schema.auditEvent.action, 'profile.claim'))
    expect(audit).toHaveLength(1)
  })

  it('ubekreftet konto kan ikke gjøre krav på en profil', async () => {
    await importSheet(sheet)
    await loadViewer(db, await createAccount('Kulliste', false))
    const [profile] = await db
      .select()
      .from(schema.person)
      .where(eq(schema.person.email, 'kulliste@example.test'))
    expect(profile?.userId).toBeNull()
  })

  it('profil importert som ventende gir ikke tilgang ved krav', async () => {
    await importSheet(sheet, 'pending')
    const viewer = await loadViewer(db, await createAccount('Kulliste'))
    expect(viewer?.membership?.status).toBe('pending')
    expect(await denial(listActiveMembers(db, viewer))).toBe('not_member')
  })

  it('admin kan koble en ventende konto til riktig profil', async () => {
    await importSheet(sheet)
    const admin = await setupAdmin()
    const id = await createAccount('Ny')
    const pending = await loadViewer(db, id)
    const [profile] = await searchUnclaimedProfiles(db, admin, 'uten')
    expect(profile).toMatchObject({ fullName: 'Uten Epost', cohortYears: [2015] })

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
