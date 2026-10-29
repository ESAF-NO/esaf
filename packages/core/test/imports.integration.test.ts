import { randomUUID } from 'node:crypto'
import { createDb, loadRootEnv, runMigrations, schema, type Db } from '@esaf/db'
import ExcelJS from 'exceljs'
import { and, eq, ne, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccessDeniedError,
  addCohortRepresentative,
  applyParticipationImport,
  applyRepresentativeImport,
  createEvent,
  createEventType,
  createProfile,
  decideMembership,
  endCohortRepresentative,
  grantRoleAsOperator,
  loadViewer,
  previewParticipationImport,
  previewRepresentativeImport,
  setPersonCohorts,
  type ParticipationDecisions,
  type Viewer,
} from '../src/index.ts'

loadRootEnv()
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

async function xlsx(sheets: Record<string, (string | number | null)[][]>) {
  const wb = new ExcelJS.Workbook()
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name)
    for (const row of rows) ws.addRow(row)
  }
  return new Uint8Array(await wb.xlsx.writeBuffer())
}

const csv = (text: string) => new TextEncoder().encode(text)

describe.skipIf(!url)('import av deltakelse og kullrepresentanter', () => {
  let db: Db
  let admin: Viewer
  let weakAdmin: Viewer
  let ola: Viewer
  let weekendType: string

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

  async function profile(fullName: string, year: number | null, emails: string[] = []) {
    const { personId } = await createProfile(db, admin, {
      fullName,
      cohorts: year ? [{ graduationYear: year, relation: 'student' }] : [],
      emails,
      status: 'active',
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
    const v = await loadViewer(db, await account('Ola'))
    await decideMembership(db, admin, { personId: v!.personId!, decision: 'approve' })
    await setPersonCohorts(db, admin, v!.personId!, [{ graduationYear: 2018, relation: 'student' }])
    ola = await loadViewer(db, v!.userId)
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
  const participation = () =>
    db
      .select({
        name: schema.person.fullName,
        event: schema.event.name,
        role: schema.eventParticipation.role,
        source: schema.eventParticipation.source,
        note: schema.eventParticipation.note,
      })
      .from(schema.eventParticipation)
      .innerJoin(schema.person, eq(schema.person.id, schema.eventParticipation.personId))
      .innerJoin(schema.event, eq(schema.event.id, schema.eventParticipation.eventId))
      .orderBy(schema.event.startDate, schema.person.fullName)

  const weekend = (name: string, startDate: string) =>
    createEvent(db, admin, {
      typeId: weekendType,
      name,
      startDate,
      endDate: null,
      location: '',
      description: '',
    })

  it('bare admins med sterk innlogging kan forhåndsvise og lagre', async () => {
    const data = csv('Navn,Høst 2018\nKari,x\n')
    const reps = csv('Kull,Navn\n2018,Kari\n')
    const input = { data, fileName: 'a.csv', options: {} }
    const decisions = { people: {}, events: {} }
    const calls: [string, (v: Viewer) => Promise<unknown>][] = [
      ['previewParticipationImport', (v) => previewParticipationImport(db, v, input)],
      [
        'applyParticipationImport',
        (v) => applyParticipationImport(db, v, { ...input, decisions, dryRun: true }),
      ],
      [
        'previewRepresentativeImport',
        (v) => previewRepresentativeImport(db, v, { data: reps, fileName: 'r.csv' }),
      ],
      [
        'applyRepresentativeImport',
        (v) =>
          applyRepresentativeImport(db, v, {
            data: reps,
            fileName: 'r.csv',
            decisions: { people: {} },
            dryRun: true,
          }),
      ],
    ]
    for (const [name, call] of calls) {
      expect([name, await denial(call(ola))]).toEqual([name, 'forbidden'])
      expect([name, await denial(call(weakAdmin))]).toEqual([name, 'strong_auth_required'])
      expect([name, await denial(call(admin))]).toEqual([name, 'allowed'])
    }
  })

  it('matrise: forhåndsvisning, prøvekjøring, lagring i én transaksjon og ny import uten duplikater', async () => {
    const { id: autumn } = await weekend('ESAF-helgen høst 2018', '2018-09-14')
    const kari = await profile('Kari Nordmann', 2018, ['kari@example.test'])
    const hansen12 = await profile('Per Hansen', 2012)
    await profile('Per Hansen', 2020)
    const data = await xlsx({
      Ark1: [
        ['Navn', 'E-post', 'Kull', 'Høst 2018', 'Høst 2019'],
        ['Kari N.', 'KARI@example.test', '', 'arr', 'x'],
        ['Per Hansen', '', '', 'x', ''],
        ['Ny Person', 'ny@example.test', 'ES 2019', '', 'foredrag'],
        ['Ola', '', '2018', 'x', 'nei'],
      ],
    })
    const input = { data, fileName: 'helger.xlsx', options: { typeId: weekendType } }

    const preview = await previewParticipationImport(db, admin, input)
    expect(preview).toMatchObject({ layout: 'matrix', typeId: weekendType, entries: 5 })
    expect(preview.events.map((e) => [e.label, e.status, e.by])).toEqual([
      ['Høst 2018', 'matched', 'year'],
      ['Høst 2019', 'missing', null],
    ])
    expect(preview.events[1]!.suggestion).toMatchObject({
      name: 'ESAF-helgen høst 2019',
      startDate: '2019-07-01',
      datePrecision: 'semester',
    })
    expect(preview.people.map((p) => [p.fullName, p.status, p.by])).toEqual([
      ['Kari N.', 'matched', 'email'],
      ['Per Hansen', 'ambiguous', 'name'],
      ['Ny Person', 'unmatched', null],
      ['Ola', 'matched', 'name'],
    ])
    // Forhåndsvisningen lagrer ingenting.
    expect(await db.$count(schema.eventParticipation)).toBe(0)

    const keyOf = (name: string) => preview.people.find((p) => p.fullName === name)!.key
    const decisions: ParticipationDecisions = {
      people: {
        [keyOf('Per Hansen')]: { kind: 'existing', personId: hansen12 },
        [keyOf('Ny Person')]: {
          kind: 'create',
          fullName: 'Ny Person',
          emails: ['ny@example.test'],
          graduationYear: 2019,
          status: 'active',
        },
      },
      events: {
        [preview.events[1]!.key]: {
          kind: 'create',
          typeId: weekendType,
          name: 'ESAF-helgen høst 2019',
          startDate: '2019-09-13',
          endDate: '2019-09-15',
          location: 'Røros',
        },
      },
    }

    const dry = await applyParticipationImport(db, admin, { ...input, decisions, dryRun: true })
    expect(dry).toMatchObject({
      saved: false,
      totals: {
        added: 5,
        updated: 0,
        unchanged: 0,
        skipped: 0,
        profilesCreated: 1,
        eventsCreated: 1,
      },
    })
    expect(await db.$count(schema.eventParticipation)).toBe(0)
    expect(await db.$count(schema.event)).toBe(1)
    expect(await db.$count(schema.person, eq(schema.person.fullName, 'Ny Person'))).toBe(0)
    expect(await audit('event.import')).toHaveLength(0)

    // Ting som bare ble laget i prøvekjøringen, har ingen id.
    expect(dry.events.find((e) => e.created)!.eventId).toBeNull()
    expect(dry.changes.find((c) => c.fullName === 'Ny Person')!.personId).toBeNull()
    const saved = await applyParticipationImport(db, admin, { ...input, decisions, dryRun: false })
    expect(saved).toMatchObject({ saved: true, totals: dry.totals })
    expect(saved.changes.map((c) => [c.fullName, c.eventName, c.to])).toEqual(
      dry.changes.map((c) => [c.fullName, c.eventName, c.to]),
    )
    expect(await participation()).toEqual([
      {
        name: 'Kari Nordmann',
        event: 'ESAF-helgen høst 2018',
        role: 'organizer',
        source: 'import',
        note: null,
      },
      { name: 'Ola', event: 'ESAF-helgen høst 2018', role: null, source: 'import', note: null },
      {
        name: 'Per Hansen',
        event: 'ESAF-helgen høst 2018',
        role: null,
        source: 'import',
        note: null,
      },
      {
        name: 'Kari Nordmann',
        event: 'ESAF-helgen høst 2019',
        role: null,
        source: 'import',
        note: null,
      },
      {
        name: 'Ny Person',
        event: 'ESAF-helgen høst 2019',
        role: 'speaker',
        source: 'import',
        note: null,
      },
    ])
    const [logged] = await audit('event.import')
    expect(logged).toMatchObject({
      actorPersonId: admin!.personId,
      details: {
        fileName: 'helger.xlsx',
        layout: 'matrix',
        added: 5,
        profilesCreated: 1,
        eventsCreated: 1,
      },
    })
    expect((await audit('event.create')).map((e) => e.details.via)).toEqual([undefined, 'import'])
    expect(
      (await audit('profile.create')).find((e) => e.details.fullName === 'Ny Person')!.details,
    ).toMatchObject({
      via: 'event.import',
    })

    // Samme fil igjen: alle finnes, ingen nye rader og ingen logg.
    const again = await previewParticipationImport(db, admin, input)
    expect(again.events.map((e) => e.status)).toEqual(['matched', 'matched'])
    expect(again.people.find((p) => p.fullName === 'Ny Person')!.status).toBe('matched')
    const repeat = await applyParticipationImport(db, admin, {
      ...input,
      decisions: {
        people: { [keyOf('Per Hansen')]: { kind: 'existing', personId: hansen12 } },
        events: {},
      },
      dryRun: false,
    })
    expect(repeat.totals).toEqual({
      added: 0,
      updated: 0,
      unchanged: 5,
      skipped: 0,
      profilesCreated: 0,
      eventsCreated: 0,
    })
    expect(await audit('event.import')).toHaveLength(1)
    expect(await db.$count(schema.eventParticipation)).toBe(5)

    // Ny rolle i arket er en endring; «x» tar ikke bort en rolle som står.
    const changed = await xlsx({
      Ark1: [
        ['Navn', 'E-post', 'Høst 2018'],
        ['Kari', 'kari@example.test', 'x'],
        ['Ola', '', 'frivillig'],
      ],
    })
    const plan = await applyParticipationImport(db, admin, {
      data: changed,
      fileName: 'endret.xlsx',
      options: {},
      decisions: { people: {}, events: {} },
      dryRun: false,
    })
    expect(plan.totals).toMatchObject({ added: 0, updated: 1, unchanged: 1 })
    expect(plan.changes).toEqual([
      {
        personId: ola!.personId,
        fullName: 'Ola',
        eventName: 'ESAF-helgen høst 2018',
        kind: 'update',
        from: null,
        to: 'volunteer',
        note: false,
      },
    ])
    expect((await participation()).find((r) => r.name === 'Kari Nordmann')!.role).toBe('organizer')
    void kari
    void autumn
  })

  it('én fane per arrangement og lang liste lagres, og personer og arrangementer kan hoppes over', async () => {
    await weekend('ESAF-helgen vår 2019', '2019-04-05')
    const { id: gfType } = await createEventType(db, admin, {
      name: 'Generalforsamling',
      plural: 'Generalforsamlinger',
      description: '',
      sortOrder: 10,
    })
    const { id: gf } = await createEvent(db, admin, {
      typeId: gfType,
      name: 'Generalforsamling 2024',
      startDate: '2024-03-14',
      endDate: null,
      location: '',
      description: '',
    })
    await profile('Kari Nordmann', 2018, ['kari@example.test'])

    const sheets = await xlsx({
      'Vår 2019': [
        ['Navn', 'Rolle', 'Notat'],
        ['Kari Nordmann', 'Arrangør', 'Hovedansvar'],
        ['Ola', '', ''],
      ],
      Ukjent: [['Navn'], ['Ola']],
    })
    const sp = await previewParticipationImport(db, admin, {
      data: sheets,
      fileName: 's.xlsx',
      options: {},
    })
    expect(sp.layout).toBe('sheets')
    expect(sp.events.map((e) => [e.label, e.status])).toEqual([
      ['Vår 2019', 'matched'],
      ['Ukjent', 'missing'],
    ])
    // Det manglende arrangementet hoppes over som standard, og Ola på den fanen telles som hoppet over.
    const sr = await applyParticipationImport(db, admin, {
      data: sheets,
      fileName: 's.xlsx',
      options: {},
      decisions: { people: {}, events: {} },
      dryRun: false,
    })
    expect(sr.totals).toMatchObject({ added: 2, skipped: 1 })
    expect((await participation()).map((r) => [r.name, r.role, r.note])).toEqual([
      ['Kari Nordmann', 'organizer', 'Hovedansvar'],
      ['Ola', null, null],
    ])

    const long = csv(
      'Navn;E-post;Arrangement;Dato;Rolle\nKari Nordmann;kari@example.test;Generalforsamling;14.03.2024;Taler\nOla;;Generalforsamling;14.03.2024;\nUkjent Person;;Generalforsamling;14.03.2024;\n',
    )
    const lp = await previewParticipationImport(db, admin, {
      data: long,
      fileName: 'gf.csv',
      options: {},
    })
    expect(lp.layout).toBe('long')
    // Matches mot ESAF-helgen som standard, så generalforsamlingen må velges for hånd …
    expect(lp.events[0]!.status).toBe('missing')
    // … eller finnes på datoen når typen er valgt.
    const typed = await previewParticipationImport(db, admin, {
      data: long,
      fileName: 'gf.csv',
      options: { typeId: gfType },
    })
    expect(typed.events.map((e) => [e.status, e.by, e.candidates[0]?.id])).toEqual([
      ['matched', 'date', gf],
    ])
    const ukjent = lp.people.find((p) => p.fullName === 'Ukjent Person')!
    const lr = await applyParticipationImport(db, admin, {
      data: long,
      fileName: 'gf.csv',
      options: {},
      decisions: {
        events: { [lp.events[0]!.key]: { kind: 'existing', eventId: gf } },
        people: { [ukjent.key]: { kind: 'skip' } },
      },
      dryRun: false,
    })
    expect(lr.totals).toMatchObject({ added: 2, skipped: 1 })
    expect(
      (await participation())
        .filter((r) => r.event === 'Generalforsamling 2024')
        .map((r) => [r.name, r.role]),
    ).toEqual([
      ['Kari Nordmann', 'speaker'],
      ['Ola', null],
    ])
  })

  it('arrangementer som ikke har startet, og ugyldige nye arrangementer, stopper hele importen', async () => {
    const next = `${new Date().getFullYear() + 1}-09-01`
    const { id: future } = await weekend('Neste helg', next)
    const data = csv('Navn,Neste helg\nOla,x\n')
    const input = { data, fileName: 'n.csv', options: {} }
    const preview = await previewParticipationImport(db, admin, input)
    expect(preview.events[0]!.candidates[0]).toMatchObject({ id: future, upcoming: true })
    await expect(
      applyParticipationImport(db, admin, {
        ...input,
        decisions: { people: {}, events: {} },
        dryRun: false,
      }),
    ).rejects.toThrow(/ikke startet/)
    await expect(
      applyParticipationImport(db, admin, {
        ...input,
        decisions: {
          people: {},
          events: {
            [preview.events[0]!.key]: {
              kind: 'create',
              typeId: weekendType,
              name: 'Ny',
              startDate: '2018-02-30',
              endDate: null,
              location: '',
            },
          },
        },
        dryRun: false,
      }),
    ).rejects.toThrow(/Ugyldig dato|minst 3 tegn/)
    expect(await db.$count(schema.eventParticipation)).toBe(0)
    expect(await db.$count(schema.event)).toBe(1)
  })

  it('kullrepresentanter: forhåndsvisning, lagring, ny import og endringer', async () => {
    const kari = await profile('Kari Nordmann', 2019, ['kari@example.test'])
    const siri = await profile('Siri Berg', 2016)
    const { id: old } = await addCohortRepresentative(db, admin, {
      graduationYear: 2016,
      personId: siri,
      startYear: 2016,
      note: 'Fra før',
    })
    await endCohortRepresentative(db, admin, old, { endYear: 2018 })
    const data = await xlsx({
      Representanter: [
        ['Kull', 'Navn', 'E-post', 'Fra', 'Til', 'Notat'],
        ['ES 2019', 'Kari', 'kari@example.test', 2019, null, 'Valgt på samlingen'],
        ['2016', 'Siri Berg', null, 2016, 2019, null],
        ['2018', 'Ola', null, null, null, null],
        ['2020', 'Ny Representant', 'ny@example.test', 2021, null, null],
      ],
    })
    const input = { data, fileName: 'reps.xlsx' }
    const preview = await previewRepresentativeImport(db, admin, input)
    expect(preview.people.map((p) => [p.fullName, p.status])).toEqual([
      ['Kari', 'matched'],
      ['Siri Berg', 'matched'],
      ['Ola', 'matched'],
      ['Ny Representant', 'unmatched'],
    ])
    const ny = preview.people.at(-1)!.key
    const decisions = {
      people: {
        [ny]: {
          kind: 'create' as const,
          fullName: 'Ny Representant',
          emails: ['ny@example.test'],
          graduationYear: 2020,
          status: 'active' as const,
        },
      },
    }
    const dry = await applyRepresentativeImport(db, admin, { ...input, decisions, dryRun: true })
    expect(dry.totals).toEqual({
      added: 3,
      updated: 1,
      unchanged: 0,
      skipped: 0,
      profilesCreated: 1,
    })
    expect(await db.$count(schema.cohortRepresentative)).toBe(1)

    expect(dry.changes.find((c) => c.fullName === 'Ny Representant')!.personId).toBeNull()
    const saved = await applyRepresentativeImport(db, admin, { ...input, decisions, dryRun: false })
    expect(saved).toMatchObject({ saved: true, totals: dry.totals })
    expect(
      saved.changes.map((c) => [c.fullName, c.graduationYear, c.kind, c.from, c.to, c.otherCohort]),
    ).toEqual([
      ['Ny Representant', 2020, 'add', null, { startYear: 2021, endYear: null }, false],
      ['Kari Nordmann', 2019, 'add', null, { startYear: 2019, endYear: null }, false],
      ['Ola', 2018, 'add', null, { startYear: null, endYear: null }, false],
      [
        'Siri Berg',
        2016,
        'update',
        { startYear: 2016, endYear: 2018 },
        { startYear: 2016, endYear: 2019 },
        false,
      ],
    ])
    const rows = await db.select().from(schema.cohortRepresentative)
    expect(rows.find((r) => r.personId === kari)).toMatchObject({
      startYear: 2019,
      endYear: null,
      note: 'Valgt på samlingen',
    })
    // Et tomt notat i arket fjerner ikke notatet som står.
    expect(rows.find((r) => r.personId === siri)).toMatchObject({ endYear: 2019, note: 'Fra før' })
    expect((await audit('cohort.rep_import'))[0]!.details).toMatchObject({
      added: 3,
      updated: 1,
      profilesCreated: 1,
    })

    // Samme fil igjen: ingenting endres, og ingenting logges.
    const again = await applyRepresentativeImport(db, admin, {
      ...input,
      decisions: { people: {} },
      dryRun: false,
    })
    expect(again.totals).toEqual({
      added: 0,
      updated: 0,
      unchanged: 4,
      skipped: 0,
      profilesCreated: 0,
    })
    expect(await audit('cohort.rep_import')).toHaveLength(1)

    // Avslutte et verv fra arket, og en representant fra et annet kull merkes.
    const later = await xlsx({
      Ark1: [
        ['Kull', 'Navn', 'Periode'],
        ['2019', 'Kari Nordmann', '2019–2025'],
        ['2017', 'Kari Nordmann', 'siden 2024'],
      ],
    })
    const plan = await applyRepresentativeImport(db, admin, {
      data: later,
      fileName: 'reps2.xlsx',
      decisions: { people: {} },
      dryRun: false,
    })
    expect(plan.changes.map((c) => [c.graduationYear, c.kind, c.to, c.otherCohort])).toEqual([
      [2019, 'update', { startYear: 2019, endYear: 2025 }, false],
      [2017, 'add', { startYear: 2024, endYear: null }, true],
    ])
    expect(
      await db.$count(
        schema.cohortRepresentative,
        and(eq(schema.cohortRepresentative.personId, kari)),
      ),
    ).toBe(2)
  })
})
