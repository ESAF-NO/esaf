import { randomUUID } from 'node:crypto'
import { createDb, loadRootEnv, runMigrations, schema, type Db } from '@esaf/db'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccessDeniedError,
  addCohortRepresentative,
  addWeekendAttendees,
  addWeekendCohort,
  createProfile,
  createWeekend,
  decideMembership,
  deleteWeekend,
  endCohortRepresentative,
  getCohortPage,
  getEditableWeekend,
  getProfile,
  getWeekend,
  grantRoleAsOperator,
  listActiveMembers,
  listCohortRepresentatives,
  listRepresentativeCandidates,
  listRepresentativeOverview,
  listWeekends,
  loadViewer,
  matchWeekendAttendees,
  mergePeople,
  removeCohortRepresentative,
  removeWeekendAttendee,
  searchPeople,
  setOwnAttendance,
  setPersonCohorts,
  updateCohortRepresentative,
  updateWeekend,
  type ObjectStorage,
  type Viewer,
  type WeekendInput,
} from '../src/index.ts'

loadRootEnv()
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

const storage: ObjectStorage = {
  put: () => Promise.resolve(),
  get: () => Promise.resolve(null),
  delete: () => Promise.resolve(),
}

const weekendFields = (patch: Partial<WeekendInput> = {}): WeekendInput => ({
  name: 'ESAF-helgen høst 2018',
  startDate: '2018-09-14',
  endDate: '2018-09-16',
  location: 'Trondheim',
  description: '',
  ...patch,
})

