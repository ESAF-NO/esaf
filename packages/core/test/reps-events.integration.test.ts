import { randomUUID } from 'node:crypto'
import { createDb, loadRootEnv, runMigrations, schema, type Db } from '@esaf/db'
import { eq, ne, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccessDeniedError,
  addCohortRepresentative,
  addEventParticipants,
  addEventCohort,
  createProfile,
  createEvent,
  decideMembership,
  deleteEvent,
  endCohortRepresentative,
  getCohortPage,
  getEditableEvent,
  getProfile,
  getEvent,
  grantRoleAsOperator,
  listActiveMembers,
  listCohortRepresentatives,
  listRepresentativeCandidates,
  listRepresentativeOverview,
  getEventTypeOverview,
  createEventType,
  deleteEventType,
  findEventType,
  listEventTypeOptions,
  listEventTypes,
  updateEventParticipant,
  updateEventType,
  loadViewer,
  matchEventParticipants,
  mergePeople,
  removeCohortRepresentative,
  removeEventParticipant,
  searchPeople,
  setOwnParticipation,
  setPersonCohorts,
  updateCohortRepresentative,
  updateEvent,
  type ObjectStorage,
  type Viewer,
  type EventInput,
} from '../src/index.ts'

loadRootEnv()
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

const storage: ObjectStorage = {
  put: () => Promise.resolve(),
  get: () => Promise.resolve(null),
  delete: () => Promise.resolve(),
}

/** ESAF-helgen, som migreringen legger inn. */
let weekendType = ''

const eventFields = (patch: Partial<EventInput> = {}): EventInput => ({
  typeId: weekendType,
  name: 'ESAF-helgen høst 2018',
  startDate: '2018-09-14',
  endDate: '2018-09-16',
  location: 'Trondheim',
  description: '',
  ...patch,
})

