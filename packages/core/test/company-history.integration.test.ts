import { randomUUID } from 'node:crypto'
import { createDb, loadRootEnv, runMigrations, schema, type Db } from '@esaf/db'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccessDeniedError,
  addCompanyEvent,
  applyProfileImport,
  companyInput,
  confirmProfileFields,
  decideMembership,
  badgeRule,
  deleteCompany,
  deleteCompanyEvent,
  deleteQuote,
  evaluateBadgeRule,
  loadBadgeFacts,
  getCompany,
  getProfile,
  grantRoleAsOperator,
  listCompanies,
  loadViewer,
  mergeCompanies,
  parseProfileSheet,
  planProfileImport,
  randomQuote,
  resolveCompanies,
  updateCompany,
  updateCompanyEvent,
  updateProfile,
  updateQuote,
  type CompanyDetails,
  type CompanyEventInput,
  type CompanyInput,
  type ObjectStorage,
  type ProfileInput,
  type QuoteInput,
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

const emptyProfile: ProfileInput = {
  fullName: 'Navn',
  city: '',
  studyBackground: '',
  esCompany: '',
  bio: '',
  expertise: [],
  industries: [],
  experience: [],
  linkedinUrl: '',
  contactEmail: '',
  contactEmailVisible: false,
  phone: '',
  phoneVisible: false,
}

const info: CompanyInput = {
  name: 'Syrlig',
  tagline: '',
  description: '',
  website: '',
  foundedYear: null,
  location: '',
  industries: [],
  status: 'unknown',
}

const event: CompanyEventInput = {
  year: 2019,
  month: 6,
  day: null,
  type: 'funding',
  text: 'Hentet 4 MNOK.',
  sourceUrl: 'https://www.tu.no/artikler/syrlig',
  sourceLabel: '',
}

const quoteValues: QuoteInput = {
  text: 'ES lærte oss å teste før vi bygde.',
  speakerName: 'Ola',
  speakerRole: 'Daglig leder i Syrlig',
  date: '2020-03-01',
  sourceUrl: 'https://example.test/sak',
  sourceLabel: '',
  confidence: 'high',
}

