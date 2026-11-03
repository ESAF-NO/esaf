import { createHash, randomBytes } from 'node:crypto'
import { schema, type Db, type ImportRecordKind, type SourceConfidence } from '@esaf/db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { companySlug, isCompanyName } from './companies.ts'
import { articleUrlKey, articleValues, companyArticleInput } from './company-articles.ts'
import {
  describeDatasetOptions,
  filterDataset,
  type Dataset,
  type DatasetBundle,
  type DatasetCompany,
  type DatasetOptions,
  type DatasetPerson,
  type DatasetSource,
} from './dataset.ts'
import {
  deleteLogoFiles,
  processCompanyLogo,
  putProcessedLogo,
  type ProcessedLogo,
} from './logos.ts'
import type { Tx } from './members.ts'
import {
  deletePhotoFiles,
  processProfilePhoto,
  putProcessedPhoto,
  type ProcessedPhoto,
} from './photos.ts'
import { planProfileImport, type ProfileRow } from './profile-import.ts'
import { sourceKeyFor } from './sources.ts'
import { safeHttpUrl } from './validation.ts'
import type { ObjectStorage } from './storage.ts'

const {
  auditEvent,
  cohort,
  company,
  companyArticle,
  companyEvent,
  experience,
  fieldSource,
  importRecord,
  membership,
  person,
  personCohort,
  personEmail,
  quote,
} = schema

/**
 * Import av datasettbunten (`pnpm data:import`). Reglene:
 *
 * - **Forhåndsvisning først.** Importen kjøres alltid i en transaksjon som rulles
 *   tilbake, så tallene er nøyaktig det som blir skrevet. Bildene behandles
 *   (samme behandling som en opplasting), men lastes ikke opp.
 * - **Lagring i én transaksjon.** Bildene lastes opp først; feiler noe i
 *   databasen, slettes de igjen, som ved en vanlig opplasting.
 * - **Idempotent.** `import_record` husker hva som er tatt inn. Kjøres samme bunt
 *   på nytt, endres ingenting. Det som er tatt inn én gang og så rettet eller
 *   slettet i appen (en hendelse, en sak, et sitat, et bilde, en logo, et selskap
 *   eller en person), tas aldri inn igjen.
 * - **Overskriver aldri det medlemmer har gjort.** Personer kjennes igjen som i
 *   kullisteimporten (e-post, så navn og kull). Profiler noen har tatt i bruk,
 *   røres ikke. På andre profiler og på selskaper fylles tomme felt, og et felt
 *   importen selv har fylt, oppdateres bare så lenge ingen har bekreftet, sett
 *   over, rettet eller tømt det (kildene i `field_source` sier det). Navn endres aldri.
 * - **Usikre data forblir skjult.** Hendelser og sitater med lav sikkerhet lagres
 *   med `confidence = low`, og vises bare for dem som kan rette dem.
 */

type Confidence = SourceConfidence

export type EntityCounts = { created: number; updated: number; unchanged: number; skipped: number }

export const datasetEntities = [
  'companies',
  'logos',
  'events',
  'articles',
  'people',
  'photos',
  'quotes',
  'sources',
] as const
export type DatasetEntity = (typeof datasetEntities)[number]

export type DatasetImportReport = {
  counts: Record<DatasetEntity, EntityCounts>
  /** Hvordan personene i bunten ble kjent igjen. */
  matching: {
    byEmail: number
    byName: number
    /** Kjent fra en tidligere import, men ikke av e-post eller navn og kull nå. */
    byEarlierImport: number
    created: number
    /** Har tatt i bruk profilen; da røres den ikke. */
    claimed: number
  }
  warnings: string[]
}

type ImageKind = 'photo' | 'logo'
type ImageRequest = { kind: ImageKind; datasetKey: string; file: string }
/** Gir nøkkelen bildet skal få, eller `null` når det ikke kan brukes. */
type ImageProvider = (request: ImageRequest) => string | null

const emptyCounts = (): EntityCounts => ({ created: 0, updated: 0, unchanged: 0, skipped: 0 })

function newReport(): DatasetImportReport {
  return {
    counts: Object.fromEntries(datasetEntities.map((e) => [e, emptyCounts()])) as Record<
      DatasetEntity,
      EntityCounts
    >,
    matching: { byEmail: 0, byName: 0, byEarlierImport: 0, created: 0, claimed: 0 },
    warnings: [],
  }
}

/** Hvor mye som ble laget eller endret, i alt. */
export const changesIn = (report: DatasetImportReport) =>
  datasetEntities.reduce((n, e) => n + report.counts[e].created + report.counts[e].updated, 0)

// ---------------------------------------------------------------------------
// Hva importen har tatt inn før
// ---------------------------------------------------------------------------

/** SHA-256 av nøkkelen i datasettet, så navn ikke står i klartekst i databasen. */
const hashKey = (key: string) => createHash('sha256').update(key).digest('hex')

type RecordKind = ImportRecordKind

class Ledger {
  private constructor(
    private tx: Tx,
    private rows: Map<string, string | null>,
  ) {}

  static async load(tx: Tx) {
    const rows = await tx.select().from(importRecord)
    return new Ledger(tx, new Map(rows.map((r) => [`${r.kind}:${r.keyHash}`, r.entityId])))
  }

  private id(kind: RecordKind, key: string) {
    return `${kind}:${hashKey(key)}`
  }

