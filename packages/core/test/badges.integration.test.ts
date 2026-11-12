import { randomUUID } from 'node:crypto'
import { createDb, loadRootEnv, runMigrations, schema, type Db } from '@esaf/db'
import { and, eq, ne, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccessDeniedError,
  addEventParticipants,
  addOwnParticipations,
  awardBadge,
  communityOverview,
  createBadge,
  createEvent,
  createEventType,
  deleteEvent,
  deleteEventType,
  createProfile,
  decideMembership,
  deleteBadge,
  getBadgeForAdmin,
  getProfile,
  grantRoleAsOperator,
  listBadgesForAdmin,
  listMissedEvents,
  listNotifications,
  loadViewer,
  mergePeople,
  previewBadgeRule,
  removeEventParticipant,
  revokeBadge,
  setBadgeStatus,
  setOwnBadgeHidden,
  setPersonCohorts,
  syncBadges,
  updateBadge,
  type BadgeInput,
  type ObjectStorage,
  type Viewer,
} from '../src/index.ts'

loadRootEnv()
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

const storage: ObjectStorage = {
  put: () => Promise.resolve(),
  get: () => Promise.resolve(null),
  delete: () => Promise.resolve(),
}

describe.skipIf(!url)('merker', () => {
  let db: Db
  let admin: Viewer
  let weakAdmin: Viewer
  let ola: Viewer
  let kari: Viewer
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

  async function member(name: string, year: number) {
    const v = await loadViewer(db, await account(name))
    await decideMembership(db, admin, { personId: v!.personId!, decision: 'approve' })
    await setPersonCohorts(db, admin, v!.personId!, [{ graduationYear: year, relation: 'student' }])
    return loadViewer(db, v!.userId)
  }

  async function weekend(startDate: string) {
    const { id } = await createEvent(db, admin, {
      typeId: weekendType,
      name: `ESAF-helgen ${startDate}`,
      startDate,
      endDate: null,
      location: null,
      description: null,
    })
    return id
  }

  async function attend(eventId: string, ...people: Viewer[]) {
    await addEventParticipants(db, admin, eventId, {
      personIds: people.map((p) => p!.personId!),
      source: 'admin',
    })
  }

  const badgeFields = (patch: Partial<BadgeInput> = {}): BadgeInput => ({
    name: 'ESAF-helgen ×2',
    description: 'Vært på to ESAF-helger.',
    icon: 'tent',
    color: 'brand',
    rule: { kind: 'event_count', eventTypeId: weekendType, count: 2 },
    ...patch,
  })

  beforeEach(async () => {
    await db.execute(
      sql`truncate ${schema.badge}, ${schema.event}, ${schema.notification}, ${schema.auditEvent}, ${schema.membership}, ${schema.personCohort}, ${schema.person}, ${schema.cohort}, ${schema.user} cascade`,
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

  const awards = (badgeId: string) =>
    db
      .select({ personId: schema.badgeAward.personId, achievedOn: schema.badgeAward.achievedOn })
      .from(schema.badgeAward)
      .where(eq(schema.badgeAward.badgeId, badgeId))

  /** Merkene på profilen til personen, slik `v` ser dem. */
  const badgesOn = async (v: Viewer, personId: string) => (await getProfile(db, v, personId)).badges

  /** Merker gir aldri varsler: de dukker bare opp på profilen. */
  const notifications = async (v: Viewer) => (await listNotifications(db, v)).items

  it('bare admins med sterk innlogging lager og deler ut merker; medlemmer ser dem', async () => {
    const { id } = await createBadge(db, admin, badgeFields())
    const calls: [string, (v: Viewer) => Promise<unknown>][] = [
      ['createBadge', (v) => createBadge(db, v, badgeFields({ name: 'Annet' }))],
      ['updateBadge', (v) => updateBadge(db, v, id, { name: 'Nytt' })],
      ['setBadgeStatus', (v) => setBadgeStatus(db, v, id, 'published')],
      ['deleteBadge', (v) => deleteBadge(db, storage, v, id)],
      ['previewBadgeRule', (v) => previewBadgeRule(db, v, { kind: 'manual' })],
      ['listBadgesForAdmin', (v) => listBadgesForAdmin(db, v)],
      ['awardBadge', (v) => awardBadge(db, v, id, { personIds: [ola!.personId!] })],
    ]
    for (const [name, call] of calls) {
      expect([name, await denial(call(ola))]).toEqual([name, 'forbidden'])
      expect([name, await denial(call(weakAdmin))]).toEqual([name, 'strong_auth_required'])
      expect([name, await denial(call(null))]).toEqual([name, 'unauthenticated'])
    }
    expect(await badgesOn(ola, ola!.personId!)).toEqual([])
  })

  it('utkast forhåndsvises; publisering deler ut merket og viser det på profilen, uten varsel', async () => {
    const [w1, w2, w3] = [
      await weekend('2018-09-07'),
      await weekend('2019-09-06'),
      await weekend('2020-09-04'),
    ]
    await attend(w1, ola, kari)
    await attend(w2, ola)
    await attend(w3, ola)
    const { id, slug, status } = await createBadge(db, admin, badgeFields())
    expect(status).toBe('draft')
    expect(slug).toBe('esaf-helgen-2')

    const preview = await previewBadgeRule(db, admin, {
      kind: 'event_count',
      eventTypeId: weekendType,
      count: 2,
    })
    expect(preview).toMatchObject({
      ruleText: 'Vært på ESAF-helgen minst 2 ganger',
      total: 1,
      activeMembers: 1,
    })
    expect(preview.sample[0]).toMatchObject({ fullName: 'Ola', achievedOn: '2019-09-06' })

    // Utkastet er ikke delt ut og vises ikke for medlemmer.
    expect(await awards(id)).toEqual([])
    expect(await badgesOn(ola, ola!.personId!)).toEqual([])

    await setBadgeStatus(db, admin, id, 'published')
    expect(await awards(id)).toEqual([{ personId: ola!.personId, achievedOn: '2019-09-06' }])
    expect(await badgesOn(kari, ola!.personId!)).toMatchObject([
      {
        slug,
        achievedOn: '2019-09-06',
        holders: 1,
        ruleText: 'Vært på ESAF-helgen minst 2 ganger',
      },
    ])
    expect(await notifications(ola)).toEqual([])
    expect((await db.select().from(schema.auditEvent)).map((e) => e.action)).toEqual(
      expect.arrayContaining(['badge.create', 'badge.publish']),
    )
  })

  it('merket følger dataene: rettes de, mistes merket; ny regel deler ut på nytt', async () => {
    const [w1, w2] = [await weekend('2018-09-07'), await weekend('2019-09-06')]
    await attend(w1, ola, kari)
    await attend(w2, ola, kari)
    const { id } = await createBadge(db, admin, badgeFields(), { publish: true })
    expect(await awards(id)).toHaveLength(2)

    await removeEventParticipant(db, admin, w2, kari!.personId!)
    await syncBadges(db)
    expect((await awards(id)).map((a) => a.personId)).toEqual([ola!.personId])

    await updateBadge(db, admin, id, {
      rule: { kind: 'event_count', eventTypeId: weekendType, count: 1 },
    })
    expect(await awards(id)).toHaveLength(2)

    await expect(
      updateBadge(db, admin, id, {
        rule: { kind: 'event_count', eventTypeId: randomUUID(), count: 1 },
      }),
    ).rejects.toThrow('Fant ikke arrangementstypen.')
    await expect(updateBadge(db, admin, id, { rule: { kind: 'manual' } })).rejects.toThrow(
      'kan ikke gjøres om',
    )
  })

  it('merker for hånd: begrunnelsen vises på profilen, og merket kan tas tilbake', async () => {
    const { id, slug } = await createBadge(
      db,
      admin,
      badgeFields({ name: 'Ildsjel', icon: 'flame', rule: { kind: 'manual' } }),
    )
    await awardBadge(db, admin, id, {
      personIds: [ola!.personId!],
      citation: 'For innsatsen med ESAF-helgen 2024',
    })
    // Utkast vises ikke, heller ikke delt ut for hånd.
    expect(await badgesOn(kari, ola!.personId!)).toEqual([])
    await setBadgeStatus(db, admin, id, 'published')
    expect(await badgesOn(kari, ola!.personId!)).toMatchObject([
      { slug, citation: 'For innsatsen med ESAF-helgen 2024', ruleText: 'Deles ut av styret' },
    ])
    expect(await notifications(ola)).toEqual([])

    // Regelen tar ikke merker delt ut for hånd.
    await syncBadges(db)
    expect(await awards(id)).toHaveLength(1)

    await revokeBadge(db, admin, id, { personIds: [ola!.personId!] })
    expect(await awards(id)).toEqual([])
    const log = await db
      .select({ action: schema.auditEvent.action, subject: schema.auditEvent.subjectPersonId })
      .from(schema.auditEvent)
      .where(sql`${schema.auditEvent.action} in ('badge.award', 'badge.revoke')`)
    expect(log).toEqual([
      { action: 'badge.award', subject: ola!.personId },
      { action: 'badge.revoke', subject: ola!.personId },
    ])

    // Merker med regel kan ikke deles ut for hånd.
    const { id: auto } = await createBadge(db, admin, badgeFields({ name: 'Auto' }))
    await expect(awardBadge(db, admin, auto, { personIds: [kari!.personId!] })).rejects.toThrow(
      'deles ut etter regelen',
    )
  })

  it('egne merker kan skjules; i en serie vises bare det høyeste trinnet', async () => {
    const [w1, w2] = [await weekend('2018-09-07'), await weekend('2019-09-06')]
    await attend(w1, ola)
    await attend(w2, ola)
    const one = await createBadge(
      db,
      admin,
      badgeFields({
        name: 'ESAF-helgen ×1',
        series: 'ESAF-helgen',
        sortOrder: 1,
        rule: { kind: 'event_count', eventTypeId: weekendType, count: 1 },
      }),
      { publish: true },
    )
    const two = await createBadge(db, admin, badgeFields({ series: 'ESAF-helgen', sortOrder: 2 }), {
      publish: true,
    })
    expect((await getProfile(db, kari, ola!.personId!)).badges.map((b) => b.slug)).toEqual([
      two.slug,
    ])

    await setOwnBadgeHidden(db, ola, two.id, true)
    // Andre ser neste trinn; Ola ser begge, med det skjulte merket.
    expect((await getProfile(db, kari, ola!.personId!)).badges.map((b) => b.slug)).toEqual([
      one.slug,
    ])
    expect((await getProfile(db, ola, ola!.personId!)).badges).toMatchObject([
      { slug: two.slug, hidden: true },
    ])
    await expect(setOwnBadgeHidden(db, kari, two.id, true)).rejects.toThrow(
      'Du har ikke dette merket.',
    )
  })

  it('«Var du der?» viser helgene fra kullet startet, og gir merket med en gang', async () => {
    const old = await weekend('2010-09-03')
    const [w1, w2] = [await weekend('2017-09-01'), await weekend('2018-09-07')]
    const future = await weekend('2099-09-04')
    await attend(w1, kari)
    const { id } = await createBadge(db, admin, badgeFields(), { publish: true })

    const groups = await listMissedEvents(db, ola)
    expect(groups).toHaveLength(1)
    // Ola er ES 2018 og startet høsten 2016: ikke 2010, ikke framtiden.
    expect(groups[0]!.events.map((e) => e.id)).toEqual([w2, w1])
    expect(groups[0]!.events.find((e) => e.id === w1)).toMatchObject({
      participants: 1,
      fromCohort: 0,
    })

    const result = await addOwnParticipations(db, ola, { eventIds: [w1, w2] })
    expect(result).toMatchObject({
      added: 2,
      badges: [{ id, name: 'ESAF-helgen ×2' }],
      // Én av tre aktive har merket (uvanlig, 40 XP): nok til nivå 2.
      level: { level: 2, xp: 40 },
      previousLevel: 1,
    })
    expect(await listMissedEvents(db, ola)).toEqual([])
    await expect(addOwnParticipations(db, ola, { eventIds: [future] })).rejects.toThrow(
      'som har vært',
    )
    expect(old).toBeTruthy()
  })

  it('arkiverte merker vises ikke; sletting fjerner merket', async () => {
    const w1 = await weekend('2018-09-07')
    await attend(w1, ola)
    const { id, slug } = await createBadge(
      db,
      admin,
      badgeFields({ rule: { kind: 'event_count', eventTypeId: weekendType, count: 1 } }),
      { publish: true },
    )
    await setBadgeStatus(db, admin, id, 'archived')
    expect(await badgesOn(ola, ola!.personId!)).toEqual([])
    // Admins ser fortsatt hvem som hadde det.
    expect((await getBadgeForAdmin(db, admin, slug)).awards).toHaveLength(1)

    await deleteBadge(db, storage, admin, id)
    expect(await db.select().from(schema.badgeAward)).toEqual([])
  })

  it('sammenslåing tar med merker delt ut for hånd, og regner ut resten på nytt', async () => {
    const duplicate = (
      await createProfile(db, admin, {
        fullName: 'Ola Dobbel',
        cohorts: [{ graduationYear: 2018, relation: 'student' }],
        emails: [],
        status: 'active',
      })
    ).personId
    const w1 = await weekend('2018-09-07')
    await addEventParticipants(db, admin, w1, { personIds: [duplicate], source: 'admin' })
    const manual = await createBadge(
      db,
      admin,
      badgeFields({ name: 'Ildsjel', rule: { kind: 'manual' } }),
      { publish: true },
    )
    await awardBadge(db, admin, manual.id, { personIds: [duplicate], citation: 'Hjalp til' })
    const auto = await createBadge(
      db,
      admin,
      badgeFields({ rule: { kind: 'event_count', eventTypeId: weekendType, count: 1 } }),
      { publish: true },
    )
    expect((await awards(auto.id)).map((a) => a.personId)).toEqual([duplicate])

    await mergePeople(db, storage, admin, { sourceId: duplicate, targetId: ola!.personId! })
    expect(await awards(manual.id)).toMatchObject([{ personId: ola!.personId }])
    expect(await awards(auto.id)).toMatchObject([{ personId: ola!.personId }])
    const [kept] = await db
      .select({ citation: schema.badgeAward.citation })
      .from(schema.badgeAward)
      .where(
        and(
          eq(schema.badgeAward.badgeId, manual.id),
          eq(schema.badgeAward.personId, ola!.personId!),
        ),
      )
    expect(kept?.citation).toBe('Hjalp til')
  })

  it('slettede arrangementer og typer: merket kan fortsatt deles ut og rettes', async () => {
    const [a, b] = [await weekend('2018-09-07'), await weekend('2019-09-06')]
    await attend(a, ola)
    const { id } = await createBadge(
      db,
      admin,
      badgeFields({
        name: 'Begge',
        rule: { kind: 'event_attended', eventIds: [a, b], match: 'all' },
      }),
      { publish: true },
    )
    expect(await awards(id)).toEqual([])
    // Arrangementet Ola ikke var på, slettes: da er «alle» det ene som er igjen.
    await deleteEvent(db, admin, b)
    await syncBadges(db)
    expect((await awards(id)).map((x) => x.personId)).toEqual([ola!.personId])
    await updateBadge(db, admin, id, { description: 'Var på den første helgen.' })
    const [stored] = await db.select().from(schema.badge).where(eq(schema.badge.id, id))
    expect(stored!.rule).toMatchObject({ eventIds: [a] })

    // En type et merke bruker, kan ikke slettes.
    const type = await createEventType(db, admin, {
      name: 'Fagkveld',
      plural: null,
      description: null,
      sortOrder: 100,
    })
    await createBadge(
      db,
      admin,
      badgeFields({
        name: 'Fagkveld',
        rule: { kind: 'event_count', eventTypeId: type.id, count: 1 },
      }),
    )
    await expect(deleteEventType(db, admin, type.id)).rejects.toThrow('Merket «Fagkveld» bruker')
  })

  it('i en serie med lik rekkefølge vises trinnet som krever mest', async () => {
    for (const d of ['2017-09-01', '2018-09-07', '2019-09-06']) await attend(await weekend(d), ola)
    for (const count of [3, 1, 2]) {
      await createBadge(
        db,
        admin,
        badgeFields({
          name: `Helg ${count}`,
          series: 'ESAF-helgen',
          rule: { kind: 'event_count', eventTypeId: weekendType, count },
        }),
        { publish: true },
      )
    }
    expect((await getProfile(db, kari, ola!.personId!)).badges.map((b) => b.name)).toEqual([
      'Helg 3',
    ])
  })

  it('å dele ut på nytt uten begrunnelse beholder den gamle', async () => {
    const { id } = await createBadge(
      db,
      admin,
      badgeFields({ name: 'Ildsjel', rule: { kind: 'manual' } }),
      { publish: true },
    )
    await awardBadge(db, admin, id, { personIds: [ola!.personId!], citation: 'For innsatsen 2024' })
    expect(
      await awardBadge(db, admin, id, { personIds: [ola!.personId!, kari!.personId!] }),
    ).toEqual({ awarded: 1, updated: 0 })
    const rows = await db
      .select({ personId: schema.badgeAward.personId, citation: schema.badgeAward.citation })
      .from(schema.badgeAward)
    expect(rows).toEqual(
      expect.arrayContaining([
        { personId: ola!.personId, citation: 'For innsatsen 2024' },
        { personId: kari!.personId, citation: null },
      ]),
    )
    await awardBadge(db, admin, id, { personIds: [ola!.personId!], citation: 'For alt i 2025' })
    const actions = (
      await db
        .select({ action: schema.auditEvent.action })
        .from(schema.auditEvent)
        .where(
          sql`${schema.auditEvent.action} like 'badge.%' and ${schema.auditEvent.subjectPersonId} is not null`,
        )
    ).map((r) => r.action)
    expect(actions.sort()).toEqual(['badge.award', 'badge.award', 'badge.citation'])
  })

  it('sammenslåing beholder merker på arkiverte merker', async () => {
    const duplicate = (
      await createProfile(db, admin, {
        fullName: 'Kari Dobbel',
        cohorts: [{ graduationYear: 2019, relation: 'student' }],
        emails: [],
        status: 'active',
      })
    ).personId
    await attend(await weekend('2018-09-07'), { ...kari!, personId: duplicate })
    const rule = { kind: 'event_count' as const, eventTypeId: weekendType, count: 1 }
    const archived = await createBadge(db, admin, badgeFields({ name: 'Gammel', rule }), {
      publish: true,
    })
    const live = await createBadge(db, admin, badgeFields({ name: 'Ny', rule }), { publish: true })
    await setBadgeStatus(db, admin, archived.id, 'archived')

    await mergePeople(db, storage, admin, { sourceId: duplicate, targetId: kari!.personId! })
    expect(await awards(archived.id)).toMatchObject([{ personId: kari!.personId }])
    expect(await awards(live.id)).toMatchObject([{ personId: kari!.personId }])
  })

  it('sjeldenhet, trinn og nivå på profilen; skjulte merker teller ikke', async () => {
    const per = await member('Per', 2019)
    const lise = await member('Lise', 2019)
    const [w1, w2] = [await weekend('2018-09-07'), await weekend('2019-09-06')]
    await attend(w1, ola, kari, per, lise)
    await attend(w2, ola)
    await createBadge(
      db,
      admin,
      badgeFields({
        name: 'Helg',
        series: 'ESAF-helgen',
        sortOrder: 1,
        rule: { kind: 'event_count', eventTypeId: weekendType, count: 1 },
      }),
      { publish: true },
    )
    const two = await createBadge(db, admin, badgeFields({ series: 'ESAF-helgen', sortOrder: 2 }), {
      publish: true,
    })

    // Fem aktive medlemmer (admin, Ola, Kari, Per, Lise): fire har «Helg», én har ×2.
    expect(await badgesOn(kari, kari!.personId!)).toMatchObject([
      { name: 'Helg', rarity: { tier: 'common', xp: 25 }, step: { index: 1, count: 2 } },
    ])
    expect(await badgesOn(kari, ola!.personId!)).toMatchObject([
      // Én av fem: sjelden. Ola har begge, men profilen viser det høyeste trinnet.
      { id: two.id, rarity: { tier: 'rare', xp: 70 }, step: { index: 2, count: 2 } },
    ])
    expect((await getProfile(db, kari, ola!.personId!)).level).toMatchObject({
      xp: 95,
      level: 2,
      title: 'Deltaker',
      badges: 2,
    })

    await setOwnBadgeHidden(db, ola, two.id, true)
    // Skjulte merker teller ikke, heller ikke for personen selv.
    expect((await getProfile(db, ola, ola!.personId!)).level).toMatchObject({ xp: 25, badges: 1 })
  })

  it('fast sjeldenhet på merket overstyrer andelen, og kan tas bort igjen', async () => {
    await attend(await weekend('2018-09-07'), ola)
    const { id } = await createBadge(
      db,
      admin,
      badgeFields({
        rarity: 'common',
        rule: { kind: 'event_count', eventTypeId: weekendType, count: 1 },
      }),
      { publish: true },
    )
    // Én av tre aktive har merket, men det er satt fast til vanlig.
    expect(await badgesOn(kari, ola!.personId!)).toMatchObject([
      { id, rarity: { tier: 'common', xp: 25, fixed: true } },
    ])
    expect((await listBadgesForAdmin(db, admin)).find((b) => b.id === id)?.rarity).toBe('common')

    await updateBadge(db, admin, id, { rarity: 'legendary' })
    expect((await getProfile(db, kari, ola!.personId!)).level).toMatchObject({ xp: 200 })

    // Uten fast sjeldenhet regnes den ut fra andelen igjen (én av tre: uvanlig).
    await updateBadge(db, admin, id, { rarity: null })
    expect(await badgesOn(kari, ola!.personId!)).toMatchObject([
      { id, rarity: { tier: 'uncommon', fixed: false } },
    ])
    await expect(
      updateBadge(db, admin, id, { rarity: 'mythic' as unknown as 'common' }),
    ).rejects.toThrow('Velg en sjeldenhet.')
  })

  it('kullkampen: rangert på andel, og det første fulle kullet beholder merket sitt', async () => {
    const unclaimed = async (name: string, year: number) =>
      (
        await createProfile(db, admin, {
          fullName: name,
          cohorts: [{ graduationYear: year, relation: 'student' }],
          emails: [],
          status: 'active',
        })
      ).personId
    const stranger = await unclaimed('Ola Ukjent', 2018)

    // ES 2019 har alle med (Kari), ES 2018 halvparten (Ola av to).
    let race = (await communityOverview(db, ola)).race
    expect(race.map((r) => [r.graduationYear, r.rank, r.claimed, r.members])).toEqual([
      [2019, 1, 1, 1],
      [2018, 2, 1, 2],
    ])
    expect(race[0]!.completedPlace).toBeNull()

    const first = await createBadge(
      db,
      admin,
      badgeFields({ name: 'Først til 100 %', rule: { kind: 'cohort_complete', place: 1 } }),
      { publish: true },
    )
    expect(await awards(first.id)).toMatchObject([{ personId: kari!.personId }])
    race = (await communityOverview(db, ola)).race
    expect(race[0]).toMatchObject({ graduationYear: 2019, completedPlace: 1 })
    expect((await communityOverview(db, ola)).raceBadges).toMatchObject([
      { id: first.id, place: 1 },
    ])

    // Et nytt medlem i ES 2019: kullet er ikke fullt lenger, men var først.
    // Merket er kullets, så den nye får det også.
    const newcomer = await unclaimed('Kari Ukjent', 2019)
    await setPersonCohorts(db, admin, stranger, [])
    await syncBadges(db)
    race = (await communityOverview(db, ola)).race
    expect(race.map((r) => [r.graduationYear, r.rank, r.completedPlace])).toEqual([
      [2018, 1, 2],
      [2019, 2, 1],
    ])
    expect((await awards(first.id)).map((a) => a.personId).sort()).toEqual(
      [kari!.personId, newcomer].sort(),
    )

    // Et merke for alle fulle kull går til begge.
    const all = await createBadge(
      db,
      admin,
      badgeFields({ name: 'Fullt kull', rule: { kind: 'cohort_complete' } }),
      { publish: true },
    )
    expect((await awards(all.id)).map((a) => a.personId).sort()).toEqual(
      [ola!.personId, kari!.personId, newcomer].sort(),
    )
    const preview = await previewBadgeRule(db, admin, { kind: 'cohort_complete', place: 1 })
    expect(preview).toMatchObject({
      ruleText: 'Gått i det første kullet der alle tok i bruk profilen',
      total: 2,
    })
  })
})