describe.skipIf(!url)('historikk, sitater og kilder', () => {
  let db: Db
  let admin: Viewer
  let ola: Viewer
  let kari: Viewer
  let per: Viewer

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

  async function member(name: string) {
    const v = await loadViewer(db, await account(name))
    await decideMembership(db, admin, { personId: v!.personId!, decision: 'approve' })
    return loadViewer(db, v!.userId)
  }

  beforeEach(async () => {
    await db.execute(
      sql`truncate ${schema.fieldSource}, ${schema.auditEvent}, ${schema.membership}, ${schema.personCohort}, ${schema.person}, ${schema.cohort}, ${schema.user}, ${schema.company} cascade`,
    )
    await account('Admin')
    await grantRoleAsOperator(db, { email: 'admin@example.test', reason: 'test', role: 'admin' })
    await db
      .update(schema.user)
      .set({ twoFactorEnabled: true })
      .where(eq(schema.user.email, 'admin@example.test'))
    admin = await loadViewer(db, (await db.select().from(schema.user))[0]!.id)
    ola = await member('Ola')
    kari = await member('Kari')
    per = await member('Per')
  })

  /** Ola er gründer av Syrlig, Kari og Per er ikke knyttet til det. */
  async function syrlig() {
    await updateProfile(db, ola, ola!.personId!, {
      ...emptyProfile,
      fullName: 'Ola',
      experience: [
        { company: 'Syrlig', title: null, startYear: 2016, endYear: null, founder: true },
      ],
    })
    const [row] = await db.select().from(schema.company).where(eq(schema.company.slug, 'syrlig'))
    return row!
  }

  async function page(viewer: Viewer, slug = 'syrlig') {
    const found = await getCompany(db, viewer, slug)
    if ('movedTo' in found) throw new Error(`Flyttet til ${found.movedTo}`)
    return found as CompanyDetails
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

  const audit = (action: string) =>
    db.select().from(schema.auditEvent).where(eq(schema.auditEvent.action, action))

  describe('ukjent status', () => {
    it('selskaper medlemmer skriver inn er aktive, importerte og nye rader i databasen er ukjente', async () => {
      const { id } = await syrlig()
      expect((await page(kari)).status).toBe('active')

      const [imported] = await resolveCompanies(db, [{ name: 'Fra Lista' }], {
        status: 'unknown',
      })
      const [raw] = await db
        .insert(schema.company)
        .values({ slug: 'rad', name: 'Rad' })
        .returning({ status: schema.company.status })
      expect(raw!.status).toBe('unknown')
      const [listRow] = await db
        .select({ status: schema.company.status })
        .from(schema.company)
        .where(eq(schema.company.id, imported!))
      expect(listRow!.status).toBe('unknown')

      // Kullisten sier ikke om selskapet finnes.
      const sheet = parseProfileSheet(
        ['navn,kull,epost,arbeidsgiver', 'Anne Arket,2015,anne@example.test,Nytt AS'].join('\n'),
        { yearKind: 'graduation', columns: { currentCompany: 'arbeidsgiver' } },
      )
      await applyProfileImport(db, await planProfileImport(db, sheet.rows), {
        membershipStatus: 'active',
        sourceLabel: 'test.csv',
      })
      expect((await page(kari, 'nytt-as')).status).toBe('unknown')

      // Kan settes og vises, med sist nevnt på ES-siden.
      await db
        .update(schema.company)
        .set({ status: 'unknown', lastSeenOnEsSite: '2016-04-02' })
        .where(eq(schema.company.id, id))
      expect(await page(kari)).toMatchObject({
        status: 'unknown',
        lastSeenOnEsSite: '2016-04-02',
      })
      expect((await listCompanies(db, kari)).find((c) => c.id === id)?.status).toBe('unknown')
      expect(companyInput.safeParse(info).success).toBe(true)
      await updateCompany(db, ola, id, { ...info, status: 'active' })
      expect((await page(kari)).status).toBe('active')
    })
  })

  describe('historikk', () => {
    it('de som kan redigere selskapet, kan rette og slette hendelser; andre ikke', async () => {
      const { id } = await syrlig()
      const { id: eventId } = await addCompanyEvent(db, ola, id, event)
      await addCompanyEvent(db, ola, id, {
        ...event,
        year: 2016,
        month: null,
        type: 'founded',
        text: 'Stiftet.',
        sourceUrl: '',
      })

      const { events } = await page(kari)
      expect(events.map((e) => [e.date, e.datePrecision, e.type])).toEqual([
        ['2019-06-01', 'month', 'funding'],
        ['2016-01-01', 'year', 'founded'],
      ])
      expect(events[0]!.source).toEqual({
        label: 'tu.no',
        url: 'https://www.tu.no/artikler/syrlig',
      })
      expect(events[1]!.source).toBeNull()

      for (const v of [kari, per]) {
        expect(await denial(updateCompanyEvent(db, v, eventId, event))).toBe('forbidden')
        expect(await denial(deleteCompanyEvent(db, v, eventId))).toBe('forbidden')
      }
      expect(await denial(addCompanyEvent(db, null, id, event))).toBe('unauthenticated')

      await updateCompanyEvent(db, ola, eventId, { ...event, day: 14, text: 'Hentet 5 MNOK.' })
      expect((await page(kari)).events[0]).toMatchObject({
        date: '2019-06-14',
        datePrecision: 'day',
        text: 'Hentet 5 MNOK.',
      })
      await deleteCompanyEvent(db, ola, eventId)
      expect((await page(kari)).events).toHaveLength(1)
      // Gründerens egne endringer logges ikke.
      expect(
        await db
          .select()
          .from(schema.auditEvent)
          .where(sql`action like 'company.%'`),
      ).toEqual([])
    })

    it('admins kan endre historikken til alle selskaper, og det logges', async () => {
      const { id } = await syrlig()
      const { id: eventId } = await addCompanyEvent(db, admin, id, event)
      await updateCompanyEvent(db, admin, eventId, { ...event, type: 'award' })
      await deleteCompanyEvent(db, admin, eventId)
      for (const action of [
        'company.admin_event_add',
        'company.admin_event_edit',
        'company.admin_event_remove',
      ]) {
        const [logged] = await audit(action)
        expect(logged).toMatchObject({ actorPersonId: admin!.personId })
        expect(logged!.details).toMatchObject({ companyId: id, slug: 'syrlig', eventId })
      }

      const { id: other } = await addCompanyEvent(db, admin, id, event)
      await db
        .update(schema.user)
        .set({ twoFactorEnabled: false })
        .where(eq(schema.user.email, 'admin@example.test'))
      const without2fa = await loadViewer(db, admin!.userId)
      expect(await denial(deleteCompanyEvent(db, without2fa, other))).toBe('strong_auth_required')
    })

    it('usikre hendelser vises bare for dem som kan redigere, og blir bekreftet når de lagres', async () => {
      const { id } = await syrlig()
      const [low] = await db
        .insert(schema.companyEvent)
        .values({
          companyId: id,
          date: '2021-01-01',
          datePrecision: 'year',
          type: 'award',
          text: 'Automatisk hentet setning.',
          sourceUrl: 'javascript:alert(1)',
          confidence: 'low',
        })
        .returning()

      expect((await page(kari)).events).toEqual([])
      const forOla = (await page(ola)).events
      expect(forOla).toMatchObject([{ id: low!.id, review: true }])
      // Lenker som ikke er http eller https, sendes aldri til nettleseren.
      expect(forOla[0]!.source).toBeNull()
      expect((await page(admin)).events).toHaveLength(1)

      await updateCompanyEvent(db, ola, low!.id, {
        ...event,
        year: 2021,
        month: null,
        type: 'award',
        text: low!.text,
        sourceUrl: '',
      })
      expect((await page(kari)).events).toMatchObject([{ id: low!.id, review: false }])
    })

    it('hendelser valideres', async () => {
      const { id } = await syrlig()
      const add = (patch: Partial<CompanyEventInput>) =>
        addCompanyEvent(db, ola, id, { ...event, ...patch })
      await expect(add({ text: '  ' })).rejects.toThrow('Skriv hva som skjedde')
      await expect(add({ month: null, day: 3 })).rejects.toThrow('måned')
      await expect(add({ month: 2, day: 30 })).rejects.toThrow('finnes ikke')
      await expect(add({ year: 1700 })).rejects.toThrow('årstall')
      await expect(add({ sourceUrl: 'javascript:alert(1)' })).rejects.toThrow('lenke')
      await expect(add({ type: 'konkurs' as never })).rejects.toThrow()
      await expect(add({ text: 'x'.repeat(501) })).rejects.toThrow('500')
      const { id: eventId } = await add({
        sourceUrl: 'dn.no/sak',
        sourceLabel: 'Dagens Næringsliv',
      })
      const [row] = await db
        .select()
        .from(schema.companyEvent)
        .where(eq(schema.companyEvent.id, eventId))
      expect(row).toMatchObject({
        sourceUrl: 'https://dn.no/sak',
        sourceLabel: 'Dagens Næringsliv',
      })
    })
  })

  describe('programmer', () => {
    const programme = (
      name: string,
      patch: Partial<NonNullable<CompanyEventInput['programme']>> = {},
    ): CompanyEventInput => ({
      year: 2022,
      month: 1,
      day: null,
      type: 'programme',
      text: '',
      sourceUrl: 'https://www.ycombinator.com/companies/syrlig',
      sourceLabel: '',
      programme: { name, companyId: null, kind: 'accelerator', batch: 'W22', ...patch },
    })

    it('kobler selskapet til programmet, som viser selskapene som har vært med', async () => {
      const { id } = await syrlig()
      const { id: eventId } = await addCompanyEvent(db, kari, id, programme('Y Combinator'))

      const [event] = (await page(kari)).events
      expect(event).toMatchObject({
        id: eventId,
        type: 'programme',
        text: '',
        programme: {
          kind: 'accelerator',
          batch: 'W22',
          company: { slug: 'y-combinator', name: 'Y Combinator', logo: null },
        },
      })
      const yc = await page(kari, 'y-combinator')
      expect(yc.programmeCompanies).toMatchObject([
        {
          eventId,
          date: '2022-01-01',
          datePrecision: 'month',
          kind: 'accelerator',
          batch: 'W22',
          company: { id, slug: 'syrlig', name: 'Syrlig' },
        },
      ])
      expect((await page(kari)).programmeCompanies).toEqual([])

      // Et valgt program brukes, også med et annet navn i feltet.
      const { id: second } = await addCompanyEvent(
        db,
        ola,
        id,
        programme('YC', { companyId: yc.id, batch: null, kind: 'other' }),
      )
      expect((await page(kari)).events.find((e) => e.id === second)?.programme).toMatchObject({
        kind: 'other',
        batch: null,
        company: { id: yc.id },
      })
    })

    it('programmet må velges, og et selskap kan ikke ha vært med i seg selv', async () => {
      const { id } = await syrlig()
      await expect(
        addCompanyEvent(db, ola, id, { ...programme(''), programme: null }),
      ).rejects.toThrow('Velg programmet')
      await expect(addCompanyEvent(db, ola, id, programme('  '))).rejects.toThrow('Velg programmet')
      await expect(
        addCompanyEvent(db, ola, id, programme('Syrlig', { companyId: id })),
      ).rejects.toThrow('sitt eget program')
      await expect(
        addCompanyEvent(db, ola, id, programme('Y Combinator', { kind: 'bootcamp' as never })),
      ).rejects.toThrow('Velg hva slags program')
      await expect(
        addCompanyEvent(db, ola, id, programme('Y Combinator', { batch: 'x'.repeat(41) })),
      ).rejects.toThrow('40')
      // Andre typer får aldri et program, selv om skjemaet sender ett.
      const { id: eventId } = await addCompanyEvent(db, ola, id, {
        ...programme('Y Combinator'),
        type: 'funding',
        text: 'Hentet 4 MNOK.',
      })
      const [row] = await db
        .select()
        .from(schema.companyEvent)
        .where(eq(schema.companyEvent.id, eventId))
      expect(row).toMatchObject({
        programmeCompanyId: null,
        programmeKind: null,
        programmeBatch: null,
      })
      expect(
        await db.select().from(schema.company).where(eq(schema.company.slug, 'y-combinator')),
      ).toEqual([])
    })

    it('et program laget fra en skrivefeil ryddes bort når det rettes, et ekte blir stående', async () => {
      const { id } = await syrlig()
      const { id: eventId } = await addCompanyEvent(db, ola, id, programme('Y Combinatr'))
      await updateCompanyEvent(db, ola, eventId, programme('Y Combinator'))
      const slugs = async () =>
        (await db.select({ slug: schema.company.slug }).from(schema.company)).map((c) => c.slug)
      expect(await slugs()).not.toContain('y-combinatr')
      expect(await slugs()).toContain('y-combinator')

      await deleteCompanyEvent(db, ola, eventId)
      expect(await slugs()).not.toContain('y-combinator')
    })

    it('sammenslåing flytter koblingen, sletting av programmet lar hendelsen stå', async () => {
      const { id } = await syrlig()
      const [dup, real] = await resolveCompanies(db, [{ name: 'YC' }, { name: 'Y Combinator' }])
      await addCompanyEvent(db, ola, id, programme('YC', { companyId: dup! }))
      await mergeCompanies(db, storage, admin, { sourceId: dup!, targetId: real! })
      expect((await page(kari, 'y-combinator')).programmeCompanies).toHaveLength(1)

      await deleteCompany(db, storage, admin, { companyId: real!, unlink: false })
      const [event] = (await page(kari)).events
      expect(event).toMatchObject({ type: 'programme', programme: { company: null } })
      const [logged] = await audit('company.delete')
      expect(logged!.details).toMatchObject({ programmeEvents: 1 })
    })

    it('merkeregelen ser det første selskapet i ESAF i programmet', async () => {
      const { id } = await syrlig()
      await updateProfile(db, kari, kari!.personId!, {
        ...emptyProfile,
        fullName: 'Kari',
        experience: [
          { company: 'Bølgepost', title: null, startYear: 2018, endYear: null, founder: true },
        ],
      })
      const [bolge] = await db
        .select()
        .from(schema.company)
        .where(eq(schema.company.slug, 'bolgepost'))
      await addCompanyEvent(db, ola, id, programme('Y Combinator'))
      const yc = await page(ola, 'y-combinator')
      await addCompanyEvent(db, kari, bolge!.id, {
        ...programme('Y Combinator', { companyId: yc.id, batch: 'S23' }),
        year: 2023,
      })
      const firstInYc = badgeRule.parse({ kind: 'programme', programmeIds: [yc.id], first: true })
      const facts = await loadBadgeFacts(db, [ola!.personId!, kari!.personId!])
      expect(evaluateBadgeRule(firstInYc, facts.get(ola!.personId!)!)).toMatchObject({
        earned: true,
        achievedOn: '2022-01-01',
      })
      expect(evaluateBadgeRule(firstInYc, facts.get(kari!.personId!)!).earned).toBe(false)
      expect(
        evaluateBadgeRule(
          badgeRule.parse({ kind: 'programme', programmeIds: [yc.id] }),
          facts.get(kari!.personId!)!,
        ),
      ).toMatchObject({ earned: true, achievedOn: '2023-01-01' })
    })
  })

  describe('sitater', () => {
    async function addQuote(values: Partial<typeof schema.quote.$inferInsert> = {}) {
      const [row] = await db
        .insert(schema.quote)
        .values({ text: 'Sitat.', speakerName: 'Noen', ...values })
        .returning()
      return row!
    }

    it('vises på profilen og selskapssiden, men bare med sikker taler som er aktivt medlem', async () => {
      const { id } = await syrlig()
      const high = await addQuote({
        text: 'Sikker.',
        personId: ola!.personId!,
        companyId: id,
        speakerName: 'Ola Fra Kilden',
        speakerRole: 'Daglig leder',
        sourceUrl: 'https://example.test/sak',
      })
      const low = await addQuote({
        text: 'Usikker.',
        personId: ola!.personId!,
        companyId: id,
        confidence: 'low',
      })
      const outsider = await addQuote({ text: 'Uten profil.', companyId: id, speakerName: 'Nils' })

      const profile = await getProfile(db, kari, ola!.personId!)
      expect(profile.quotes.map((q) => q.id)).toEqual([high.id])
      expect(profile.quotes[0]).toMatchObject({
        speaker: { personId: ola!.personId, name: 'Ola' },
        role: 'Daglig leder',
        source: { label: 'example.test', url: 'https://example.test/sak' },
        review: false,
        confidence: null,
        canEdit: false,
        canRemove: false,
      })
      const company = await page(kari)
      expect(company.quotes.map((q) => q.id).sort()).toEqual([high.id, outsider.id].sort())
      expect(company.quotes.find((q) => q.id === outsider.id)!.speaker).toMatchObject({
        personId: null,
        name: 'Nils',
      })

      // Admins ser også de usikre, merket, med hvor sikker kilden er.
      const forAdmin = await getProfile(db, admin, ola!.personId!)
      expect(forAdmin.quotes.find((q) => q.id === low.id)).toMatchObject({
        review: true,
        confidence: 'low',
        canEdit: true,
      })

      // Et deaktivert medlem vises ikke, heller ikke gjennom sitatene sine.
      await db
        .update(schema.membership)
        .set({ status: 'inactive' })
        .where(eq(schema.membership.personId, ola!.personId!))
      expect((await page(kari)).quotes.map((q) => q.id)).toEqual([outsider.id])
    })

    it('tilfeldig sitat er aldri usikkert, og helst fra et medlem', async () => {
      expect(await randomQuote(db, kari)).toBeNull()
      await addQuote({ text: 'Usikker.', personId: ola!.personId!, confidence: 'low' })
      expect(await randomQuote(db, kari)).toBeNull()
      expect(await randomQuote(db, admin)).toBeNull()
      const loose = await addQuote({ text: 'Uten person.' })
      expect((await randomQuote(db, kari))?.id).toBe(loose.id)
      const linked = await addQuote({ text: 'Med person.', personId: ola!.personId! })
      for (let i = 0; i < 5; i++) expect((await randomQuote(db, kari))?.id).toBe(linked.id)
      expect(await denial(randomQuote(db, null))).toBe('unauthenticated')
    })

    it('admins retter og sletter sitater (logges); den som er sitert, kan fjerne sine egne', async () => {
      const mine = await addQuote({ personId: ola!.personId! })
      const other = await addQuote({ personId: kari!.personId! })

      expect(await denial(updateQuote(db, ola, mine.id, quoteValues))).toBe('forbidden')
      expect(await denial(deleteQuote(db, per, mine.id))).toBe('forbidden')
      await expect(
        updateQuote(db, admin, mine.id, { ...quoteValues, sourceUrl: 'javascript:x' }),
      ).rejects.toThrow('lenke')
      await expect(
        updateQuote(db, admin, mine.id, { ...quoteValues, date: '2020-13-45' }),
      ).rejects.toThrow('dato')

      await updateQuote(db, admin, mine.id, { ...quoteValues, confidence: 'low' })
      const [edited] = await audit('quote.edit')
      expect(edited).toMatchObject({
        actorPersonId: admin!.personId,
        subjectPersonId: ola!.personId,
      })
      expect(edited!.details).toMatchObject({ quoteId: mine.id })
      expect((await getProfile(db, kari, ola!.personId!)).quotes).toEqual([])

      await deleteQuote(db, ola, mine.id)
      expect(await audit('quote.remove')).toEqual([])
      await deleteQuote(db, admin, other.id)
      const [removed] = await audit('quote.remove')
      expect(removed).toMatchObject({ subjectPersonId: kari!.personId })
      expect(await db.select().from(schema.quote)).toEqual([])
    })
  })

  describe('kilder', () => {
    async function source(
      entityType: 'person' | 'company',
      entityId: string,
      field: string,
      more: Partial<typeof schema.fieldSource.$inferInsert> = {},
    ) {
      await db.insert(schema.fieldSource).values({
        entityType,
        entityId,
        field,
        sourceLabel: 'entreprenorskolen.no',
        sourceUrl: 'https://www.entreprenorskolen.no/alumni',
        confidence: 'medium',
        ...more,
      })
    }

    it('profilen viser kilder for felt som vises, aldri for kontaktinfo, og sikkerhet bare for admins', async () => {
      const id = ola!.personId!
      await updateProfile(db, ola, id, {
        ...emptyProfile,
        fullName: 'Ola',
        bio: 'Bygger selskap.',
        phone: '+47 400 00 000',
        contactEmail: 'ola@example.test',
      })
      await source('person', id, 'bio')
      await source('person', id, 'city')
      await source('person', id, 'phone', { sourceLabel: 'kullisten', sourceUrl: null })
      await source('person', id, 'contactEmail', { sourceLabel: 'kullisten', sourceUrl: null })
      await source('person', id, 'bio', {
        sourceLabel: 'arkiv',
        sourceUrl: 'file:///hemmelig.xlsx',
      })

      const forKari = await getProfile(db, kari, id)
      // Byen er tom, og kontaktinfo har aldri kilder.
      expect(forKari.sources.map((s) => [s.field, s.label, s.url, s.confidence])).toEqual([
        ['bio', 'entreprenorskolen.no', 'https://www.entreprenorskolen.no/alumni', null],
        ['bio', 'arkiv', null, null],
      ])
      expect((await getProfile(db, admin, id)).sources[0]!.confidence).toBe('medium')
      expect((await getProfile(db, ola, id)).sources.map((s) => s.field)).toEqual(['bio', 'bio'])
    })

    it('eieren bekrefter ved å skrive om eller trykke «Stemmer»; en admin som retter, fjerner kilden', async () => {
      const id = ola!.personId!
      const profile = {
        ...emptyProfile,
        fullName: 'Ola',
        bio: 'Fra ES-siden.',
        studyBackground: 'Fysikk',
        city: 'Trondheim',
        industries: ['Energi'],
      }
      await updateProfile(db, admin, id, profile)
      for (const field of ['bio', 'studyBackground', 'city', 'industries']) {
        await source('person', id, field)
      }
      const confirmed = async () =>
        Object.fromEntries(
          (await getProfile(db, kari, id)).sources.map((s) => [s.field, s.confirmed]),
        )

      // Uendrede felt bekreftes ikke av at eieren lagrer.
      await updateProfile(db, ola, id, { ...profile, bio: 'Skrevet av meg.' })
      expect(await confirmed()).toEqual({
        bio: true,
        industries: false,
        studyBackground: false,
        city: false,
      })

      expect(await denial(confirmProfileFields(db, admin, id))).toBe('forbidden')
      expect(await denial(confirmProfileFields(db, kari, id, ['city']))).toBe('forbidden')
      expect(await confirmProfileFields(db, ola, id, ['city'])).toBe(1)
      expect((await confirmed()).city).toBe(true)

      await updateProfile(db, admin, id, {
        ...profile,
        bio: 'Skrevet av meg.',
        studyBackground: 'Kjemi',
      })
      expect(Object.keys(await confirmed()).sort()).toEqual(['bio', 'city', 'industries'])

      expect(await confirmProfileFields(db, ola, id)).toBe(1)
      expect(Object.values(await confirmed())).toEqual([true, true, true])
    })

    it('selskapet viser kilder per felt; de som er knyttet bekrefter, admins erstatter', async () => {
      const { id } = await syrlig()
      await updateCompany(db, ola, id, {
        ...info,
        website: 'syrlig.no',
        tagline: 'Syretester',
        status: 'active',
      })
      await source('company', id, 'website', { sourceLabel: 'syrlig.no', confidence: 'high' })
      await source('company', id, 'tagline')
      await source('company', id, 'description')
      await source('company', id, 'phone')

      expect((await page(kari)).sources.map((s) => [s.field, s.confirmed, s.confidence])).toEqual([
        ['tagline', false, null],
        ['website', false, null],
      ])
      expect((await page(admin)).sources.map((s) => s.confidence)).toEqual(['medium', 'high'])

      await updateCompany(db, ola, id, {
        ...info,
        website: 'syrlig.no',
        tagline: 'Syretester for gründere',
        status: 'active',
      })
      expect((await page(kari)).sources.map((s) => [s.field, s.confirmed])).toEqual([
        ['tagline', true],
        ['website', false],
      ])
      await updateCompany(db, admin, id, {
        ...info,
        website: 'syrlig.com',
        tagline: 'Syretester for gründere',
        status: 'active',
      })
      expect((await page(kari)).sources.map((s) => s.field)).toEqual(['tagline'])
    })

    it('sammenslåing flytter historikk, sitater og kildene til feltene som hentes fra duplikatet', async () => {
      const { id: target } = await syrlig()
      const [source_] = await db
        .insert(schema.company)
        .values({
          slug: 'syrlig-as',
          name: 'Syrlig AS',
          website: 'https://syrlig.no',
          tagline: 'Fra duplikatet',
          lastSeenOnEsSite: '2015-01-01',
          editedAt: new Date(),
        })
        .returning()
      await updateCompany(db, ola, target, { ...info, tagline: 'Fra målet', status: 'active' })
      await source('company', source_!.id, 'website', { sourceLabel: 'syrlig.no' })
      await source('company', source_!.id, 'tagline')
      await addCompanyEvent(db, admin, source_!.id, event)
      await db
        .insert(schema.quote)
        .values({ text: 'Om duplikatet.', speakerName: 'Nils', companyId: source_!.id })

      await mergeCompanies(db, storage, admin, { sourceId: source_!.id, targetId: target })
      const merged = await page(kari)
      expect(merged).toMatchObject({
        website: 'https://syrlig.no',
        tagline: 'Fra målet',
        lastSeenOnEsSite: '2015-01-01',
      })
      expect(merged.events).toHaveLength(1)
      expect(merged.quotes.map((q) => q.text)).toEqual(['Om duplikatet.'])
      expect(merged.sources.map((s) => s.field)).toEqual(['website'])
      // Ingen kilder blir liggende igjen på et selskap som ikke finnes.
      expect(
        await db
          .select()
          .from(schema.fieldSource)
          .where(
            and(
              eq(schema.fieldSource.entityType, 'company'),
              eq(schema.fieldSource.entityId, source_!.id),
            ),
          ),
      ).toEqual([])
    })
  })
})