  has(kind: RecordKind, key: string) {
    return this.rows.has(this.id(kind, key))
  }

  /** Raden importen laget eller kjente igjen, eller `undefined` om nøkkelen er ukjent. */
  entity(kind: RecordKind, key: string) {
    const id = this.id(kind, key)
    return this.rows.has(id) ? this.rows.get(id)! : undefined
  }

  /** Husker at nøkkelen er tatt inn. Gjør ingenting om den er kjent fra før. */
  async record(kind: RecordKind, key: string, entityId: string | null) {
    const id = this.id(kind, key)
    if (this.rows.has(id)) return
    this.rows.set(id, entityId)
    await this.tx
      .insert(importRecord)
      .values({ kind, keyHash: hashKey(key), entityId })
      .onConflictDoNothing()
  }
}

// ---------------------------------------------------------------------------
// Kilder
// ---------------------------------------------------------------------------

type EntityType = 'person' | 'company'
type SourceRow = typeof fieldSource.$inferSelect

/** Kildene i databasen per felt, for personene eller selskapene i importen. */
class Sources {
  private byField = new Map<string, SourceRow[]>()

  private constructor(
    private tx: Tx,
    private entityType: EntityType,
    private report: DatasetImportReport,
  ) {}

  static async load(tx: Tx, entityType: EntityType, report: DatasetImportReport) {
    const sources = new Sources(tx, entityType, report)
    const rows = await tx.select().from(fieldSource).where(eq(fieldSource.entityType, entityType))
    for (const row of rows) sources.list(row.entityId, row.field).push(row)
    return sources
  }

  private list(entityId: string, field: string) {
    const key = `${entityId}:${field}`
    let rows = this.byField.get(key)
    if (!rows) this.byField.set(key, (rows = []))
    return rows
  }

  /** Feltet har kilder fra en import, og ingen har bekreftet eller sett over det. */
  importOwned(entityId: string, field: string) {
    const rows = this.list(entityId, field)
    return rows.length > 0 && rows.every((r) => r.confirmedAt === null && r.reviewedAt === null)
  }

  has(entityId: string, field: string) {
    return this.list(entityId, field).length > 0
  }

  /** Kildene fra bunten, én per navn, med lenker bare når de er http eller https. */
  private normalize(sources: DatasetSource[]) {
    const seen = new Set<string>()
    return sources.flatMap((s) => {
      if (seen.has(s.label)) return []
      seen.add(s.label)
      return [
        {
          label: s.label,
          url: safeHttpUrl(s.url),
          fetchedAt: s.fetchedAt ? new Date(s.fetchedAt) : null,
        },
      ]
    })
  }

  /**
   * Feltet er nettopp fylt eller oppdatert av importen: kildene fra før gjaldt en
   * annen verdi, og byttes ut med kildene fra bunten.
   */
  async replace(entityId: string, field: string, sources: DatasetSource[], confidence: Confidence) {
    const existing = this.list(entityId, field)
    if (existing.length) {
      await this.tx
        .delete(fieldSource)
        .where(
          and(
            eq(fieldSource.entityType, this.entityType),
            eq(fieldSource.entityId, entityId),
            eq(fieldSource.field, field),
          ),
        )
      existing.length = 0
    }
    const rows = this.normalize(sources)
    if (!rows.length) return
    const inserted = await this.tx
      .insert(fieldSource)
      .values(
        rows.map((s) => ({
          entityType: this.entityType,
          entityId,
          field,
          sourceLabel: s.label,
          sourceUrl: s.url,
          sourceKey: sourceKeyFor(field, s.url),
          fetchedAt: s.fetchedAt,
          confidence,
        })),
      )
      .returning()
    existing.push(...inserted)
    this.report.counts.sources.created += inserted.length
  }

  /**
   * Feltet har samme verdi som i bunten. Kilder som står fra før, får lenke,
   * tidspunkt og sikkerhet fra bunten; nye kilder legges ikke til, og bekreftelser
   * røres aldri.
   */
  async refresh(entityId: string, field: string, sources: DatasetSource[], confidence: Confidence) {
    const existing = this.list(entityId, field)
    if (!existing.length) return
    for (const s of this.normalize(sources)) {
      const row = existing.find((r) => r.sourceLabel === s.label)
      if (!row) continue
      const same =
        row.sourceUrl === s.url &&
        (row.fetchedAt?.getTime() ?? null) === (s.fetchedAt?.getTime() ?? null) &&
        row.confidence === confidence
      if (same) {
        this.report.counts.sources.unchanged++
        continue
      }
      await this.tx
        .update(fieldSource)
        .set({ sourceUrl: s.url, fetchedAt: s.fetchedAt, confidence })
        .where(eq(fieldSource.id, row.id))
      Object.assign(row, { sourceUrl: s.url, fetchedAt: s.fetchedAt, confidence })
      this.report.counts.sources.updated++
    }
  }
}

// ---------------------------------------------------------------------------
// Felt: fylle tomme, oppdatere det importen eier
// ---------------------------------------------------------------------------

type FieldValue = string | number | string[] | null

const isEmpty = (v: FieldValue) => v === null || v === '' || (Array.isArray(v) && !v.length)
const sameValue = (a: FieldValue, b: FieldValue) =>
  Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((v, i) => v === b[i])
    : a === b

