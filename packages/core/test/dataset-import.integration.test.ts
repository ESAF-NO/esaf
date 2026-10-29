import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb, loadRootEnv, runMigrations, schema, type Db } from '@esaf/db'
import { eq, sql } from 'drizzle-orm'
import sharp from 'sharp'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  allDatasetOptions,
  applyDatasetImport,
  countImportRecords,
  createDiskStorage,
  decideMembership,
  deleteCompanyArticle,
  getCompany,
  getProfile,
  grantRoleAsOperator,
  loadViewer,
  previewDatasetImport,
  readDatasetBundle,
  updateCompany,
  writeDatasetBundle,
  type CompanyDetails,
  type Dataset,
  type DatasetBundle,
  type DatasetOptions,
  type ObjectStorage,
  type Viewer,
} from '../src/index.ts'

loadRootEnv()
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

// En liten, oppdiktet bunt. Ekte data fra berikelsen skal aldri ligge i repoet.

const source = (label: string) => ({
  label,
  url: `https://${label}/`,
  fetchedAt: '2026-10-01T10:00:00.000Z',
})

function fakeDataset(): Dataset {
  return {
    companies: [
      {
        key: 'company:syrlig',
        name: 'Syrlig',
        tagline: 'Fermentert brus fra Trøndelag',
        description: 'Syrlig lager brus.',
        website: 'https://syrlig.example',
        foundedYear: 2018,
        location: 'Trondheim',
        industries: ['Mat og drikke'],
        status: 'active',
        lastSeenOnEsSite: '2024-02-29',
        logo: {
          file: 'images/logos/syrlig.png',
          source: source('syrlig.example'),
          confidence: 'high',
        },
        fieldSources: {
          tagline: { confidence: 'medium', sources: [source('solan.example')] },
          website: { confidence: 'medium', sources: [source('syrlig.example')] },
          status: { confidence: 'high', sources: [source('register.example')] },
        },
        timeline: [
          {
            date: '2018-03-01',
            type: 'founded',
            text: 'Syrlig AS stiftet.',
            source: source('register.example'),
            confidence: 'high',
          },
          {
            date: '2021',
            type: 'funding',
            text: 'Hentet penger, ifølge en avis.',
            source: source('avis.example'),
            confidence: 'low',
          },
        ],
        articles: [
          {
            url: 'https://avis.example/syrlig?utm_source=x',
            title: 'Syrlig vokser',
            date: '2021-05',
            publisher: 'Avisa',
            paywall: true,
            mentionsES: true,
          },
          // Samme sak to ganger, og en ugyldig lenke.
          {
            url: 'http://www.avis.example/syrlig',
            title: 'Syrlig vokser',
            date: null,
            publisher: null,
            paywall: false,
            mentionsES: false,
          },
          {
            url: 'javascript:alert(1)',
            title: 'Feil',
            date: null,
            publisher: null,
            paywall: false,
            mentionsES: false,
          },
        ],
      },
      {
        key: 'company:bolle',
        name: 'Bolle AS',
        tagline: null,
        description: null,
        website: null,
        foundedYear: null,
        location: null,
        industries: [],
        status: 'unknown',
        lastSeenOnEsSite: null,
        logo: null,
        fieldSources: {},
        timeline: [],
        articles: [
          {
            url: 'https://blogg.example/bolle',
            title: 'Bolle åpner',
            date: null,
            publisher: null,
            paywall: false,
            mentionsES: false,
          },
        ],
      },
    ],
    people: [
      {
        key: 'person:ola-2019',
        fullName: 'Ola Testesen',
        graduationYears: [2019],
        emails: ['ola@example.test'],
        phone: '+47 400 00 001',
        linkedinUrl: 'https://www.linkedin.com/in/ola-testesen',
        studyBackground: 'Kjemi',
        bio: 'Lager brus.',
        expertise: ['Fermentering'],
        industries: ['Mat og drikke'],
        photo: {
          file: 'images/photos/ola.jpg',
          source: source('skole.example'),
          confidence: 'high',
        },
        companies: [
          {
            companyKey: 'company:syrlig',
            role: 'founder',
            title: 'Daglig leder',
            startYear: 2018,
            endYear: null,
          },
          {
            companyKey: 'company:bolle',
            role: 'es',
            title: 'ES-team',
            startYear: null,
            endYear: 2019,
          },
        ],
        fieldSources: {
          bio: { confidence: 'high', sources: [source('skole.example')] },
          experience: { confidence: 'high', sources: [source('register.example')] },
          esCompany: { confidence: 'high', sources: [source('skole.example')] },
        },
      },
      {
        // Har tatt i bruk profilen sin i appen (samme e-post).
        key: 'person:kari-2019',
        fullName: 'Kari Testesen',
        graduationYears: [2019],
        emails: ['kari@example.test', 'kari.ny@example.test'],
        phone: '+47 400 00 002',
        linkedinUrl: null,
        studyBackground: 'Fysikk',
        bio: 'Bio fra nettsiden.',
        expertise: [],
        industries: [],
        photo: { file: 'images/photos/kari.jpg', source: null, confidence: 'high' },
        companies: [
          {
            companyKey: 'company:syrlig',
            role: 'employee',
            title: 'Selger',
            startYear: 2020,
            endYear: null,
          },
        ],
        fieldSources: { bio: { confidence: 'high', sources: [source('skole.example')] } },
      },
    ],
    quotes: [
      {
        key: 'quote:1',
        text: 'ES lærte oss å teste før vi bygde.',
        speakerName: 'Ola Testesen',
        speakerRole: 'Daglig leder i Syrlig',
        date: null,
        personKey: 'person:ola-2019',
        companyKey: 'company:syrlig',
        source: source('skole.example'),
        confidence: 'high',
      },
      {
        key: 'quote:2',
        text: 'Kanskje noen sa dette.',
        speakerName: 'Ukjent',
        speakerRole: null,
        date: null,
        personKey: null,
        companyKey: 'company:syrlig',
        source: null,
        confidence: 'low',
      },
    ],
  }
}

