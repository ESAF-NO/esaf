import { randomUUID } from 'node:crypto'
import { createDb, loadRootEnv, runMigrations, schema, type Db } from '@esaf/db'
import { eq, ne, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccessDeniedError,
  createEvent,
  createEventHistory,
  decideMembership,
  getEvent,
  getEventTypeOverview,
  grantRoleAsOperator,
  listEventTypes,
  loadViewer,
  previewEventHistory,
  updateEvent,
  type Viewer,
} from '../src/index.ts'

loadRootEnv()
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

describe.skipIf(!url)('historiske arrangementer', () => {
  let db: Db
  let admin: Viewer
  let weakAdmin: Viewer
  let ola: Viewer
  let weekendType = ''

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

  beforeEach(async () => {
    await db.execute(
      sql`truncate ${schema.event}, ${schema.auditEvent}, ${schema.membership}, ${schema.personCohort}, ${schema.person}, ${schema.cohort}, ${schema.user} cascade`,
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

  const range = (patch: Partial<Parameters<typeof previewEventHistory>[2]> = {}) => ({
    typeId: weekendType,
    fromYear: 2008,
    toYear: 2010,
    frequency: 'autumn' as const,
    ...patch,
  })

  it('bare sterkt innloggede admins ser forhåndsvisningen og legger inn historikk', async () => {
    const items = [{ year: 2008, period: 'autumn' as const }]
    for (const v of [weakAdmin]) {
      expect(await denial(previewEventHistory(db, v, range()))).toBe('strong_auth_required')
      expect(
        await denial(createEventHistory(db, v, { typeId: weekendType, items, location: '' })),
      ).toBe('strong_auth_required')
    }
    expect(await denial(previewEventHistory(db, ola, range()))).toBe('forbidden')
    expect(
      await denial(createEventHistory(db, ola, { typeId: weekendType, items, location: '' })),
    ).toBe('forbidden')
    expect(await denial(previewEventHistory(db, null, range()))).toBe('unauthenticated')
    expect(await db.$count(schema.event)).toBe(0)

    // Admin-verktøyene skjules for en svak økt, og siden sier det (canManage er false).
    expect((await listEventTypes(db, weakAdmin)).canManage).toBe(false)
    expect((await listEventTypes(db, admin)).canManage).toBe(true)
  })

  it('forhåndsviser, oppretter med semester, og hopper over navn som finnes', async () => {
    // Et arrangement med samme navn finnes, og et annet i høsten 2010.
    await createEvent(db, admin, {
      typeId: weekendType,
      name: 'esaf-helgen  HØST 2009',
      startDate: '2009-09-11',
      endDate: '2009-09-13',
      location: '',
      description: '',
    })
    await createEvent(db, admin, {
      typeId: weekendType,
      name: 'Høstsamlingen 2010',
      startDate: '2010-10-01',
      endDate: null,
      location: '',
      description: '',
    })

    const preview = await previewEventHistory(db, admin, range({ frequency: 'both' }))
    expect(preview.rows.map((r) => [r.name, r.status])).toEqual([
      ['ESAF-helgen vår 2008', 'new'],
      ['ESAF-helgen høst 2008', 'new'],
      ['ESAF-helgen vår 2009', 'new'],
      ['ESAF-helgen høst 2009', 'exists'],
      ['ESAF-helgen vår 2010', 'new'],
      ['ESAF-helgen høst 2010', 'overlap'],
    ])
    expect(preview.rows[1]).toMatchObject({ startDate: '2008-07-01', datePrecision: 'semester' })
    // Forhåndsvisningen lagrer ingenting.
    expect(await db.$count(schema.event)).toBe(2)

    const items = preview.rows.map((r) => ({ year: r.year, period: r.period }))
    const first = await createEventHistory(db, admin, {
      typeId: weekendType,
      items,
      location: 'Trondheim',
    })
    // Det med samme navn hoppes over; det i samme periode lages når admin velger det.
    expect(first.created.map((c) => c.name)).toEqual([
      'ESAF-helgen vår 2008',
      'ESAF-helgen høst 2008',
      'ESAF-helgen vår 2009',
      'ESAF-helgen vår 2010',
      'ESAF-helgen høst 2010',
    ])
    expect(first.skipped).toEqual(['ESAF-helgen høst 2009'])
    expect(first.typeSlug).toBe('esaf-helgen')

    // Samme valg en gang til gir ingen duplikater.
    const again = await createEventHistory(db, admin, {
      typeId: weekendType,
      items,
      location: 'Trondheim',
    })
    expect(again.created).toEqual([])
    expect(again.skipped).toHaveLength(6)
    expect(await db.$count(schema.event)).toBe(7)
    expect(
      (await previewEventHistory(db, admin, range({ frequency: 'both' }))).rows.every(
        (r) => r.status === 'exists',
      ),
    ).toBe(true)

    const [stored] = await db
      .select()
      .from(schema.event)
      .where(eq(schema.event.name, 'ESAF-helgen høst 2008'))
    expect(stored).toMatchObject({
      startDate: '2008-07-01',
      endDate: null,
      datePrecision: 'semester',
      location: 'Trondheim',
    })

    // Hvert arrangement logges, og hele innleggingen én gang; ingenting når ingenting ble laget.
    const created = await audit('event.create')
    expect(created.filter((a) => a.details.via === 'history')).toHaveLength(5)
    const history = await audit('event.history')
    expect(history).toHaveLength(1)
    expect(history[0]!.details).toMatchObject({
      slug: 'esaf-helgen',
      typeName: 'ESAF-helgen',
      created: 5,
      skipped: 1,
      fromYear: 2008,
      toYear: 2010,
    })
  })

  it('én gang i året gir bare årstall, og et arrangement med årstall dekker begge semestrene', async () => {
    const { created } = await createEventHistory(db, admin, {
      typeId: weekendType,
      items: [
        { year: 2015, period: 'year' },
        { year: 2014, period: 'year' },
      ],
      location: '',
    })
    expect(created.map((c) => c.name)).toEqual(['ESAF-helgen 2014', 'ESAF-helgen 2015'])
    const event = await getEvent(db, admin, created[1]!.id)
    expect(event).toMatchObject({ startDate: '2015-01-01', datePrecision: 'year', upcoming: false })

    const preview = await previewEventHistory(
      db,
      admin,
      range({ fromYear: 2015, toYear: 2015, frequency: 'both' }),
    )
    expect(preview.rows.map((r) => [r.name, r.status, r.existing?.name])).toEqual([
      ['ESAF-helgen vår 2015', 'overlap', 'ESAF-helgen 2015'],
      ['ESAF-helgen høst 2015', 'overlap', 'ESAF-helgen 2015'],
    ])
  })

  it('avviser perioder som ikke har vært, og for mange på én gang', async () => {
    const next = Number(new Date().getFullYear()) + 1
    const preview = await previewEventHistory(
      db,
      admin,
      range({ fromYear: next, toYear: next, frequency: 'spring' }),
    )
    expect(preview.rows[0]!.status).toBe('future')
    await expect(
      createEventHistory(db, admin, {
        typeId: weekendType,
        items: [{ year: next, period: 'spring' }],
        location: '',
      }),
    ).rejects.toThrow('har ikke vært ennå')
    await expect(
      previewEventHistory(db, admin, range({ fromYear: 1990, toYear: 2060, frequency: 'both' })),
    ).rejects.toThrow('Høyst 100')
    await expect(
      previewEventHistory(db, admin, range({ fromYear: 2012, toYear: 2010 })),
    ).rejects.toThrow('Fra-året')
    expect(await db.$count(schema.event)).toBe(0)
    expect(await audit('event.history')).toHaveLength(0)
  })

  it('datopresisjon: semester og år lagres som første dag i perioden, uten sluttdato', async () => {
    const { id } = await createEvent(db, admin, {
      typeId: weekendType,
      name: 'ESAF-helgen høst 2018',
      startDate: '2018-10-12',
      endDate: '2018-10-14',
      datePrecision: 'semester',
      location: '',
      description: '',
    })
    expect(await getEvent(db, admin, id)).toMatchObject({
      startDate: '2018-07-01',
      endDate: null,
      datePrecision: 'semester',
    })
    await updateEvent(db, admin, id, {
      typeId: weekendType,
      name: 'ESAF-helgen 2018',
      startDate: '2018-07-01',
      endDate: null,
      datePrecision: 'year',
      location: '',
      description: '',
    })
    const [edited] = await audit('event.edit')
    expect(edited!.details.fields).toEqual(['name', 'startDate', 'datePrecision'])
    const overview = await getEventTypeOverview(db, ola, 'esaf-helgen')
    expect(overview.events[0]).toMatchObject({ startDate: '2018-01-01', datePrecision: 'year' })

    // Vanlige arrangementer har dato som før.
    const { id: day } = await createEvent(db, admin, {
      typeId: weekendType,
      name: 'ESAF-helgen vår 2019',
      startDate: '2019-04-05',
      endDate: '2019-04-07',
      location: '',
      description: '',
    })
    expect(await getEvent(db, admin, day)).toMatchObject({
      startDate: '2019-04-05',
      endDate: '2019-04-07',
      datePrecision: 'day',
    })
    // Databasen godtar ikke en presisjon som ikke passer datoen.
    await expect(
      db.update(schema.event).set({ datePrecision: 'semester' }).where(eq(schema.event.id, day)),
    ).rejects.toThrow()
  })
})