/**
 * Om importen skal skrive et felt. `same`: verdien står der allerede. `write`:
 * tomt felt, eller et felt importen har fylt før og som ingen har rørt siden.
 * `keep`: noen har skrevet, bekreftet, sett over eller tømt feltet.
 */
function decideField(
  current: FieldValue,
  next: FieldValue,
  {
    known,
    importOwned,
    hasSources,
    emptyValue,
  }: { known: boolean; importOwned: boolean; hasSources: boolean; emptyValue?: FieldValue },
): 'same' | 'write' | 'keep' {
  if (sameValue(current, next)) return 'same'
  const empty = isEmpty(current) || (emptyValue !== undefined && current === emptyValue)
  // Første gang: bare tomme felt uten kilder (en bekreftet kilde på et tomt felt betyr
  // at noen har tømt det med vilje).
  if (!known) return empty && !hasSources ? 'write' : 'keep'
  // Importen har fylt feltet før. Det oppdateres bare så lenge ingen har rørt det.
  return importOwned ? 'write' : 'keep'
}

// ---------------------------------------------------------------------------
// Selskaper
// ---------------------------------------------------------------------------

const companyFields = [
  'tagline',
  'description',
  'website',
  'foundedYear',
  'location',
  'industries',
  'status',
  'lastSeenOnEsSite',
] as const
type CompanyField = (typeof companyFields)[number]

type CompanyRow = Pick<
  typeof company.$inferSelect,
  'id' | 'slug' | 'aliasSlugs' | 'logoKey' | 'editedAt' | CompanyField
>

function companyValues(c: DatasetCompany): Record<CompanyField, FieldValue> {
  return {
    tagline: c.tagline,
    description: c.description,
    // Lagres slik den står i bunten, men bare http og https.
    website: safeHttpUrl(c.website) ? c.website : null,
    foundedYear: c.foundedYear,
    location: c.location,
    industries: c.industries.slice(0, 10),
    // Ukjent status er det samme som ingen status.
    status: c.status === 'unknown' ? null : c.status,
    lastSeenOnEsSite: c.lastSeenOnEsSite,
  }
}

const sourceOf = (fieldSources: DatasetCompany['fieldSources'], field: string) =>
  fieldSources[field] ?? null

async function importCompanies(
  tx: Tx,
  data: Dataset,
  ledger: Ledger,
  report: DatasetImportReport,
  images: ImageProvider,
) {
  const counts = report.counts.companies
  const sources = await Sources.load(tx, 'company', report)
  const rows: CompanyRow[] = await tx
    .select({
      id: company.id,
      slug: company.slug,
      aliasSlugs: company.aliasSlugs,
      logoKey: company.logoKey,
      editedAt: company.editedAt,
      tagline: company.tagline,
      description: company.description,
      website: company.website,
      foundedYear: company.foundedYear,
      location: company.location,
      industries: company.industries,
      status: company.status,
      lastSeenOnEsSite: company.lastSeenOnEsSite,
    })
    .from(company)
  const byId = new Map(rows.map((r) => [r.id, r]))
  const bySlug = new Map<string, CompanyRow>()
  // Et selskap som har slugen som navn, går foran et som har den som alias.
  for (const r of rows) for (const alias of r.aliasSlugs) bySlug.set(alias, r)
  for (const r of rows) bySlug.set(r.slug, r)

  const companyIds = new Map<string, string>()
  for (const c of data.companies) {
    if (!isCompanyName(c.name) || c.name.length > 120) {
      counts.skipped++
      report.warnings.push(
        `Selskapet «${c.name.slice(0, 60)}» har et ugyldig navn, og hoppes over.`,
      )
      continue
    }
    const slug = companySlug(c.name)
    const values = companyValues(c)
    const earlier = ledger.entity('company', c.key)
    let row = (earlier ? byId.get(earlier) : undefined) ?? bySlug.get(slug)
    if (!row && earlier !== undefined) {
      // Importert før, men slettet i appen siden. Lages ikke på nytt.
      counts.skipped++
      continue
    }

    if (!row) {
      const [created] = await tx
        .insert(company)
        .values({
          slug,
          name: c.name,
          tagline: values.tagline as string | null,
          description: values.description as string | null,
          website: values.website as string | null,
          foundedYear: values.foundedYear as number | null,
          location: values.location as string | null,
          industries: values.industries as string[],
          status: c.status,
          lastSeenOnEsSite: values.lastSeenOnEsSite as string | null,
          // Redigert av importen, så det ikke ryddes bort som et selskap bare laget fra et navn.
          editedAt: new Date(),
        })
        .returning()
      row = created!
      byId.set(row.id, row)
      bySlug.set(slug, row)
      counts.created++
      for (const field of companyFields) {
        if (isEmpty(values[field])) continue
        await ledger.record('company_field', `${c.key}|${field}`, row.id)
        const fs = sourceOf(c.fieldSources, field)
        if (fs) await sources.replace(row.id, field, fs.sources, fs.confidence)
      }
    } else {
      const changes: Partial<Record<CompanyField, FieldValue>> = {}
      for (const field of companyFields) {
        const next = values[field]
        if (isEmpty(next)) continue
        const fieldKey = `${c.key}|${field}`
        const decision = decideField(row[field] as FieldValue, next, {
          known: ledger.has('company_field', fieldKey),
          importOwned: sources.importOwned(row.id, field),
          hasSources: sources.has(row.id, field),
          emptyValue: field === 'status' ? 'unknown' : undefined,
        })
        const fs = sourceOf(c.fieldSources, field)
        if (decision === 'keep') continue
        await ledger.record('company_field', fieldKey, row.id)
        if (decision === 'same') {
          if (fs) await sources.refresh(row.id, field, fs.sources, fs.confidence)
          continue
        }
        changes[field] = next
        if (fs) await sources.replace(row.id, field, fs.sources, fs.confidence)
        // Uten kilder i bunten gjelder ikke de gamle kildene lenger.
        else await sources.replace(row.id, field, [], 'medium')
      }
      if (Object.keys(changes).length) {
        await tx
          .update(company)
          .set({ ...(changes as object), editedAt: row.editedAt ?? new Date() })
          .where(eq(company.id, row.id))
        Object.assign(row, changes)
        counts.updated++
      } else {
        counts.unchanged++
      }
    }
    await ledger.record('company', c.key, row.id)
    companyIds.set(c.key, row.id)

    // Logo: bare når selskapet ikke har en, og importen ikke har lagt inn en før.
    const logo = report.counts.logos
    if (!c.logo) continue
    if (row.logoKey) {
      logo.unchanged++
      await ledger.record('company_logo', c.key, row.id)
      continue
    }
    if (ledger.has('company_logo', c.key)) {
      // Lagt inn før og fjernet i appen siden.
      logo.skipped++
      continue
    }
    const logoKey = images({ kind: 'logo', datasetKey: c.key, file: c.logo.file })
    if (!logoKey) {
      logo.skipped++
      continue
    }
    await tx.update(company).set({ logoKey }).where(eq(company.id, row.id))
    row.logoKey = logoKey
    await sources.replace(row.id, 'logo', c.logo.source ? [c.logo.source] : [], c.logo.confidence)
    await ledger.record('company_logo', c.key, row.id)
    logo.created++
  }
  return companyIds
}

