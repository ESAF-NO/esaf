import { randomUUID } from 'node:crypto'
import { createDb, loadRootEnv, runMigrations, schema, type Db } from '@esaf/db'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccessDeniedError,
  applyProfileImport,
  companySlug,
  decideMembership,
  getCompany,
  getEditableCompany,
  getProfile,
  grantRoleAsOperator,
  listCompanies,
  loadViewer,
  mergeCompanies,
  parseProfileSheet,
  planProfileImport,
  resolveCompanies,
  searchCompanies,
  setCompanyFormerNames,
  updateCompany,
  updateProfile,
  type CompanyDetails,
  type CompanyInput,
  type ExperienceInput,
  type ObjectStorage,
  type ProfileInput,
  type Viewer,
} from '../src/index.ts'

loadRootEnv()
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

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
  tagline: 'Syretester for gründere',
  description: '',
  website: '',
  foundedYear: null,
  location: '',
  industries: [],
  status: 'active',
}

/** Sammenslåing rydder logoer i lagringen; her har ingen av selskapene logo. */
const storage: ObjectStorage = {
  put: () => Promise.resolve(),
  get: () => Promise.resolve(null),
  delete: () => Promise.resolve(),
}

const job = (company: string, more: Partial<ExperienceInput> = {}): ExperienceInput => ({
  company,
  title: null,
  startYear: null,
  endYear: null,
  founder: false,
  ...more,
})