async function fakeImages() {
  const photo = (r: number) =>
    sharp({ create: { width: 400, height: 500, channels: 3, background: { r, g: 90, b: 60 } } })
      .jpeg()
      .toBuffer()
  const logo = await sharp({
    create: {
      width: 300,
      height: 100,
      channels: 4,
      background: { r: 200, g: 30, b: 30, alpha: 1 },
    },
  })
    .png()
    .toBuffer()
  return new Map<string, Uint8Array>([
    ['images/photos/ola.jpg', await photo(200)],
    ['images/photos/kari.jpg', await photo(120)],
    ['images/logos/syrlig.png', logo],
  ])
}

/** Bunten slik importen får den: skrevet og lest på nytt, som fra en fil. */
async function bundleOf(data: Dataset): Promise<DatasetBundle> {
  const { archive } = writeDatasetBundle(data, await fakeImages())
  return readDatasetBundle(archive)
}

const all = allDatasetOptions

describe.skipIf(!url)('import av datasettbunten', () => {
  let db: Db
  let dir: string
  let storage: ObjectStorage
  let admin: Viewer
  let kari: Viewer

  beforeAll(async () => {
    await runMigrations(url!)
    db = createDb(url!)
  })
  afterAll(() => db?.close())

  async function account(name: string, email: string) {
    const id = randomUUID()
    await db.insert(schema.user).values({ id, name, email, emailVerified: true })
    return id
  }

  beforeEach(async () => {
    await db.execute(
      sql`truncate ${schema.importRecord}, ${schema.fieldSource}, ${schema.auditEvent}, ${schema.quote}, ${schema.membership}, ${schema.personCohort}, ${schema.person}, ${schema.cohort}, ${schema.user}, ${schema.company} cascade`,
    )
    dir = await mkdtemp(join(tmpdir(), 'esaf-import-'))
    storage = createDiskStorage(dir)
    const adminId = await account('Admin', 'admin@example.test')
    await grantRoleAsOperator(db, { email: 'admin@example.test', reason: 'test', role: 'admin' })
    await db.update(schema.user).set({ twoFactorEnabled: true }).where(eq(schema.user.id, adminId))
    admin = await loadViewer(db, adminId)
    // Kari har registrert seg og er godkjent: profilen er tatt i bruk.
    const pending = await loadViewer(db, await account('Kari Testesen', 'kari@example.test'))
    await decideMembership(db, admin, { personId: pending!.personId!, decision: 'approve' })
    kari = await loadViewer(db, pending!.userId)
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  /** Alt importen kan endre, så to øyeblikksbilder kan sammenlignes. */
  async function snapshot() {
    const tables = {
      person: schema.person,
      membership: schema.membership,
      personEmail: schema.personEmail,
      personCohort: schema.personCohort,
      cohort: schema.cohort,
      experience: schema.experience,
      company: schema.company,
      companyEvent: schema.companyEvent,
      companyArticle: schema.companyArticle,
      quote: schema.quote,
      fieldSource: schema.fieldSource,
      importRecord: schema.importRecord,
      auditEvent: schema.auditEvent,
    }
    const result: Record<string, unknown[]> = {}
    for (const [name, table] of Object.entries(tables)) {
      const rows = await db.select().from(table)
      result[name] = rows.map((r) => JSON.stringify(r)).sort()
    }
    return result
  }

  const files = async () =>
    (await readdir(dir, { recursive: true, withFileTypes: true }))
      .filter((f) => f.isFile())
      .map((f) => join(f.parentPath, f.name).slice(dir.length + 1))
      .sort()

  const run = (bundle: DatasetBundle, options: DatasetOptions = all) =>
    applyDatasetImport(db, storage, bundle, options, 'test.tar.gz')

  async function companyPage(viewer: Viewer, slug: string) {
    const found = await getCompany(db, viewer, slug)
    if ('movedTo' in found) throw new Error('flyttet')
    return found as CompanyDetails
  }

  async function personByName(fullName: string) {
    const [row] = await db.select().from(schema.person).where(eq(schema.person.fullName, fullName))
    return row
  }

  it('forhåndsvisningen skriver ingenting, verken i databasen eller lagringen', async () => {
    const bundle = await bundleOf(fakeDataset())
    const before = await snapshot()
    const { report, images } = await previewDatasetImport(db, bundle, all, 'test.tar.gz')
    expect(await snapshot()).toEqual(before)
    expect(await files()).toEqual([])
    expect(report.counts).toMatchObject({
      companies: { created: 2, updated: 0, unchanged: 0, skipped: 0 },
      logos: { created: 1 },
      events: { created: 2 },
      articles: { created: 2, unchanged: 1, skipped: 1 },
      people: { created: 1, skipped: 1 },
      photos: { created: 1 },
      quotes: { created: 2 },
    })
    expect(report.matching).toMatchObject({ byEmail: 1, created: 1, claimed: 1 })
    // Bare bildene som skal inn, er behandlet: logoen og Olas bilde, ikke Karis.
    expect([...images.keys()].sort()).toEqual(['logo:company:syrlig', 'photo:person:ola-2019'])
  })

  it('lagrer alt, med bildene i lagringen, og en ny kjøring endrer ingenting', async () => {
    const bundle = await bundleOf(fakeDataset())
    const report = await run(bundle)
    expect(report.counts.companies.created).toBe(2)
    expect(report.counts.people.created).toBe(1)

    // Selskapet, med logo, historikk og saker i media.
    const syrlig = await companyPage(admin, 'syrlig')
    expect(syrlig).toMatchObject({
      name: 'Syrlig',
      tagline: 'Fermentert brus fra Trøndelag',
      website: 'https://syrlig.example',
      status: 'active',
      foundedYear: 2018,
    })
    expect(syrlig.logo).not.toBeNull()
    expect(syrlig.articles).toEqual([
      expect.objectContaining({
        url: 'https://avis.example/syrlig',
        title: 'Syrlig vokser',
        publisher: 'Avisa',
        publishedAt: '2021-05-01',
        publishedPrecision: 'month',
        paywall: true,
        mentionsEs: true,
      }),
    ])
    const [article] = await db
      .select()
      .from(schema.companyArticle)
      .where(eq(schema.companyArticle.companyId, syrlig.id))
    expect(article).toMatchObject({ source: 'import', addedByPersonId: null })
    // Usikre hendelser og sitater forblir skjult for vanlige medlemmer.
    expect(syrlig.events.map((e) => [e.text, e.review])).toEqual([
      ['Hentet penger, ifølge en avis.', true],
      ['Syrlig AS stiftet.', false],
    ])
    const forKari = await companyPage(kari, 'syrlig')
    expect(forKari.events.map((e) => e.text)).toEqual(['Syrlig AS stiftet.'])
    expect(forKari.quotes.map((q) => q.text)).toEqual(['ES lærte oss å teste før vi bygde.'])
    expect(forKari.sources.map((s) => `${s.field}:${s.label}`)).toContain('tagline:solan.example')

    // Ola: ny profil med bilde, erfaring, ES-selskap, kull, e-post og skjult kontaktinfo.
    const ola = await personByName('Ola Testesen')
    expect(ola).toMatchObject({
      source: 'import',
      userId: null,
      bio: 'Lager brus.',
      phone: '+47 400 00 001',
      contactEmail: 'ola@example.test',
      phoneVisible: false,
      contactEmailVisible: false,
    })
    expect(ola!.photoKey).not.toBeNull()
    expect((await companyPage(admin, 'bolle-as')).people.map((p) => [p.fullName, p.role])).toEqual([
      ['Ola Testesen', 'es'],
    ])
    const profile = await getProfile(db, kari, ola!.id)
    expect(profile.experience.map((e) => [e.company, e.title, e.founder])).toEqual([
      ['Syrlig', 'Daglig leder', true],
    ])
    expect(profile.cohorts.map((c) => c.graduationYear)).toEqual([2019])

    // Bildene ligger i lagringen, i begge størrelser.
    expect(await files()).toEqual(
      [
        `logoer/${syrlig.logo!.small.split('/').at(-1)}`,
        `logoer/${syrlig.logo!.large.split('/').at(-1)}`,
        `profilbilder/${ola!.photoKey}-192.webp`,
        `profilbilder/${ola!.photoKey}-512.webp`,
      ].sort(),
    )

    const [logged] = await db
      .select()
      .from(schema.auditEvent)
      .where(eq(schema.auditEvent.action, 'operator.import_dataset'))
    expect(logged).toMatchObject({
      actorPersonId: null,
      details: { source: 'test.tar.gz', options: [] },
    })

    // Samme bunt igjen: ingenting endres, og ingen nye filer.
    const before = await snapshot()
    const filesBefore = await files()
    const again = await run(bundle)
    for (const counts of Object.values(again.counts)) {
      expect(counts.created + counts.updated).toBe(0)
    }
    expect(await snapshot()).toEqual(before)
    expect(await files()).toEqual(filesBefore)
  })

  it('rører ikke profiler som er tatt i bruk', async () => {
    const before = await db
      .select()
      .from(schema.person)
      .where(eq(schema.person.id, kari!.personId!))
    const emailsBefore = await db.select().from(schema.personEmail)
    await run(await bundleOf(fakeDataset()))
    expect(
      await db.select().from(schema.person).where(eq(schema.person.id, kari!.personId!)),
    ).toEqual(before)
    expect(
      await db
        .select()
        .from(schema.personEmail)
        .where(eq(schema.personEmail.personId, kari!.personId!)),
    ).toEqual(emailsBefore.filter((e) => e.personId === kari!.personId))
    for (const table of [schema.experience, schema.personCohort] as const) {
      expect(await db.select().from(table).where(eq(table.personId, kari!.personId!))).toEqual([])
    }
    expect(
      await db
        .select()
        .from(schema.fieldSource)
        .where(eq(schema.fieldSource.entityId, kari!.personId!)),
    ).toEqual([])
  })

  it('--bare-selskaper skriver ingen persondata', async () => {
    const people = await db.select().from(schema.person)
    const report = await run(await bundleOf(fakeDataset()), { ...all, onlyCompanies: true })
    expect(report.counts.companies.created).toBe(2)
    expect(report.counts.articles.created).toBe(2)
    expect(report.counts.logos.created).toBe(1)
    expect(report.counts.events.created).toBe(2)
    expect(await db.select().from(schema.person)).toEqual(people)
    for (const table of [
      schema.experience,
      schema.quote,
      schema.personCohort,
      schema.cohort,
    ] as const) {
      expect(await db.select().from(table)).toEqual([])
    }
    expect(
      await db.select().from(schema.fieldSource).where(eq(schema.fieldSource.entityType, 'person')),
    ).toEqual([])
    expect((await files()).every((f) => f.startsWith('logoer/'))).toBe(true)

    // Personene kan tas inn senere, med samme bunt.
    const later = await run(await bundleOf(fakeDataset()))
    expect(later.counts.companies).toMatchObject({ created: 0, updated: 0, unchanged: 2 })
    expect(later.counts.people.created).toBe(1)
  })

  it('uten profilbilder, bio og sitater', async () => {
    await run(await bundleOf(fakeDataset()), {
      onlyCompanies: false,
      photos: false,
      bio: false,
      quotes: false,
    })
    expect(await personByName('Ola Testesen')).toMatchObject({ bio: null, photoKey: null })
    expect(await db.select().from(schema.quote)).toEqual([])
    expect((await files()).some((f) => f.startsWith('profilbilder/'))).toBe(false)
  })

  it('tar ikke inn igjen det som er rettet eller slettet i appen', async () => {
    await run(await bundleOf(fakeDataset()))
    const syrlig = await companyPage(admin, 'syrlig')
    // En admin sletter en sak, skriver om slagordet og tømmer stedet; et sitat og et bilde fjernes.
    await deleteCompanyArticle(db, admin, syrlig.articles[0]!.id)
    await updateCompany(db, admin, syrlig.id, {
      name: 'Syrlig',
      tagline: 'Skrevet av en admin',
      description: syrlig.description ?? '',
      website: syrlig.website ?? '',
      foundedYear: syrlig.foundedYear,
      location: '',
      industries: syrlig.industries,
      status: syrlig.status,
    })
    await db.delete(schema.quote)
    await db
      .update(schema.person)
      .set({ photoKey: null })
      .where(eq(schema.person.fullName, 'Ola Testesen'))

    const report = await run(await bundleOf(fakeDataset()))
    expect(report.counts.articles.created).toBe(0)
    expect(report.counts.quotes.created).toBe(0)
    expect(report.counts.photos).toMatchObject({ created: 0, skipped: 1 })
    expect(await companyPage(admin, 'syrlig')).toMatchObject({
      tagline: 'Skrevet av en admin',
      location: null,
      articles: [],
    })
  })

  it('oppdaterer felt bare importen har fylt, og bare så lenge ingen har rørt dem', async () => {
    await run(await bundleOf(fakeDataset()))
    const changed = fakeDataset()
    changed.companies[0]!.tagline = 'Ny tekst fra berikelsen'
    changed.companies[0]!.website = 'https://ny.syrlig.example'
    changed.companies[0]!.timeline.push({
      date: '2023-09-12',
      type: 'award',
      text: 'Vant en pris.',
      source: null,
      confidence: 'high',
    })
    // Admin har sett over nettsiden under Gjennomgang; den skal stå.
    const syrlig = await companyPage(admin, 'syrlig')
    await db
      .update(schema.fieldSource)
      .set({ reviewedAt: new Date() })
      .where(eq(schema.fieldSource.field, 'website'))

    const report = await run(await bundleOf(changed))
    expect(report.counts.companies).toMatchObject({ updated: 1, unchanged: 1 })
    expect(report.counts.events.created).toBe(1)
    const after = await companyPage(admin, 'syrlig')
    expect(after.tagline).toBe('Ny tekst fra berikelsen')
    expect(after.website).toBe(syrlig.website)
    expect(after.sources.filter((s) => s.field === 'tagline').map((s) => s.confirmed)).toEqual([
      false,
    ])
  })

  it('fyller tomme felt på selskaper som finnes, men skriver aldri over det medlemmer har skrevet', async () => {
    await db.insert(schema.company).values({
      slug: 'syrlig',
      name: 'Syrlig',
      tagline: 'Skrevet av gründeren',
      status: 'active',
      editedAt: new Date('2025-01-01'),
    })
    const report = await run(await bundleOf(fakeDataset()))
    expect(report.counts.companies).toMatchObject({ created: 1, updated: 1 })
    expect(await companyPage(admin, 'syrlig')).toMatchObject({
      tagline: 'Skrevet av gründeren',
      website: 'https://syrlig.example',
      location: 'Trondheim',
    })
  })

  it('rydder bort bildene hvis databasen feiler, og lagrer ingenting', async () => {
    await db.execute(sql`create or replace function esaf_test_fail() returns trigger language plpgsql as $$
      begin raise exception 'testfeil'; end $$`)
    try {
      const bundle = await bundleOf(fakeDataset())
      const preview = await previewDatasetImport(db, bundle, all, 'test.tar.gz')
      await db.execute(
        sql`create trigger esaf_test_fail before insert on quote for each row execute function esaf_test_fail()`,
      )
      const before = await snapshot()
      await expect(
        applyDatasetImport(db, storage, bundle, all, 'test.tar.gz', preview.images),
      ).rejects.toThrow(/insert into "quote"/)
      expect(await snapshot()).toEqual(before)
      expect(await files()).toEqual([])
      expect(await countImportRecords(db)).toBe(0)
    } finally {
      await db.execute(sql`drop trigger if exists esaf_test_fail on quote`)
      await db.execute(sql`drop function if exists esaf_test_fail()`)
    }
  })
})