/** Hendelsene i historikken. Lav sikkerhet lagres som `low` og vises bare for dem som kan rette. */
async function importEvents(
  tx: Tx,
  data: Dataset,
  companyIds: Map<string, string>,
  ledger: Ledger,
  report: DatasetImportReport,
) {
  const counts = report.counts.events
  const ids = [...companyIds.values()]
  const existing = new Set(
    (ids.length
      ? await tx
          .select({
            companyId: companyEvent.companyId,
            date: companyEvent.date,
            type: companyEvent.type,
            text: companyEvent.text,
          })
          .from(companyEvent)
          .where(inArray(companyEvent.companyId, ids))
      : []
    ).map((e) => `${e.companyId}|${e.date}|${e.type}|${e.text}`),
  )
  for (const c of data.companies) {
    const companyId = companyIds.get(c.key)
    if (!companyId) {
      counts.skipped += c.timeline.length
      continue
    }
    for (const t of c.timeline) {
      const [y, m, d] = t.date.split('-')
      const date = `${y}-${m ?? '01'}-${d ?? '01'}`
      const precision = d ? 'day' : m ? 'month' : 'year'
      const text = t.text.replace(/\s+/g, ' ').trim()
      const short = text.length > 500 ? `${text.slice(0, 499).trimEnd()}…` : text
      const key = `${c.key}|${date}|${t.type}|${short}`
      if (ledger.has('company_event', key)) {
        counts.unchanged++
        continue
      }
      const content = `${companyId}|${date}|${t.type}|${short}`
      if (existing.has(content)) {
        counts.unchanged++
        await ledger.record('company_event', key, null)
        continue
      }
      existing.add(content)
      const source = t.source ? { url: safeHttpUrl(t.source.url), label: t.source.label } : null
      const [row] = await tx
        .insert(companyEvent)
        .values({
          companyId,
          date,
          datePrecision: precision,
          type: t.type,
          text: short,
          sourceUrl: source?.url ?? null,
          sourceLabel: source?.label ?? null,
          confidence: t.confidence,
        })
        .returning({ id: companyEvent.id })
      await ledger.record('company_event', key, row!.id)
      counts.created++
    }
  }
}

/** «I media»: lenker og titler, aldri teksten i sakene. */
async function importArticles(
  tx: Tx,
  data: Dataset,
  companyIds: Map<string, string>,
  ledger: Ledger,
  report: DatasetImportReport,
) {
  const counts = report.counts.articles
  const ids = [...companyIds.values()]
  const existing = new Set(
    (ids.length
      ? await tx
          .select({ companyId: companyArticle.companyId, url: companyArticle.url })
          .from(companyArticle)
          .where(inArray(companyArticle.companyId, ids))
      : []
    ).map((a) => `${a.companyId}|${articleUrlKey(a.url)}`),
  )
  let invalid = 0
  for (const c of data.companies) {
    const companyId = companyIds.get(c.key)
    if (!companyId) {
      counts.skipped += c.articles.length
      continue
    }
    for (const a of c.articles) {
      const [y, m, d] = a.date?.split('-').map(Number) ?? []
      const parsed = companyArticleInput.safeParse({
        url: a.url,
        title: a.title.slice(0, 300),
        publisher: a.publisher?.slice(0, 120) ?? '',
        year: y ?? null,
        month: m ?? null,
        day: d ?? null,
        paywall: a.paywall,
        mentionsEs: a.mentionsES,
      })
      if (!parsed.success) {
        invalid++
        counts.skipped++
        continue
      }
      const urlKey = articleUrlKey(parsed.data.url)
      const key = `${c.key}|${urlKey}`
      // Samme sak to ganger i bunten, eller tatt inn før (og kanskje fjernet siden).
      if (ledger.has('company_article', key)) {
        counts.unchanged++
        continue
      }
      if (existing.has(`${companyId}|${urlKey}`)) {
        counts.unchanged++
        await ledger.record('company_article', key, null)
        continue
      }
      existing.add(`${companyId}|${urlKey}`)
      const [row] = await tx
        .insert(companyArticle)
        .values({
          companyId,
          ...articleValues(parsed.data),
          source: 'import',
          addedByPersonId: null,
        })
        .returning({ id: companyArticle.id })
      await ledger.record('company_article', key, row!.id)
      counts.created++
    }
  }
  if (invalid) {
    report.warnings.push(
      `${invalid} saker i media har ugyldig lenke, tittel eller dato, og hoppes over.`,
    )
  }
}