describe.skipIf(!url)('selskaper', () => {
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
      sql`truncate ${schema.auditEvent}, ${schema.membership}, ${schema.personCohort}, ${schema.person}, ${schema.cohort}, ${schema.user}, ${schema.company} cascade`,
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

  /** Lagrer erfaring (og eventuelt ES-selskap) på egen profil. */
  async function work(
    viewer: Viewer,
    experience: ExperienceInput[],
    es: { esCompany?: string; esCompanyId?: string | null } = {},
  ) {
    const [me] = await db
      .select({ fullName: schema.person.fullName })
      .from(schema.person)
      .where(eq(schema.person.id, viewer!.personId!))
    await updateProfile(db, viewer, viewer!.personId!, {
      ...emptyProfile,
      fullName: me!.fullName,
      ...es,
      experience,
    })
  }

  async function companyBySlug(slug: string) {
    const [row] = await db.select().from(schema.company).where(eq(schema.company.slug, slug))
    return row
  }

  async function page(viewer: Viewer, slug: string) {
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

  it('SQL-funksjonen fra migreringen gir samme slug som companySlug', async () => {
    const names = [
      'Kahoot!',
      'kahoot',
      ' Løypa ',
      'ØRSTED',
      'Bærum Æ',
      'Åsane  AS',
      'Crème Brûlée',
      'Ünïcödé',
      'İstanbul',
      "O'Brien & Co.",
      'Straße',
      'ﬁnn',
      'Nordlys Health',
      'Яндекс',
      'ΣΟΦΙΑ',
      '—',
    ]
    const result = await db.execute<{ slug: string }>(
      sql`select company_slug(name) as slug from unnest(${sql.param(names)}::text[]) with ordinality as t(name, i) order by i`,
    )
    expect(result.rows.map((r) => r.slug)).toEqual(names.map(companySlug))
    expect(companySlug('Яндекс')).toMatch(/^selskap-[0-9a-f]{8}$/)
    expect(companySlug('Яндекс')).toBe(companySlug('яндекс'))
  })

  it('nye selskaper får skrivemåten som er brukt flest ganger, som i migreringen', async () => {
    const ids = await resolveCompanies(
      db,
      ['mckinsey', 'McKinsey', 'McKinsey', 'Løypa', 'Loypa', 'Vipps  MobilePay'].map((name) => ({
        name,
      })),
    )
    expect(new Set(ids.slice(0, 3)).size).toBe(1)
    expect(ids[3]).toBe(ids[4])
    expect(await companyBySlug('mckinsey')).toMatchObject({ id: ids[0], name: 'McKinsey' })
    // Likt antall: den som kom først.
    expect(await companyBySlug('loypa')).toMatchObject({ name: 'Løypa' })
    expect(await companyBySlug('vipps-mobilepay')).toMatchObject({ name: 'Vipps MobilePay' })

    // Finnes selskapet allerede, endres ikke navnet.
    const [again] = await resolveCompanies(db, [{ name: 'MCKINSEY' }])
    expect(again).toBe(ids[0])
    expect((await companyBySlug('mckinsey'))!.name).toBe('McKinsey')
  })

  it('erfaring med samme selskap skrevet ulikt kobles til ett selskap, nye navn blir nye selskaper', async () => {
    await work(ola, [job('Kahoot!', { title: 'Produktsjef' })])
    await work(kari, [job('kahoot ', { endYear: 2020, startYear: 2018 })])
    await work(per, [job('Helt Nytt AS', { founder: true })])

    const companies = await db.select().from(schema.company)
    expect(companies.map((c) => c.name).sort()).toEqual(['Helt Nytt AS', 'Kahoot!'])
    const olaProfile = await getProfile(db, kari, ola!.personId!)
    const kariProfile = await getProfile(db, ola, kari!.personId!)
    expect(olaProfile.experience[0]).toMatchObject({ company: 'Kahoot!', companySlug: 'kahoot' })
    expect(kariProfile.experience[0]).toMatchObject({ company: 'Kahoot!', companySlug: 'kahoot' })
    expect(kariProfile.experience[0]!.companyId).toBe(olaProfile.experience[0]!.companyId)
  })

  it('et valgt selskap brukes uansett navn, og en ukjent id faller tilbake på navnet', async () => {
    await work(ola, [job('Syrlig')])
    const syrlig = (await companyBySlug('syrlig'))!

    await work(kari, [job('Syrlig AS', { companyId: syrlig.id })])
    await work(per, [job('syrlig', { companyId: randomUUID() })])
    for (const v of [kari, per]) {
      expect((await getProfile(db, ola, v!.personId!)).experience[0]!.companyId).toBe(syrlig.id)
    }
    expect(await db.select().from(schema.company)).toHaveLength(1)
  })

  it('ES-selskapet kobles til et selskap, og vises på profilen', async () => {
    await work(ola, [], { esCompany: 'Fjordflow' })
    await work(kari, [job('FjordFlow', { founder: true })], { esCompany: 'fjordflow' })
    const profile = await getProfile(db, per, kari!.personId!)
    expect(profile).toMatchObject({ esCompany: 'Fjordflow', esCompanySlug: 'fjordflow' })
    expect(await db.select().from(schema.company)).toHaveLength(1)

    await work(ola, [], { esCompany: '' })
    expect((await getProfile(db, per, ola!.personId!)).esCompany).toBeNull()
  })

  it('en rettet skrivefeil ryddes bort, men selskaper noen har skrevet om blir stående', async () => {
    await work(ola, [job('Kahot')])
    await work(ola, [job('Kahoot!')])
    expect(await companyBySlug('kahot')).toBeUndefined()

    await work(ola, [job('Ensom AS', { founder: true })])
    const ensom = (await companyBySlug('ensom-as'))!
    await updateCompany(db, ola, ensom.id, { ...info, name: 'Ensom AS' })
    await work(ola, [])
    expect(await companyBySlug('ensom-as')).toBeDefined()
    // Uten noen knyttet til seg vises det ikke i oversikten, men siden finnes.
    expect((await listCompanies(db, ola)).map((c) => c.slug)).not.toContain('ensom-as')
    expect((await page(ola, 'ensom-as')).people).toEqual([])
  })

  it('gründere, ES-teamet og de som jobber der nå kan redigere, ikke tidligere ansatte eller andre', async () => {
    const tidligere = await member('Tidligere')
    const annen = await member('Annen')
    await work(ola, [job('Syrlig', { founder: true, startYear: 2016, endYear: 2020 })])
    await work(kari, [], { esCompany: 'Syrlig' })
    await work(per, [job('Syrlig', { title: 'CTO' })])
    await work(tidligere, [job('Syrlig', { startYear: 2017, endYear: 2019 })])
    const { id } = (await companyBySlug('syrlig'))!

    for (const v of [ola, kari, per]) {
      expect((await page(v, 'syrlig')).canEdit).toBe(true)
      await updateCompany(db, v, id, { ...info, location: `Oslo ${v!.personId}` })
    }
    for (const v of [tidligere, annen]) {
      expect((await page(v, 'syrlig')).canEdit).toBe(false)
      expect(await denial(updateCompany(db, v, id, info))).toBe('forbidden')
      expect(await denial(getEditableCompany(db, v, 'syrlig'))).toBe('forbidden')
    }
    expect(await denial(updateCompany(db, null, id, info))).toBe('unauthenticated')
    expect(await denial(getCompany(db, null, 'syrlig'))).toBe('unauthenticated')
    // Endringer fra dem som er knyttet til selskapet, logges ikke som adminendringer.
    expect(
      await db
        .select()
        .from(schema.auditEvent)
        .where(sql`action like 'company.%'`),
    ).toEqual([])
  })

  it('admins kan redigere alle selskaper med tofaktor, og endringen logges', async () => {
    await work(ola, [job('Syrlig', { founder: true })])
    const { id } = (await companyBySlug('syrlig'))!
    expect((await page(admin, 'syrlig')).canEdit).toBe(true)
    expect(await getEditableCompany(db, admin, 'syrlig')).toMatchObject({
      adminEdit: true,
      canMerge: true,
    })
    await updateCompany(db, admin, id, { ...info, website: 'syrlig.no' })

    const [event] = await db
      .select()
      .from(schema.auditEvent)
      .where(eq(schema.auditEvent.action, 'company.admin_edit'))
    expect(event).toMatchObject({ actorPersonId: admin!.personId })
    expect(event!.details).toMatchObject({ companyId: id, fields: ['tagline', 'website'] })

    await db
      .update(schema.user)
      .set({ twoFactorEnabled: false })
      .where(eq(schema.user.email, 'admin@example.test'))
    const without2fa = await loadViewer(db, admin!.userId)
    expect(await denial(updateCompany(db, without2fa, id, info))).toBe('strong_auth_required')
  })

  it('felt ingen har rørt, regnes ikke som endret, selv om de ble lagret uten normalisering', async () => {
    await work(ola, [job('Syrlig', { founder: true })])
    const { id } = (await companyBySlug('syrlig'))!
    // Som fra import: nettadresse med skråstrek og en kilde.
    await db
      .update(schema.company)
      .set({ website: 'https://syrlig.no/', tagline: 'Syretester  for gründere' })
      .where(eq(schema.company.id, id))
    await db.insert(schema.fieldSource).values({
      entityType: 'company',
      entityId: id,
      field: 'website',
      sourceLabel: 'entreprenorskolen.no',
      confidence: 'high',
    })
    await updateCompany(db, admin, id, {
      ...info,
      website: 'https://syrlig.no/',
      tagline: 'Syretester for gründere',
      location: 'Trondheim',
    })
    const sources = await db
      .select({ field: schema.fieldSource.field })
      .from(schema.fieldSource)
      .where(eq(schema.fieldSource.entityId, id))
    expect(sources.map((s) => s.field)).toEqual(['website'])
    const [event] = await db
      .select()
      .from(schema.auditEvent)
      .where(eq(schema.auditEvent.action, 'company.admin_edit'))
    expect(event!.details).toMatchObject({ fields: ['location'] })
  })

  it('selskapsinfo valideres og ryddes', async () => {
    await work(ola, [job('Syrlig', { founder: true })])
    const { id } = (await companyBySlug('syrlig'))!
    const save = (patch: Partial<CompanyInput>) => updateCompany(db, ola, id, { ...info, ...patch })

    await expect(save({ name: ' ' })).rejects.toThrow('Skriv inn selskapet')
    await expect(save({ name: '!!!' })).rejects.toThrow('bokstaver eller tall')
    await expect(save({ website: 'javascript:alert(1)' })).rejects.toThrow('nettadresse')
    await expect(save({ website: 'ftp://syrlig.no' })).rejects.toThrow('nettadresse')
    await expect(save({ website: 'syrlig' })).rejects.toThrow('nettadresse')
    await expect(save({ foundedYear: 1700 })).rejects.toThrow('årstall')
    await expect(save({ foundedYear: new Date().getFullYear() + 2 })).rejects.toThrow('fram i tid')
    await expect(save({ tagline: 'x'.repeat(141) })).rejects.toThrow('140')
    await expect(save({ status: 'konkurs' as never })).rejects.toThrow()

    await save({
      website: 'www.Syrlig.no/',
      tagline: '  Syretester\nfor gründere ',
      industries: ['energi', 'Energi', 'B2B'],
      location: ' Trondheim ',
      foundedYear: 2016,
      status: 'acquired',
    })
    expect(await getEditableCompany(db, ola, 'syrlig')).toMatchObject({
      website: 'https://www.syrlig.no',
      tagline: 'Syretester for gründere',
      industries: ['Energi', 'B2B'],
      location: 'Trondheim',
      foundedYear: 2016,
      status: 'acquired',
      adminEdit: false,
      canMerge: false,
    })
    expect(await page(kari, 'syrlig')).toMatchObject({ websiteLabel: 'syrlig.no' })
    // Lange bransjenavn fra Enhetsregisteret stopper ikke andre endringer.
    const nace = 'Forskning og eksperimentell utvikling innenfor naturvitenskap og teknikk'
    await save({ industries: [nace, 'Energi'] })
    await save({ industries: [nace, 'Energi'], tagline: 'Syretester for gründere og forskere' })
    expect(await getEditableCompany(db, ola, 'syrlig')).toMatchObject({
      industries: [nace, 'Energi'],
      tagline: 'Syretester for gründere og forskere',
    })
    await expect(save({ industries: ['x'.repeat(151)] })).rejects.toThrow('150')
    await save({ website: 'http://syrlig.no/om-oss?ref=esaf' })
    expect((await page(kari, 'syrlig')).website).toBe('http://syrlig.no/om-oss?ref=esaf')
  })

  it('nytt navn gir ny slug, gamle lenker og skrivemåter finner fram, og navn kan ikke tas', async () => {
    await work(ola, [job('Syrlig', { founder: true })])
    await work(kari, [job('Kahoot!')])
    const { id } = (await companyBySlug('syrlig'))!

    expect(await updateCompany(db, ola, id, { ...info, name: 'Syrlig Labs' })).toEqual({
      slug: 'syrlig-labs',
    })
    expect(await getCompany(db, kari, 'syrlig')).toEqual({ movedTo: 'syrlig-labs' })
    expect(await page(kari, 'syrlig-labs')).toMatchObject({
      name: 'Syrlig Labs',
      formerNames: ['Syrlig'],
    })
    // Selskapsform er samme navn, ikke et nytt.
    await updateCompany(db, ola, id, { ...info, name: 'Syrlig Labs AS' })
    expect((await page(kari, 'syrlig-labs-as')).formerNames).toEqual(['Syrlig'])
    await updateCompany(db, ola, id, { ...info, name: 'Syrlig Labs' })

    await work(per, [job('syrlig')])
    expect((await getProfile(db, ola, per!.personId!)).experience[0]!.companyId).toBe(id)

    await expect(updateCompany(db, ola, id, { ...info, name: 'KAHOOT' })).rejects.toThrow(
      'hører allerede til Kahoot!',
    )
    // Tilbake til det gamle navnet går fint, og det er ikke lenger et tidligere navn.
    await updateCompany(db, ola, id, { ...info, name: 'Syrlig' })
    expect(await getCompany(db, kari, 'syrlig-labs')).toEqual({ movedTo: 'syrlig' })
    expect((await page(kari, 'syrlig')).formerNames).toEqual(['Syrlig Labs'])
  })

  it('et duplikat kan slås sammen som et tidligere navn, og tidligere navn kan rettes', async () => {
    await work(ola, [job('Fjordtek', { founder: true })])
    await work(kari, [job('Bølgepost')])
    await work(per, [job('Kahoot!')])
    const target = (await companyBySlug('fjordtek'))!
    const source = (await companyBySlug('bolgepost'))!

    await mergeCompanies(db, storage, admin, {
      sourceId: source.id,
      targetId: target.id,
      formerName: true,
    })
    expect((await page(kari, 'fjordtek')).formerNames).toEqual(['Bølgepost'])
    const [merged] = await db
      .select()
      .from(schema.auditEvent)
      .where(eq(schema.auditEvent.action, 'company.merge'))
    expect(merged!.details).toMatchObject({ formerName: true })
    // Søket finner selskapet på det gamle navnet, også en del av det.
    const hits = await searchCompanies(db, kari, 'bølgep')
    expect(hits.map((h) => [h.slug, h.formerNames])).toEqual([['fjordtek', ['Bølgepost']]])

    // Gründeren retter listen selv; et nytt navn blir et alias.
    expect(
      await setCompanyFormerNames(db, ola, target.id, ['Fjordtek Labs', 'Bølgepost', 'bolgepost']),
    ).toEqual({ formerNames: ['Fjordtek Labs', 'Bølgepost'] })
    expect(await getCompany(db, kari, 'fjordtek-labs')).toEqual({ movedTo: 'fjordtek' })
    // Det nåværende navnet er ikke et tidligere navn.
    expect(await setCompanyFormerNames(db, ola, target.id, ['Fjordtek AS', 'Bølgepost'])).toEqual({
      formerNames: ['Bølgepost'],
    })
    // Et navn et annet selskap har, er et duplikat og må slås sammen.
    await expect(setCompanyFormerNames(db, admin, target.id, ['Kahoot'])).rejects.toThrow(
      '«Kahoot» er Kahoot!, et annet selskap',
    )
    expect(await denial(setCompanyFormerNames(db, per, target.id, []))).toBe('forbidden')
    await expect(
      setCompanyFormerNames(
        db,
        ola,
        target.id,
        Array.from({ length: 11 }, (_, i) => `Navn ${i}`),
      ),
    ).rejects.toThrow('ti tidligere navn')
    // Admins som ikke er knyttet til selskapet, logges.
    await setCompanyFormerNames(db, admin, target.id, [])
    const [edit] = await db
      .select()
      .from(schema.auditEvent)
      .where(eq(schema.auditEvent.action, 'company.admin_edit'))
    expect(edit!.details).toMatchObject({
      fields: ['formerNames'],
      previousFormerNames: ['Bølgepost'],
    })
  })

  it('admin kan slå sammen to skrivemåter, og den gamle finner fram etterpå', async () => {
    await work(ola, [job('Kahoot!', { title: 'Produktsjef' })])
    await work(kari, [], { esCompany: 'Kahoot ASA' })
    const target = (await companyBySlug('kahoot'))!
    const source = (await companyBySlug('kahoot-asa'))!
    await updateCompany(db, kari, source.id, {
      ...info,
      name: 'Kahoot ASA',
      tagline: 'Læringsspill',
      industries: ['Utdanning'],
    })

    expect(
      await denial(mergeCompanies(db, storage, ola, { sourceId: source.id, targetId: target.id })),
    ).toBe('forbidden')
    await expect(
      mergeCompanies(db, storage, admin, { sourceId: target.id, targetId: target.id }),
    ).rejects.toThrow('annet selskap')

    expect(
      await mergeCompanies(db, storage, admin, { sourceId: source.id, targetId: target.id }),
    ).toEqual({
      slug: 'kahoot',
    })
    expect(await companyBySlug('kahoot-asa')).toBeUndefined()
    const merged = await page(per, 'kahoot')
    expect(merged).toMatchObject({
      name: 'Kahoot!',
      tagline: 'Læringsspill',
      industries: ['Utdanning'],
      esCompany: true,
    })
    expect(merged.people.map((p) => p.role).sort()).toEqual(['current', 'es'])
    expect(await getCompany(db, per, 'kahoot-asa')).toEqual({ movedTo: 'kahoot' })

    await work(per, [job('Kahoot ASA')])
    expect((await getProfile(db, ola, per!.personId!)).experience[0]!.companyId).toBe(target.id)

    const [event] = await db
      .select()
      .from(schema.auditEvent)
      .where(eq(schema.auditEvent.action, 'company.merge'))
    expect(event!.details).toMatchObject({
      from: { slug: 'kahoot-asa' },
      into: { slug: 'kahoot' },
      esTeam: 1,
      formerName: false,
    })
    // En annen skrivemåte er ikke et tidligere navn.
    expect(merged.formerNames).toEqual([])
  })

  it('selskapssiden viser bare aktive medlemmer, med rolle, stilling, år og kull', async () => {
    const [es2016] = await db.insert(schema.cohort).values({ graduationYear: 2016 }).returning()
    await db.insert(schema.personCohort).values({ personId: ola!.personId!, cohortId: es2016!.id })
    await work(ola, [job('Syrlig', { founder: true, title: 'Daglig leder', startYear: 2016 })], {
      esCompany: 'Syrlig',
    })
    await work(kari, [job('Syrlig', { title: 'CTO', startYear: 2018, endYear: 2021 })])
    await work(per, [job('Syrlig', { title: 'Utvikler', startYear: 2022 })])
    // En som venter på godkjenning, vises ikke.
    const pending = await loadViewer(db, await account('Ventende'))
    await db.insert(schema.experience).values({
      personId: pending!.personId!,
      companyId: (await companyBySlug('syrlig'))!.id,
    })

    const syrlig = await page(per, 'syrlig')
    expect(syrlig).toMatchObject({
      startedByAlumni: true,
      esCompany: true,
      cohortYears: [2016],
      connected: true,
    })
    expect(
      syrlig.people.map(({ fullName, role, title, startYear, endYear, cohortYears }) => ({
        fullName,
        role,
        title,
        startYear,
        endYear,
        cohortYears,
      })),
    ).toEqual([
      {
        fullName: 'Ola',
        role: 'founder',
        title: 'Daglig leder',
        startYear: 2016,
        endYear: null,
        cohortYears: [2016],
      },
      {
        fullName: 'Per',
        role: 'current',
        title: 'Utvikler',
        startYear: 2022,
        endYear: null,
        cohortYears: [],
      },
      {
        fullName: 'Kari',
        role: 'past',
        title: 'CTO',
        startYear: 2018,
        endYear: 2021,
        cohortYears: [],
      },
    ])
    expect((await page(kari, 'syrlig')).connected).toBe(false)

    const [listed] = await listCompanies(db, kari)
    expect(listed).toMatchObject({ slug: 'syrlig', startedByAlumni: true, cohortYears: [2016] })
    expect(listed!.people).toHaveLength(3)
    await expect(getCompany(db, kari, 'finnes-ikke')).rejects.toThrow('Fant ikke')
  })

  it('søket finner selskapet uansett skrivemåte, med samme selskap først', async () => {
    await work(ola, [job('Kahoot!')])
    await work(kari, [job('Kahoot!')])
    await work(per, [job('Kahootify'), job('Løypa')])

    const hits = await searchCompanies(db, ola, 'kahoot')
    expect(hits.map((h) => [h.name, h.exact, h.people])).toEqual([
      ['Kahoot!', true, 2],
      ['Kahootify', false, 1],
    ])
    expect((await searchCompanies(db, ola, 'Loypa'))[0]).toMatchObject({
      name: 'Løypa',
      exact: true,
    })
    // Et lengre navn foreslår selskapet det begynner med, men regnes ikke som samme selskap.
    expect(await searchCompanies(db, ola, 'Kahoot ASA')).toMatchObject([
      { name: 'Kahoot!', exact: false },
    ])
    expect(await searchCompanies(db, ola, '  ')).toEqual([])
    expect(await denial(searchCompanies(db, null, 'kahoot'))).toBe('unauthenticated')
  })

  it('import fra kullisten kobler selskaper og ES-selskap som appen', async () => {
    await work(ola, [job('Kahoot!')])
    const sheet = parseProfileSheet(
      [
        'navn,kull,epost,arbeidsgiver,stilling,es',
        'Anne Arket,2015,anne@example.test,kahoot,Utvikler,Fjordflow',
        'Bjørn Arket,2015,bjorn@example.test,Nytt Selskap,CTO,FjordFlow',
        'Cecilie Arket,2015,cecilie@example.test,nytt selskap,,',
      ].join('\n'),
      {
        yearKind: 'graduation',
        columns: { currentCompany: 'arbeidsgiver', jobTitle: 'stilling', esCompany: 'es' },
      },
    )
    await applyProfileImport(db, await planProfileImport(db, sheet.rows), {
      membershipStatus: 'active',
      sourceLabel: 'test.csv',
    })
    const names = (await db.select().from(schema.company)).map((c) => c.name).sort()
    expect(names).toEqual(['Fjordflow', 'Kahoot!', 'Nytt Selskap'])
    const kahoot = await page(kari, 'kahoot')
    expect(kahoot.people.map((p) => p.fullName).sort()).toEqual(['Anne Arket', 'Ola'])
    expect((await page(kari, 'fjordflow')).people.map((p) => p.role)).toEqual(['es', 'es'])
  })
})