describe.skipIf(!url)('kullrepresentanter og ESAF-helgen', () => {
  let db: Db
  let admin: Viewer
  let weakAdmin: Viewer
  let ola: Viewer
  let kari: Viewer

  beforeAll(async () => {
    await runMigrations(url!)
    db = createDb(url!)
  })
  afterAll(() => db?.close())

  async function account(name: string) {
    const id = randomUUID()
    await db
      .insert(schema.user)
      .values({ id, name, email: `${name.toLowerCase()}@example.test`, emailVerified: true })
    return id
  }

  /** Et aktivt medlem med konto, i kullet. */
  async function member(name: string, year: number) {
    const v = await loadViewer(db, await account(name))
    await decideMembership(db, admin, { personId: v!.personId!, decision: 'approve' })
    await setPersonCohorts(db, admin, v!.personId!, [{ graduationYear: year, relation: 'student' }])
    return loadViewer(db, v!.userId)
  }

  /** En profil fra «kullisten», uten konto. */
  async function profile(
    fullName: string,
    year: number | null,
    extra: { emails?: string[]; status?: 'active' | 'pending' } = {},
  ) {
    const { personId } = await createProfile(db, admin, {
      fullName,
      cohorts: year ? [{ graduationYear: year, relation: 'student' }] : [],
      emails: extra.emails ?? [],
      status: extra.status ?? 'active',
    })
    return personId
  }

  beforeEach(async () => {
    await db.execute(
      sql`truncate ${schema.esafWeekend}, ${schema.cohortRepresentative}, ${schema.fieldSource}, ${schema.auditEvent}, ${schema.membership}, ${schema.personCohort}, ${schema.person}, ${schema.cohort}, ${schema.user}, ${schema.company} cascade`,
    )
    await account('Admin')
    await grantRoleAsOperator(db, { email: 'admin@example.test', reason: 'test', role: 'admin' })
    await db
      .update(schema.user)
      .set({ twoFactorEnabled: true })
      .where(eq(schema.user.email, 'admin@example.test'))
    admin = await loadViewer(db, (await db.select().from(schema.user))[0]!.id)
    weakAdmin = { ...admin!, twoFactorEnabled: false, passkeySession: false }
    ola = await member('Ola', 2018)
    kari = await member('Kari', 2019)
  })

  async function denial(promise: Promise<unknown>) {
    try {
      await promise
      return 'allowed'
    } catch (error) {
      if (error instanceof AccessDeniedError) return error.reason
      throw error
    }
  }

  const audit = (action: string) =>
    db.select().from(schema.auditEvent).where(eq(schema.auditEvent.action, action))

  it('bare admins med sterk innlogging styrer verv og helger', async () => {
    const { id: weekendId } = await createWeekend(db, admin, weekendFields())
    const { id: repId } = await addCohortRepresentative(db, admin, {
      graduationYear: 2018,
      personId: ola!.personId!,
      startYear: 2018,
      note: null,
    })
    const calls: [string, (v: Viewer) => Promise<unknown>][] = [
      ['listRepresentativeOverview', (v) => listRepresentativeOverview(db, v)],
      [
        'listRepresentativeCandidates',
        (v) => listRepresentativeCandidates(db, v, { graduationYear: 2018 }),
      ],
      [
        'addCohortRepresentative',
        (v) =>
          addCohortRepresentative(db, v, {
            graduationYear: 2019,
            personId: kari!.personId!,
            startYear: 2020,
            note: null,
          }),
      ],
      [
        'updateCohortRepresentative',
        (v) =>
          updateCohortRepresentative(db, v, repId, {
            startYear: 2017,
            endYear: null,
            note: 'Valgt',
          }),
      ],
      [
        'createWeekend',
        (v) =>
          createWeekend(
            db,
            v,
            weekendFields({ name: 'Vår 2019', startDate: '2019-04-05', endDate: null }),
          ),
      ],
      ['getEditableWeekend', (v) => getEditableWeekend(db, v, weekendId)],
      [
        'updateWeekend',
        (v) => updateWeekend(db, v, weekendId, weekendFields({ location: 'Oppdal' })),
      ],
      [
        'addWeekendAttendees',
        (v) =>
          addWeekendAttendees(db, v, weekendId, { personIds: [kari!.personId!], source: 'admin' }),
      ],
      ['addWeekendCohort', (v) => addWeekendCohort(db, v, weekendId, 2018)],
      ['matchWeekendAttendees', (v) => matchWeekendAttendees(db, v, weekendId, 'Ola')],
    ]
    for (const [name, call] of calls) {
      expect([name, await denial(call(ola))]).toEqual([name, 'forbidden'])
      expect([name, await denial(call(weakAdmin))]).toEqual([name, 'strong_auth_required'])
      expect([name, await denial(call(admin))]).toEqual([name, 'allowed'])
    }
    // Det som fjerner, til slutt, så det finnes noe å fjerne for admin.
    expect(await denial(removeWeekendAttendee(db, ola, weekendId, kari!.personId!))).toBe(
      'forbidden',
    )
    expect(await denial(endCohortRepresentative(db, weakAdmin, repId))).toBe('strong_auth_required')
    expect(await denial(removeCohortRepresentative(db, ola, repId))).toBe('forbidden')
    expect(await denial(deleteWeekend(db, weakAdmin, weekendId))).toBe('strong_auth_required')
    // Uinnlogget og ventende får ikke lese.
    expect(await denial(listWeekends(db, null))).toBe('unauthenticated')
    expect(await denial(listCohortRepresentatives(db, null, 2018))).toBe('unauthenticated')
  })

  it('verv: legge til, rette, avslutte og slette logges, og annet kull krever bekreftelse', async () => {
    const siri = await profile('Siri Berg', 2018)
    const { id } = await addCohortRepresentative(db, admin, {
      graduationYear: 2018,
      personId: siri,
      startYear: 2019,
      note: 'Valgt på kullsamlingen',
    })
    await expect(
      addCohortRepresentative(db, admin, {
        graduationYear: 2018,
        personId: siri,
        startYear: 2020,
        note: null,
      }),
    ).rejects.toThrow(/allerede kullrepresentant/)
    // Kari går i 2019, ikke 2018.
    await expect(
      addCohortRepresentative(db, admin, {
        graduationYear: 2018,
        personId: kari!.personId!,
        startYear: 2020,
        note: null,
      }),
    ).rejects.toThrow(/går ikke i ES 2018/)
    await addCohortRepresentative(db, admin, {
      graduationYear: 2018,
      personId: kari!.personId!,
      startYear: 2020,
      note: null,
      otherCohort: true,
    })
    const [added] = (await audit('cohort.rep_add')).filter(
      (e) => e.subjectPersonId === kari!.personId,
    )
    expect(added!.details).toMatchObject({ graduationYear: 2018, otherCohort: true })

    await updateCohortRepresentative(db, admin, id, {
      startYear: 2018,
      endYear: null,
      note: 'Valgt',
    })
    expect((await audit('cohort.rep_edit'))[0]!.details).toMatchObject({
      from: { startYear: 2019, endYear: null },
      to: { startYear: 2018, endYear: null },
      noteChanged: true,
    })
    await expect(endCohortRepresentative(db, admin, id, { endYear: 2017 })).rejects.toThrow(
      /før startåret/,
    )
    await endCohortRepresentative(db, admin, id, { endYear: 2022 })
    await expect(endCohortRepresentative(db, admin, id)).rejects.toThrow(/allerede avsluttet/)
    expect((await audit('cohort.rep_end'))[0]).toMatchObject({
      actorPersonId: admin!.personId,
      subjectPersonId: siri,
      details: { graduationYear: 2018, endYear: 2022 },
    })
    // Etter at vervet er over, kan personen velges på nytt.
    const { id: again } = await addCohortRepresentative(db, admin, {
      graduationYear: 2018,
      personId: siri,
      startYear: 2024,
      note: null,
    })
    await expect(
      updateCohortRepresentative(db, admin, id, { startYear: 2018, endYear: null, note: null }),
    ).rejects.toThrow(/allerede et nåværende verv/)
    await removeCohortRepresentative(db, admin, again)
    expect(await audit('cohort.rep_remove')).toHaveLength(1)

    const overview = await listRepresentativeOverview(db, admin)
    const es2018 = overview.find((c) => c.graduationYear === 2018)!
    expect(es2018.current.map((r) => [r.fullName, r.otherCohort])).toEqual([['Kari', true]])
    expect(es2018.past.map((r) => [r.fullName, r.startYear, r.endYear])).toEqual([
      ['Siri Berg', 2018, 2022],
    ])
    expect(overview.find((c) => c.graduationYear === 2019)!.current).toEqual([])
  })

  it('kullsiden, profilen, katalogen og søket viser vervene', async () => {
    const gone = await profile('Gunnar Borte', 2018, { status: 'pending' })
    await addCohortRepresentative(db, admin, {
      graduationYear: 2018,
      personId: ola!.personId!,
      startYear: 2018,
      note: 'Hemmelig notat',
    })
    const { id: old } = await addCohortRepresentative(db, admin, {
      graduationYear: 2019,
      personId: ola!.personId!,
      startYear: 2016,
      note: null,
      otherCohort: true,
    })
    await endCohortRepresentative(db, admin, old, { endYear: 2017 })
    await addCohortRepresentative(db, admin, {
      graduationYear: 2018,
      personId: gone,
      startYear: 2018,
      note: null,
    })

    const page = await getCohortPage(db, kari, 2018)
    // Bare aktive medlemmer, og notatet bare for admins.
    expect(page.representatives.current.map((r) => [r.fullName, r.note])).toEqual([['Ola', null]])
    expect((await getCohortPage(db, admin, 2018)).representatives.current[0]!.note).toBe(
      'Hemmelig notat',
    )
    expect(
      (await getCohortPage(db, kari, 2019)).representatives.past.map((r) => r.fullName),
    ).toEqual(['Ola'])

    expect((await getProfile(db, kari, ola!.personId!)).representative).toEqual([
      { graduationYear: 2018, current: true, period: 'siden 2018' },
      { graduationYear: 2019, current: false, period: '2016–2017' },
    ])
    const members = await listActiveMembers(db, kari)
    expect(members.find((m) => m.personId === ola!.personId)!.representativeOf).toEqual([2018])
    expect(members.find((m) => m.personId === kari!.personId)!.representativeOf).toEqual([])
    expect((await searchPeople(db, kari, 'Ola'))[0]!.representativeOf).toEqual([2018])

    const candidates = await listRepresentativeCandidates(db, admin, { graduationYear: 2019 })
    expect(candidates.map((c) => [c.fullName, c.inCohort])).toEqual([['Kari', true]])
    const searched = await listRepresentativeCandidates(db, admin, {
      graduationYear: 2019,
      query: 'ol',
    })
    expect(searched.map((c) => [c.fullName, c.inCohort])).toEqual([['Ola', false]])
  })

  it('«Jeg var der» gjelder med en gang, og telles på helgen, oversikten og profilen', async () => {
    const { id: autumn } = await createWeekend(db, admin, weekendFields())
    const { id: spring } = await createWeekend(
      db,
      admin,
      weekendFields({ name: 'Vår 2019', startDate: '2019-04-05', endDate: null }),
    )
    const { id: future } = await createWeekend(
      db,
      admin,
      weekendFields({
        name: 'Neste',
        startDate: `${new Date().getFullYear() + 1}-09-01`,
        endDate: null,
      }),
    )
    await setOwnAttendance(db, ola, autumn, true)
    await setOwnAttendance(db, ola, autumn, true) // to ganger er det samme
    await setOwnAttendance(db, ola, spring, true)
    await setOwnAttendance(db, kari, autumn, true)
    await expect(setOwnAttendance(db, kari, future, true)).rejects.toThrow(/ikke startet/)
    // Selvregistrering logges ikke; det gjelder bare en selv.
    expect(
      await db.$count(schema.auditEvent, sql`${schema.auditEvent.action} like 'weekend.%'`),
    ).toBe(3)

    // En profil som ikke er aktiv, telles ikke for medlemmer.
    const hidden = await profile('Venter Venn', 2018, { status: 'pending' })
    await addWeekendAttendees(db, admin, autumn, { personIds: [hidden], source: 'admin' })

    const overview = await listWeekends(db, kari)
    expect(overview.weekends.map((w) => [w.name, w.attendees, w.attended, w.upcoming])).toEqual([
      ['Neste', 0, false, true],
      ['Vår 2019', 1, false, false],
      ['ESAF-helgen høst 2018', 2, true, false],
    ])
    expect(overview).toMatchObject({ people: 2, attendances: 3, canManage: false })
    expect(overview.cohorts).toEqual([
      { graduationYear: 2019, people: 1, attendances: 1 },
      { graduationYear: 2018, people: 1, attendances: 2 },
    ])
    expect((await listWeekends(db, admin)).canManage).toBe(true)

    const w = await getWeekend(db, kari, autumn)
    expect(w).toMatchObject({ attendees: 2, attended: true, canManage: false })
    expect(
      w.groups.map((g) => [g.graduationYear, g.people.map((p) => [p.fullName, p.source])]),
    ).toEqual([
      [2019, [['Kari', null]]],
      [2018, [['Ola', null]]],
    ])
    // Admins ser også dem som ikke er aktive, og hvordan de kom på lista.
    const forAdmin = await getWeekend(db, admin, autumn)
    expect(forAdmin.attendees).toBe(3)
    expect(
      forAdmin.groups
        .find((g) => g.graduationYear === 2018)!
        .people.map((p) => [p.fullName, p.source, p.status]),
    ).toEqual([
      ['Ola', 'self', 'active'],
      ['Venter Venn', 'admin', 'pending'],
    ])

    expect((await getProfile(db, kari, ola!.personId!)).weekends.map((x) => x.name)).toEqual([
      'Vår 2019',
      'ESAF-helgen høst 2018',
    ])

    await setOwnAttendance(db, ola, spring, false)
    expect((await getWeekend(db, ola, spring)).attended).toBe(false)
    expect((await getProfile(db, ola, ola!.personId!)).weekends).toHaveLength(1)
  })

  it('admins lager, retter og sletter helger og legger til deltakere, og alt logges', async () => {
    await expect(
      createWeekend(db, admin, weekendFields({ endDate: '2018-09-01' })),
    ).rejects.toThrow(/før startdatoen/)
    await expect(
      createWeekend(db, admin, weekendFields({ startDate: '2018-02-30' })),
    ).rejects.toThrow(/Ugyldig dato/)
    const { id } = await createWeekend(db, admin, weekendFields())
    expect((await audit('weekend.create'))[0]!.details).toMatchObject({
      weekendId: id,
      name: 'ESAF-helgen høst 2018',
    })

    await updateWeekend(db, admin, id, weekendFields())
    expect(await audit('weekend.edit')).toHaveLength(0) // ingen endring, ingen logg
    await updateWeekend(
      db,
      admin,
      id,
      weekendFields({ location: 'Oppdal', description: 'Topptur' }),
    )
    expect((await audit('weekend.edit'))[0]!.details).toMatchObject({
      fields: ['location', 'description'],
    })

    const per = await profile('Per Hansen', 2018)
    const { added } = await addWeekendCohort(db, admin, id, 2018)
    expect(added).toBe(2) // Ola og Per
    expect(await addWeekendCohort(db, admin, id, 2018)).toEqual({ added: 0 })
    expect(
      await addWeekendAttendees(db, admin, id, {
        personIds: [kari!.personId!, per],
        source: 'import',
      }),
    ).toEqual({ added: 1 })
    const adds = await audit('weekend.attendance_add')
    expect(adds.map((a) => a.details.added).sort()).toEqual([1, 2])
    expect(adds.find((a) => a.details.cohort === 2018)).toBeTruthy()
    expect(adds.find((a) => a.details.source === 'import')!.subjectPersonId).toBe(kari!.personId)

    await removeWeekendAttendee(db, admin, id, per)
    await expect(removeWeekendAttendee(db, admin, id, per)).rejects.toThrow(/ikke registrert/)
    expect((await audit('weekend.attendance_remove'))[0]).toMatchObject({ subjectPersonId: per })

    await deleteWeekend(db, admin, id)
    expect((await audit('weekend.delete'))[0]!.details).toMatchObject({
      name: 'ESAF-helgen høst 2018',
      attendees: 2,
    })
    expect(await db.$count(schema.esafWeekendAttendance)).toBe(0)
  })

  it('en innlimt liste matches på kjent e-post, kontaktadresse og navn', async () => {
    const { id } = await createWeekend(db, admin, weekendFields())
    const per = await profile('Per Ødegård', 2017, { emails: ['per@firma.test'] })
    await db
      .update(schema.person)
      .set({ contactEmail: 'P.Ode@Gmail.com' })
      .where(eq(schema.person.id, per))
    await profile('Ola Hansen', 2012)
    await profile('Ola Hansen', 2020)
    await setOwnAttendance(db, kari, id, true)

    const lines = await matchWeekendAttendees(
      db,
      admin,
      id,
      [
        'PER@firma.test',
        'pode+x@gmail.com',
        'per odegard',
        'Ola Hansen',
        'Ola Hansen 2020',
        'Kari',
        'Ukjent Person',
      ].join('\n'),
    )
    expect(lines.map((l) => [l.status, l.by])).toEqual([
      ['matched', 'email'],
      ['duplicate', 'email'],
      ['duplicate', 'name'],
      ['ambiguous', 'name'],
      ['matched', 'name'],
      ['matched', 'name'],
      ['unmatched', null],
    ])
    expect(lines[0]!.candidates[0]!.personId).toBe(per)
    expect(lines[5]!.candidates[0]).toMatchObject({ personId: kari!.personId, attending: true })
    // Forhåndsvisningen lagrer ingenting.
    expect(await db.$count(schema.esafWeekendAttendance)).toBe(1)
  })

  it('sammenslåing flytter verv og oppmøte', async () => {
    const { id: w1 } = await createWeekend(db, admin, weekendFields())
    const { id: w2 } = await createWeekend(
      db,
      admin,
      weekendFields({ name: 'Vår 2019', startDate: '2019-04-05', endDate: null }),
    )
    const dup = await profile('Ola', 2018)
    await addWeekendAttendees(db, admin, w1, { personIds: [dup, ola!.personId!], source: 'admin' })
    await addWeekendAttendees(db, admin, w2, { personIds: [dup], source: 'import' })
    await addCohortRepresentative(db, admin, {
      graduationYear: 2018,
      personId: dup,
      startYear: 2018,
      note: null,
    })
    await addCohortRepresentative(db, admin, {
      graduationYear: 2018,
      personId: ola!.personId!,
      startYear: 2019,
      note: null,
    })
    const { id: past } = await addCohortRepresentative(db, admin, {
      graduationYear: 2019,
      personId: dup,
      startYear: 2014,
      note: null,
      otherCohort: true,
    })
    await endCohortRepresentative(db, admin, past, { endYear: 2015 })

    const { personId } = await mergePeople(db, storage, admin, {
      sourceId: dup,
      targetId: ola!.personId!,
    })
    expect(personId).toBe(ola!.personId)
    expect((await getProfile(db, ola, personId)).weekends).toHaveLength(2)
    expect((await getProfile(db, ola, personId)).representative).toEqual([
      { graduationYear: 2018, current: true, period: 'siden 2019' },
      { graduationYear: 2019, current: false, period: '2014–2015' },
    ])
    expect((await audit('person.merge'))[0]!.details).toMatchObject({
      representatives: 1,
      weekends: 1,
    })
  })
})