// ---------------------------------------------------------------------------
// Personer
// ---------------------------------------------------------------------------

const personFields = [
  'bio',
  'linkedinUrl',
  'studyBackground',
  'expertise',
  'industries',
  'phone',
  'contactEmail',
] as const
type PersonField = (typeof personFields)[number]

type PersonRow = Pick<
  typeof person.$inferSelect,
  'id' | 'userId' | 'photoKey' | 'esCompanyId' | PersonField
>

function personValues(p: DatasetPerson): Record<PersonField, FieldValue> {
  return {
    bio: p.bio,
    linkedinUrl: safeHttpUrl(p.linkedinUrl) ? p.linkedinUrl : null,
    studyBackground: p.studyBackground,
    expertise: p.expertise.slice(0, 10),
    industries: p.industries.slice(0, 10),
    // Kontaktinfo fra kullisten vises for medlemmer som standard. Synligheten
    // settes aldri her, så det personen (eller admin) har skjult, forblir skjult.
    phone: p.phone,
    contactEmail: p.emails[0] ?? null,
  }
}

type ExperienceValue = {
  companyId: string
  title: string | null
  founder: boolean
  startYear: number | null
  endYear: number | null
}

/**
 * Erfaringen fra bunten. ES-teamet er ES-selskapet på profilen, ikke en jobb; et
 * annet ES-selskap enn det profilen har, blir erfaring fram til uteksamineringen.
 */
function experienceValues(
  p: DatasetPerson,
  companyIds: Map<string, string>,
  esCompanyId: string | null,
): ExperienceValue[] {
  const seen = new Set<string>()
  return p.companies.flatMap((c) => {
    const companyId = companyIds.get(c.companyKey)
    if (!companyId || (c.role === 'es' && companyId === esCompanyId) || seen.has(companyId)) {
      return []
    }
    seen.add(companyId)
    const endYear =
      c.endYear !== null && c.startYear !== null && c.endYear < c.startYear ? null : c.endYear
    return [
      {
        companyId,
        title: c.title,
        founder: c.role === 'founder',
        startYear: c.startYear,
        endYear,
      },
    ]
  })
}

const experienceKey = (rows: ExperienceValue[]) =>
  rows.map((r) => [r.companyId, r.title, r.founder, r.startYear, r.endYear].join('|'))