describe.skipIf(!url)('kullrepresentanter og arrangementer', () => {
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
      sql`truncate ${schema.event}, ${schema.cohortRepresentative}, ${schema.fieldSource}, ${schema.auditEvent}, ${schema.membership}, ${schema.personCohort}, ${schema.person}, ${schema.cohort}, ${schema.user}, ${schema.company} cascade`,
    )
    await db.delete(schema.eventType).where(ne(schema.eventType.slug, 'esaf-helgen'))
    weekendType = (
      await db
        .select({ id: schema.eventType.id })
        .from(schema.eventType)
        .where(eq(schema.eventType.slug, 'esaf-helgen'))
    )[0]!.id
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
    const { id: eventId } = await createEvent(db, admin, eventFields())
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
        'createEvent',
        (v) =>
          createEvent(
            db,
            v,
            eventFields({ name: 'Vår 2019', startDate: '2019-04-05', endDate: null }),
          ),
      ],
      ['getEditableEvent', (v) => getEditableEvent(db, v, eventId)],
      ['updateEvent', (v) => updateEvent(db, v, eventId, eventFields({ location: 'Oppdal' }))],
      [
        'addEventParticipants',
        (v) =>
          addEventParticipants(db, v, eventId, { personIds: [kari!.personId!], source: 'admin' }),
      ],
      ['addEventCohort', (v) => addEventCohort(db, v, eventId, 2018)],
      ['matchEventParticipants', (v) => matchEventParticipants(db, v, eventId, 'Ola')],
    ]
    for (const [name, call] of calls) {
      expect([name, await denial(call(ola))]).toEqual([name, 'forbidden'])
      expect([name, await denial(call(weakAdmin))]).toEqual([name, 'strong_auth_required'])
      expect([name, await denial(call(admin))]).toEqual([name, 'allowed'])
    }
    // Det som fjerner, til slutt, så det finnes noe å fjerne for admin.
    expect(await denial(removeEventParticipant(db, ola, eventId, kari!.personId!))).toBe(
      'forbidden',
    )
    expect(await denial(endCohortRepresentative(db, weakAdmin, repId))).toBe('strong_auth_required')
    expect(await denial(removeCohortRepresentative(db, ola, repId))).toBe('forbidden')
    expect(await denial(deleteEvent(db, weakAdmin, eventId))).toBe('strong_auth_required')
    // Uinnlogget og ventende får ikke lese.
    expect(await denial(getEventTypeOverview(db, null, 'esaf-helgen'))).toBe('unauthenticated')
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
    const { id: autumn } = await createEvent(db, admin, eventFields())
    const { id: spring } = await createEvent(
      db,
      admin,
      eventFields({ name: 'Vår 2019', startDate: '2019-04-05', endDate: null }),
    )
    const { id: future } = await createEvent(
      db,
      admin,
      eventFields({
        name: 'Neste',
        startDate: `${new Date().getFullYear() + 1}-09-01`,
        endDate: null,
      }),
    )
    await setOwnParticipation(db, ola, autumn, true)
    await setOwnParticipation(db, ola, autumn, true) // to ganger er det samme
    await setOwnParticipation(db, ola, spring, true)
    await setOwnParticipation(db, kari, autumn, true)
    await expect(setOwnParticipation(db, kari, future, true)).rejects.toThrow(/ikke startet/)
    // Selvregistrering logges ikke; det gjelder bare en selv.
    expect(
      await db.$count(schema.auditEvent, sql`${schema.auditEvent.action} like 'event.%'`),
    ).toBe(3)

    // En profil som ikke er aktiv, telles ikke for medlemmer.
    const hidden = await profile('Venter Venn', 2018, { status: 'pending' })
    await addEventParticipants(db, admin, autumn, { personIds: [hidden], source: 'admin' })

    const overview = await getEventTypeOverview(db, kari, 'esaf-helgen')
    expect(
      overview.events.map((w) => [w.name, w.participants, w.participated, w.upcoming]),
    ).toEqual([
      ['Neste', 0, false, true],
      ['Vår 2019', 1, false, false],
      ['ESAF-helgen høst 2018', 2, true, false],
    ])
    expect(overview).toMatchObject({ people: 2, participations: 3, canManage: false })
    expect(overview.cohorts).toEqual([
      { graduationYear: 2019, people: 1, participations: 1 },
      { graduationYear: 2018, people: 1, participations: 2 },
    ])
    expect((await getEventTypeOverview(db, admin, 'esaf-helgen')).canManage).toBe(true)

    const w = await getEvent(db, kari, autumn)
    expect(w).toMatchObject({ participants: 2, participated: true, canManage: false })
    expect(
      w.groups.map((g) => [g.graduationYear, g.people.map((p) => [p.fullName, p.source])]),
    ).toEqual([
      [2019, [['Kari', null]]],
      [2018, [['Ola', null]]],
    ])
    // Admins ser også dem som ikke er aktive, og hvordan de kom på lista.
    const forAdmin = await getEvent(db, admin, autumn)
    expect(forAdmin.participants).toBe(3)
    expect(
      forAdmin.groups
        .find((g) => g.graduationYear === 2018)!
        .people.map((p) => [p.fullName, p.source, p.status]),
    ).toEqual([
      ['Ola', 'self', 'active'],
      ['Venter Venn', 'admin', 'pending'],
    ])

    expect(
      (await getProfile(db, kari, ola!.personId!)).events[0]!.events.map((x) => x.name),
    ).toEqual(['Vår 2019', 'ESAF-helgen høst 2018'])

    await setOwnParticipation(db, ola, spring, false)
    expect((await getEvent(db, ola, spring)).participated).toBe(false)
    expect((await getProfile(db, ola, ola!.personId!)).events[0]!.events).toHaveLength(1)
  })

  it('admins lager, retter og sletter helger og legger til deltakere, og alt logges', async () => {
    await expect(createEvent(db, admin, eventFields({ endDate: '2018-09-01' }))).rejects.toThrow(
      /før startdatoen/,
    )
    await expect(createEvent(db, admin, eventFields({ startDate: '2018-02-30' }))).rejects.toThrow(
      /Ugyldig dato/,
    )
    const { id } = await createEvent(db, admin, eventFields())
    expect((await audit('event.create'))[0]!.details).toMatchObject({
      eventId: id,
      name: 'ESAF-helgen høst 2018',
    })

    await updateEvent(db, admin, id, eventFields())
    expect(await audit('event.edit')).toHaveLength(0) // ingen endring, ingen logg
    await updateEvent(db, admin, id, eventFields({ location: 'Oppdal', description: 'Topptur' }))
    expect((await audit('event.edit'))[0]!.details).toMatchObject({
      fields: ['location', 'description'],
    })

    const per = await profile('Per Hansen', 2018)
    const { added } = await addEventCohort(db, admin, id, 2018)
    expect(added).toBe(2) // Ola og Per
    expect(await addEventCohort(db, admin, id, 2018)).toEqual({ added: 0 })
    expect(
      await addEventParticipants(db, admin, id, {
        personIds: [kari!.personId!, per],
        source: 'import',
      }),
    ).toEqual({ added: 1 })
    const adds = await audit('event.participant_add')
    expect(adds.map((a) => a.details.added).sort()).toEqual([1, 2])
    expect(adds.find((a) => a.details.cohort === 2018)).toBeTruthy()
    expect(adds.find((a) => a.details.source === 'import')!.subjectPersonId).toBe(kari!.personId)

    await removeEventParticipant(db, admin, id, per)
    await expect(removeEventParticipant(db, admin, id, per)).rejects.toThrow(/ikke registrert/)
    expect((await audit('event.participant_remove'))[0]).toMatchObject({ subjectPersonId: per })

    await deleteEvent(db, admin, id)
    expect((await audit('event.delete'))[0]!.details).toMatchObject({
      name: 'ESAF-helgen høst 2018',
      participants: 2,
    })
    expect(await db.$count(schema.eventParticipation)).toBe(0)
  })

  it('en innlimt liste matches på kjent e-post, kontaktadresse og navn', async () => {
    const { id } = await createEvent(db, admin, eventFields())
    const per = await profile('Per Ødegård', 2017, { emails: ['per@firma.test'] })
    await db
      .update(schema.person)
      .set({ contactEmail: 'P.Ode@Gmail.com' })
      .where(eq(schema.person.id, per))
    await profile('Ola Hansen', 2012)
    await profile('Ola Hansen', 2020)
    await setOwnParticipation(db, kari, id, true)

    const lines = await matchEventParticipants(
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
    expect(await db.$count(schema.eventParticipation)).toBe(1)
  })

  it('sammenslåing flytter verv og oppmøte', async () => {
    const { id: w1 } = await createEvent(db, admin, eventFields())
    const { id: w2 } = await createEvent(
      db,
      admin,
      eventFields({ name: 'Vår 2019', startDate: '2019-04-05', endDate: null }),
    )
    const dup = await profile('Ola', 2018)
    await addEventParticipants(db, admin, w1, { personIds: [dup, ola!.personId!], source: 'admin' })
    await addEventParticipants(db, admin, w2, { personIds: [dup], source: 'import' })
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
    expect((await getProfile(db, ola, personId)).events[0]!.total).toBe(2)
    expect((await getProfile(db, ola, personId)).representative).toEqual([
      { graduationYear: 2018, current: true, period: 'siden 2019' },
      { graduationYear: 2019, current: false, period: '2014–2015' },
    ])
    expect((await audit('person.merge'))[0]!.details).toMatchObject({
      representatives: 1,
      events: 1,
    })
  })

  it('typer: bare admins lager, retter og sletter, ESAF-helgen står fast, og alt logges', async () => {
    const input = { name: 'Fagkveld', plural: 'Fagkvelder', description: '', sortOrder: 20 }
    expect(await denial(createEventType(db, ola, input))).toBe('forbidden')
    expect(await denial(createEventType(db, weakAdmin, input))).toBe('strong_auth_required')
    expect(await denial(listEventTypeOptions(db, ola))).toBe('forbidden')
    const { id, slug } = await createEventType(db, admin, input)
    expect(slug).toBe('fagkveld')
    await expect(createEventType(db, admin, { ...input, name: 'fagkveld' })).rejects.toThrow(
      /finnes allerede/,
    )
    await updateEventType(db, admin, id, { ...input, name: 'Fagkveld i Oslo' })
    // Adressen endres ikke når navnet gjør det.
    expect((await listEventTypeOptions(db, admin)).map((t) => [t.slug, t.name])).toEqual([
      ['esaf-helgen', 'ESAF-helgen'],
      ['fagkveld', 'Fagkveld i Oslo'],
    ])
    expect(await denial(updateEventType(db, weakAdmin, id, input))).toBe('strong_auth_required')

    const { id: eventId } = await createEvent(
      db,
      admin,
      eventFields({ typeId: id, name: 'Fagkveld om salg', startDate: '2024-10-01', endDate: null }),
    )
    await expect(deleteEventType(db, admin, id)).rejects.toThrow(/har 1 arrangement/)
    await expect(deleteEventType(db, admin, weekendType)).rejects.toThrow(/kan ikke slettes/)
    expect(await denial(deleteEventType(db, ola, id))).toBe('forbidden')
    // Flytte arrangementet til ESAF-helgen, så kan typen slettes.
    expect(
      await updateEvent(
        db,
        admin,
        eventId,
        eventFields({ name: 'Fagkveld om salg', startDate: '2024-10-01', endDate: null }),
      ),
    ).toEqual({
      typeSlug: 'esaf-helgen',
    })
    expect((await audit('event.edit'))[0]!.details).toMatchObject({
      previousType: 'Fagkveld i Oslo',
      typeSlug: 'esaf-helgen',
    })
    await deleteEventType(db, admin, id)
    expect((await audit('event_type.create'))[0]!.details).toMatchObject({ slug: 'fagkveld' })
    expect((await audit('event_type.edit'))[0]!.details).toMatchObject({
      previousName: 'Fagkveld',
      fields: ['name'],
    })
    expect((await audit('event_type.delete'))[0]!.details).toMatchObject({
      name: 'Fagkveld i Oslo',
    })
    expect(await findEventType(db, kari, eventId)).toEqual({ typeSlug: 'esaf-helgen' })
    expect(await findEventType(db, kari, randomUUID())).toBeNull()
  })

  it('roller: arrangør, foredragsholder og frivillig vises, telles og logges', async () => {
    const { id: autumn } = await createEvent(db, admin, eventFields())
    const { id: spring } = await createEvent(
      db,
      admin,
      eventFields({ name: 'Vår 2019', startDate: '2019-04-05', endDate: null }),
    )
    const { id: typeId } = await createEventType(db, admin, {
      name: 'Generalforsamling',
      plural: null,
      description: null,
      sortOrder: 10,
    })
    const { id: gf } = await createEvent(
      db,
      admin,
      eventFields({
        typeId,
        name: 'Generalforsamling 2024',
        startDate: '2024-03-14',
        endDate: null,
      }),
    )
    const per = await profile('Per Hansen', 2018)
    await setOwnParticipation(db, ola, autumn, true)
    await setOwnParticipation(db, ola, spring, true)
    await addEventParticipants(db, admin, autumn, {
      personIds: [per],
      source: 'admin',
      role: 'organizer',
    })
    await addEventParticipants(db, admin, gf, { personIds: [ola!.personId!], source: 'admin' })
    // «attended» betyr det samme som ingen rolle.
    await addEventParticipants(db, admin, spring, {
      personIds: [kari!.personId!],
      source: 'admin',
      role: 'attended',
    })
    expect(
      (await audit('event.participant_add')).find((e) => e.subjectPersonId === per)!.details,
    ).toMatchObject({
      role: 'organizer',
      typeSlug: 'esaf-helgen',
    })

    await updateEventParticipant(db, admin, autumn, ola!.personId!, {
      role: 'speaker',
      note: 'Om salg',
    })
    await updateEventParticipant(db, admin, spring, ola!.personId!, {
      role: 'organizer',
      note: null,
    })
    await updateEventParticipant(db, admin, spring, ola!.personId!, {
      role: 'organizer',
      note: null,
    })
    expect(await audit('event.participant_edit')).toHaveLength(2) // ingen endring, ingen logg
    expect(
      (await audit('event.participant_edit')).find((e) => e.details.noteChanged)!.details,
    ).toMatchObject({ from: { role: null }, to: { role: 'speaker' } })
    expect(
      await denial(updateEventParticipant(db, ola, autumn, per, { role: null, note: null })),
    ).toBe('forbidden')
    await expect(
      updateEventParticipant(db, admin, gf, per, { role: 'speaker', note: null }),
    ).rejects.toThrow(/ikke registrert/)

    // Arrangører og andre roller står først i kullet; notatet bare for admins.
    const forMember = await getEvent(db, kari, autumn)
    expect(forMember.roles).toEqual({ organizer: 1, speaker: 1, volunteer: 0 })
    expect(forMember.groups[0]!.people.map((p) => [p.fullName, p.role, p.note])).toEqual([
      ['Per Hansen', 'organizer', null],
      ['Ola', 'speaker', null],
    ])
    expect((await getEvent(db, admin, autumn)).groups[0]!.people[1]!.note).toBe('Om salg')
    expect(await getEvent(db, ola, autumn)).toMatchObject({ participated: true, myRole: 'speaker' })

    const overview = await getEventTypeOverview(db, ola, 'esaf-helgen')
    expect(overview.roles).toEqual({ organizer: 2, speaker: 1, volunteer: 0 })
    expect(overview.events.map((e) => [e.name, e.participants, e.myRole])).toEqual([
      ['Vår 2019', 2, 'organizer'],
      ['ESAF-helgen høst 2018', 2, 'speaker'],
    ])
    await expect(getEventTypeOverview(db, ola, 'finnes-ikke')).rejects.toThrow(/Fant ikke/)

    const types = await listEventTypes(db, kari)
    expect(
      types.types.map((t) => [t.slug, t.events, t.people, t.participations, t.latest?.name]),
    ).toEqual([
      ['esaf-helgen', 2, 3, 4, 'Vår 2019'],
      ['generalforsamling', 1, 1, 1, 'Generalforsamling 2024'],
    ])

    // Profilen: per type, med roller.
    const groups = (await getProfile(db, kari, ola!.personId!)).events
    expect(groups.map((g) => [g.type.name, g.total, g.roles])).toEqual([
      ['ESAF-helgen', 2, { organizer: 1, speaker: 1, volunteer: 0 }],
      ['Generalforsamling', 1, { organizer: 0, speaker: 0, volunteer: 0 }],
    ])
    expect(groups[0]!.events.map((e) => [e.name, e.role])).toEqual([
      ['Vår 2019', 'organizer'],
      ['ESAF-helgen høst 2018', 'speaker'],
    ])

    await removeEventParticipant(db, admin, autumn, per)
    expect((await audit('event.participant_remove'))[0]!.details).toMatchObject({
      role: 'organizer',
      source: 'admin',
    })
  })
})