async function importPeople(
  tx: Tx,
  data: Dataset,
  companyIds: Map<string, string>,
  ledger: Ledger,
  report: DatasetImportReport,
  images: ImageProvider,
) {
  const personIds = new Map<string, string>()
  if (!data.people.length) return personIds
  const counts = report.counts.people
  const sources = await Sources.load(tx, 'person', report)

  // Samme matching som kullisteimporten: e-post, så navn og kull.
  const profileRows: ProfileRow[] = data.people.map((p, i) => ({
    line: i + 1,
    fullName: p.fullName,
    emails: p.emails,
    years: p.graduationYears,
    phone: p.phone,
    fields: {},
    expertise: [],
    industries: [],
    role: null,
  }))
  const plan = await planProfileImport(tx, profileRows)
  const rows = new Map(
    (
      await tx
        .select({
          id: person.id,
          userId: person.userId,
          photoKey: person.photoKey,
          esCompanyId: person.esCompanyId,
          bio: person.bio,
          linkedinUrl: person.linkedinUrl,
          studyBackground: person.studyBackground,
          expertise: person.expertise,
          industries: person.industries,
          phone: person.phone,
          contactEmail: person.contactEmail,
        })
        .from(person)
    ).map((r) => [r.id, r as PersonRow]),
  )
  const experienceByPerson = new Map<string, ExperienceValue[]>()
  for (const e of await tx
    .select()
    .from(experience)
    .orderBy(experience.personId, experience.position)) {
    const list = experienceByPerson.get(e.personId) ?? []
    list.push(e)
    experienceByPerson.set(e.personId, list)
  }
  const emailOwners = new Map(
    (
      await tx
        .select({ email: personEmail.email, personId: personEmail.personId })
        .from(personEmail)
    ).map((e) => [e.email, e.personId]),
  )
  const years = [...new Set(data.people.flatMap((p) => p.graduationYears))]
  if (years.length) {
    await tx
      .insert(cohort)
      .values(years.map((graduationYear) => ({ graduationYear })))
      .onConflictDoNothing()
  }
  const cohortIds = new Map(
    (years.length
      ? await tx.select().from(cohort).where(inArray(cohort.graduationYear, years))
      : []
    ).map((c) => [c.graduationYear, c.id]),
  )
  const cohortLinks = new Set(
    (await tx.select().from(personCohort)).map((l) => `${l.personId}|${l.cohortId}`),
  )
  const taken = new Set<string>()

  for (const [i, p] of data.people.entries()) {
    const planned = plan[i]!
    const earlier = ledger.entity('person', p.key)
    let target: PersonRow | undefined
    if (planned.action === 'existing') {
      target = rows.get(planned.personId)
      if (planned.matchedBy === 'email') report.matching.byEmail++
      else report.matching.byName++
    } else if (earlier !== undefined) {
      target = earlier ? rows.get(earlier) : undefined
      if (!target) {
        // Importert før, men slettet i appen siden. Lages ikke på nytt.
        counts.skipped++
        continue
      }
      report.matching.byEarlierImport++
    }
    if (target && taken.has(target.id)) {
      counts.skipped++
      report.warnings.push(
        `To personer i bunten ble kjent igjen som samme profil (rad ${i + 1}); den siste hoppes over.`,
      )
      continue
    }

    const values = personValues(p)
    let created = false
    if (!target) {
      const [row] = await tx
        .insert(person)
        .values({
          fullName: p.fullName,
          source: 'import',
          bio: values.bio as string | null,
          linkedinUrl: values.linkedinUrl as string | null,
          studyBackground: values.studyBackground as string | null,
          expertise: values.expertise as string[],
          industries: values.industries as string[],
          phone: values.phone as string | null,
          contactEmail: values.contactEmail as string | null,
        })
        .returning()
      target = { ...row!, esCompanyId: null } as PersonRow
      rows.set(target.id, target)
      // Som i kullisteimporten: profiler fra ESAFs egne lister er aktive, men gir aldri tilgang til noen konto.
      await tx
        .insert(membership)
        .values({ personId: target.id, status: 'active', decidedAt: new Date() })
      report.matching.created++
      created = true
    }
    taken.add(target.id)
    personIds.set(p.key, target.id)
    await ledger.record('person', p.key, target.id)

    if (target.userId) {
      // Har tatt i bruk profilen: navn, felt, erfaring, e-post, kull og bilde er deres.
      report.matching.claimed++
      counts.skipped++
      continue
    }

    let changed = false
    const personId = target.id
    const changes: Partial<Record<PersonField, FieldValue>> = {}
    for (const field of personFields) {
      const next = values[field]
      if (isEmpty(next)) continue
      const fieldKey = `${p.key}|${field}`
      const fs = p.fieldSources[field]
      if (created) {
        await ledger.record('person_field', fieldKey, personId)
        if (fs) await sources.replace(personId, field, fs.sources, fs.confidence)
        continue
      }
      const decision = decideField(target[field] as FieldValue, next, {
        known: ledger.has('person_field', fieldKey),
        importOwned: sources.importOwned(personId, field),
        hasSources: sources.has(personId, field),
      })
      if (decision === 'keep') continue
      await ledger.record('person_field', fieldKey, personId)
      if (decision === 'same') {
        if (fs) await sources.refresh(personId, field, fs.sources, fs.confidence)
        continue
      }
      changes[field] = next
      await sources.replace(personId, field, fs?.sources ?? [], fs?.confidence ?? 'medium')
    }
    if (Object.keys(changes).length) {
      await tx
        .update(person)
        .set(changes as Partial<typeof person.$inferInsert>)
        .where(eq(person.id, personId))
      Object.assign(target, changes)
      changed = true
    }

    // Kjente e-postadresser og kull legges til; de som står, røres ikke.
    const newEmails = p.emails.filter((email) => !emailOwners.has(email))
    const elsewhere = p.emails.filter(
      (email) => emailOwners.has(email) && emailOwners.get(email) !== personId,
    )
    if (elsewhere.length) {
      report.warnings.push(
        `En e-postadresse i bunten (rad ${i + 1}) står på en annen profil, og legges ikke til.`,
      )
    }
    if (newEmails.length) {
      await tx
        .insert(personEmail)
        .values(newEmails.map((email) => ({ email, personId, source: 'import' as const })))
        .onConflictDoNothing()
      for (const email of newEmails) emailOwners.set(email, personId)
      changed = true
    }
    const newCohorts = p.graduationYears
      .map((y) => cohortIds.get(y)!)
      .filter((cohortId) => !cohortLinks.has(`${personId}|${cohortId}`))
    if (newCohorts.length) {
      await tx
        .insert(personCohort)
        .values(
          newCohorts.map((cohortId) => ({ personId, cohortId, relation: 'student' as const })),
        )
        .onConflictDoNothing()
      for (const cohortId of newCohorts) cohortLinks.add(`${personId}|${cohortId}`)
      changed = true
    }

    // ES-selskapet og erfaringen, med samme regler som feltene over.
    const team = p.companies.find((c) => c.role === 'es' && companyIds.has(c.companyKey))
    const teamId = team ? companyIds.get(team.companyKey)! : null
    if (teamId) {
      const decision = created
        ? 'write'
        : decideField(target.esCompanyId, teamId, {
            known: ledger.has('person_field', `${p.key}|esCompany`),
            importOwned: sources.importOwned(personId, 'esCompany'),
            hasSources: sources.has(personId, 'esCompany'),
          })
      const fs = p.fieldSources.esCompany
      if (decision !== 'keep') await ledger.record('person_field', `${p.key}|esCompany`, personId)
      if (decision === 'same' && fs)
        await sources.refresh(personId, 'esCompany', fs.sources, fs.confidence)
      if (decision === 'write') {
        await tx.update(person).set({ esCompanyId: teamId }).where(eq(person.id, personId))
        target.esCompanyId = teamId
        await sources.replace(personId, 'esCompany', fs?.sources ?? [], fs?.confidence ?? 'medium')
        changed = true
      }
    }
    const wanted = experienceValues(p, companyIds, target.esCompanyId)
    if (wanted.length) {
      const current = experienceByPerson.get(personId) ?? []
      const fieldKey = `${p.key}|experience`
      const decision = sameValue(experienceKey(current), experienceKey(wanted))
        ? 'same'
        : decideField(current.length ? experienceKey(current) : [], experienceKey(wanted), {
            known: ledger.has('person_field', fieldKey),
            importOwned: sources.importOwned(personId, 'experience'),
            hasSources: sources.has(personId, 'experience'),
          })
      const fs = p.fieldSources.experience
      if (decision !== 'keep') await ledger.record('person_field', fieldKey, personId)
      if (decision === 'same' && fs)
        await sources.refresh(personId, 'experience', fs.sources, fs.confidence)
      if (decision === 'write') {
        await tx.delete(experience).where(eq(experience.personId, personId))
        await tx
          .insert(experience)
          .values(wanted.map((e, position) => ({ ...e, personId, position })))
        experienceByPerson.set(personId, wanted)
        await sources.replace(personId, 'experience', fs?.sources ?? [], fs?.confidence ?? 'medium')
        changed = true
      }
    }

    // Profilbildet: bare når personen ikke har et, og importen ikke har lagt inn et før.
    const photos = report.counts.photos
    if (p.photo) {
      if (target.photoKey) {
        photos.unchanged++
        await ledger.record('person_photo', p.key, personId)
      } else if (ledger.has('person_photo', p.key)) {
        photos.skipped++
      } else {
        const photoKey = images({ kind: 'photo', datasetKey: p.key, file: p.photo.file })
        if (photoKey) {
          await tx.update(person).set({ photoKey }).where(eq(person.id, personId))
          target.photoKey = photoKey
          const fs = p.fieldSources.photo
          await sources.replace(
            personId,
            'photo',
            fs?.sources ?? (p.photo.source ? [p.photo.source] : []),
            fs?.confidence ?? p.photo.confidence,
          )
          await ledger.record('person_photo', p.key, personId)
          photos.created++
          changed = true
        } else {
          photos.skipped++
        }
      }
    }

    if (created) counts.created++
    else if (changed) counts.updated++
    else counts.unchanged++
  }
  return personIds
}

/** Sitater. Ett per tekst; usikker taler gir lav sikkerhet, og vises bare for admins. */
async function importQuotes(
  tx: Tx,
  data: Dataset,
  companyIds: Map<string, string>,
  personIds: Map<string, string>,
  ledger: Ledger,
  report: DatasetImportReport,
) {
  const counts = report.counts.quotes
  if (!data.quotes.length) return
  const norm = (t: string) => t.toLocaleLowerCase('nb').replace(/\s+/g, ' ').trim()
  const known = new Set(
    (await tx.select({ text: quote.text }).from(quote)).map((q) => norm(q.text)),
  )
  for (const q of data.quotes) {
    if (ledger.has('quote', q.key)) {
      counts.unchanged++
      continue
    }
    const text = q.text.slice(0, 2000)
    if (known.has(norm(text))) {
      counts.unchanged++
      await ledger.record('quote', q.key, null)
      continue
    }
    known.add(norm(text))
    const [row] = await tx
      .insert(quote)
      .values({
        text,
        personId: q.personKey ? (personIds.get(q.personKey) ?? null) : null,
        companyId: q.companyKey ? (companyIds.get(q.companyKey) ?? null) : null,
        speakerName: q.speakerName.slice(0, 120),
        speakerRole: q.speakerRole?.slice(0, 160) ?? null,
        date: q.date,
        sourceUrl: safeHttpUrl(q.source?.url),
        sourceLabel: q.source?.label ?? null,
        confidence: q.confidence === 'high' ? 'high' : 'low',
      })
      .returning({ id: quote.id })
    await ledger.record('quote', q.key, row!.id)
    counts.created++
  }
}

/**
 * Selve importen, i en transaksjon som allerede er startet. Skriver alt, og gir
 * tallene. `images` gir nøkkelen til hvert bilde som skal inn.
 */
async function importInTransaction(
  tx: Tx,
  data: Dataset,
  options: DatasetOptions,
  images: ImageProvider,
  label: string,
): Promise<DatasetImportReport> {
  const report = newReport()
  const ledger = await Ledger.load(tx)
  const companyIds = await importCompanies(tx, data, ledger, report, images)
  await importEvents(tx, data, companyIds, ledger, report)
  await importArticles(tx, data, companyIds, ledger, report)
  const personIds = await importPeople(tx, data, companyIds, ledger, report, images)
  await importQuotes(tx, data, companyIds, personIds, ledger, report)
  if (changesIn(report) > 0) {
    await tx.insert(auditEvent).values({
      actorPersonId: null,
      action: 'operator.import_dataset',
      details: {
        source: label,
        options: describeDatasetOptions(options),
        counts: Object.fromEntries(
          datasetEntities.map((e) => [
            e,
            { created: report.counts[e].created, updated: report.counts[e].updated },
          ]),
        ),
      },
    })
  }
  return report
}

// ---------------------------------------------------------------------------
// Forhåndsvisning og lagring
// ---------------------------------------------------------------------------

class Rollback extends Error {
  constructor(readonly report: DatasetImportReport) {
    super('Forhåndsvisning: rulles tilbake.')
  }
}

type PreparedImage =
  { kind: 'photo'; images: ProcessedPhoto } | { kind: 'logo'; images: ProcessedLogo }

/** Bildene som trengs, ferdig behandlet. Nøkkelen er `type:nøkkel i datasettet`. */
export type PreparedImages = Map<string, PreparedImage>

export type DatasetPreview = {
  report: DatasetImportReport
  images: PreparedImages
}

const imageId = (kind: ImageKind, datasetKey: string) => `${kind}:${datasetKey}`

/**
 * Forhåndsvisning: hele importen i en transaksjon som rulles tilbake, og
 * behandling av bildene som trengs. Skriver ingenting, verken i databasen eller
 * lagringen.
 */
export async function previewDatasetImport(
  db: Db,
  bundle: Pick<DatasetBundle, 'data' | 'images'>,
  options: DatasetOptions,
  label: string,
): Promise<DatasetPreview> {
  const data = filterDataset(bundle.data, options)

  /** Kjører importen og ruller den tilbake. */
  const dryRun = async (images: ImageProvider) => {
    try {
      await db.transaction(async (tx) => {
        throw new Rollback(await importInTransaction(tx, data, options, images, label))
      })
    } catch (error) {
      if (error instanceof Rollback) return error.report
      throw error
    }
    throw new Error('Forhåndsvisningen ble ikke rullet tilbake.')
  }
  // En midlertidig nøkkel; transaksjonen rulles tilbake.
  const placeholder = () => `forhandsvisning-${randomBytes(12).toString('base64url')}`

  // Først: hvilke bilder trengs.
  const requests: ImageRequest[] = []
  await dryRun((request) => {
    requests.push(request)
    return placeholder()
  })

  // Samme behandling som en opplasting i appen. Bilder som ikke kan brukes, hoppes over.
  const images: PreparedImages = new Map()
  let failed = 0
  for (const request of requests) {
    const file = bundle.images.get(request.file)
    try {
      if (!file) throw new Error('mangler')
      images.set(
        imageId(request.kind, request.datasetKey),
        request.kind === 'photo'
          ? { kind: 'photo', images: await processProfilePhoto(file) }
          : { kind: 'logo', images: await processCompanyLogo(file) },
      )
    } catch {
      failed++
    }
  }

  // Så tallene, med bare bildene som kan brukes, så de er nøyaktig det som blir lagret.
  const report = await dryRun((request) =>
    images.has(imageId(request.kind, request.datasetKey)) ? placeholder() : null,
  )
  if (failed) {
    report.warnings.push(
      `${failed} bilder kunne ikke leses som JPEG, PNG eller WebP, og hoppes over.`,
    )
  }
  return { report, images }
}

/**
 * Lagrer importen. Bildene lastes opp først og databasen skrives i én
 * transaksjon; feiler den, slettes bildene igjen. Bilder som ikke ble brukt
 * (noe endret seg siden forhåndsvisningen), slettes etterpå.
 */
export async function applyDatasetImport(
  db: Db,
  storage: ObjectStorage,
  bundle: Pick<DatasetBundle, 'data' | 'images'>,
  options: DatasetOptions,
  label: string,
  prepared?: PreparedImages,
): Promise<DatasetImportReport> {
  const images = prepared ?? (await previewDatasetImport(db, bundle, options, label)).images
  const data = filterDataset(bundle.data, options)

  const uploaded = new Map<string, { kind: ImageKind; key: string }>()
  const removeAll = async (keys: { kind: ImageKind; key: string }[]) => {
    for (const image of keys) {
      if (image.kind === 'photo') await deletePhotoFiles(storage, image.key)
      else await deleteLogoFiles(storage, image.key)
    }
  }
  try {
    for (const [id, image] of images) {
      const key =
        image.kind === 'photo'
          ? await putProcessedPhoto(storage, image.images)
          : await putProcessedLogo(storage, image.images)
      uploaded.set(id, { kind: image.kind, key })
    }
  } catch (error) {
    await removeAll([...uploaded.values()])
    throw error
  }

  const used = new Set<string>()
  let report: DatasetImportReport
  try {
    report = await db.transaction(
      (tx) =>
        importInTransaction(
          tx,
          data,
          options,
          (request) => {
            const id = imageId(request.kind, request.datasetKey)
            const image = uploaded.get(id)
            if (!image) return null
            used.add(id)
            return image.key
          },
          label,
        ),
      // Endrer noen det samme i appen mens importen kjører, feiler importen i stedet
      // for å skrive over. Da kan den bare kjøres på nytt.
      { isolationLevel: 'repeatable read' },
    )
  } catch (error) {
    await removeAll([...uploaded.values()])
    throw error
  }
  await removeAll([...uploaded].filter(([id]) => !used.has(id)).map(([, image]) => image))
  return report
}

/** Antall rader importen har husket, til tester og feilsøking. */
export async function countImportRecords(db: Db | Tx) {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(importRecord)
  return row?.n ?? 0
}
