import { createHash } from 'node:crypto'
import { z } from 'zod'
import { companyEventTypes } from './company-events.ts'
import { companyStatuses } from './companies.ts'
import { createTarGz, readTarGz } from './tar.ts'

/**
 * Datasettbunten: det `pnpm data:bundle` lager fra berikelsen lokalt, og det
 * `pnpm data:import` leser i produksjon. Én `.tar.gz` med
 *
 * - `manifest.json`: format, skjemaversjon, antall og SHA-256 for hver fil,
 * - `out/companies.json`, `out/people.json` og `out/quotes.json` i formen under,
 * - `images/photos/…` og `images/logos/…`: bare bildene som faktisk brukes.
 *
 * Bunten inneholder persondata (navn, e-post, telefon, bilder). Den skal aldri
 * committes, og bare ligge på serveren mens importen kjøres (se README, «Fylle
 * produksjon med datasettet»). Skjemaet tar bare med feltene importen bruker;
 * alt annet (f.eks. fødselsår fra registrene) forsvinner allerede når bunten
 * lages, og igjen når den leses.
 */

export const DATASET_FORMAT = 'esaf-datasett'
export const DATASET_SCHEMA_VERSION = 1

export const MANIFEST_PATH = 'manifest.json'
export const DATASET_FILES = {
  companies: 'out/companies.json',
  people: 'out/people.json',
  quotes: 'out/quotes.json',
} as const

const confidence = z.enum(['high', 'medium', 'low'])
const text = (max: number) => z.string().trim().min(1).max(max)
const optional = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => (v?.trim() ? v.trim() : null))
const year = z.number().int().min(1800).max(2100).nullable()
/** «2019», «2019-06» eller «2019-06-04». */
const partialDate = z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, 'Ugyldig dato.')
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ugyldig dato.')

/** En kilde slik appen viser den: navnet, en offentlig lenke og når den ble hentet. */
export const datasetSource = z.object({
  label: text(200),
  url: optional(2000),
  fetchedAt: z.iso
    .datetime({ offset: true })
    .nullish()
    .transform((v) => v ?? null),
})
export type DatasetSource = z.output<typeof datasetSource>

const fieldSources = z
  .record(z.string().max(60), z.object({ confidence, sources: z.array(datasetSource).max(50) }))
  .default({})

/** Et bilde i bunten. Stien er relativ til roten av bunten. */
const image = z.object({
  file: z.string().regex(/^images\/(photos|logos)\/[A-Za-z0-9_][A-Za-z0-9._-]{0,150}$/),
  source: datasetSource.nullish().transform((v) => v ?? null),
  confidence: confidence.default('medium'),
})

/** En sak i media, slik berikelsen lager den. */
export const datasetArticle = z.object({
  url: z.string().max(2000),
  title: z.string().max(1000),
  date: partialDate.nullish().transform((v) => v ?? null),
  publisher: optional(500),
  paywall: z.boolean().default(false),
  mentionsES: z.boolean().default(false),
})
export type DatasetArticle = z.output<typeof datasetArticle>

export const datasetCompany = z.object({
  /** Stabil nøkkel i datasettet, f.eks. `company:syrlig`. */
  key: text(300),
  name: text(200),
  tagline: optional(500),
  description: optional(10_000),
  website: optional(2000),
  foundedYear: year.default(null),
  location: optional(200),
  industries: z.array(text(200)).max(20).default([]),
  status: z.enum(companyStatuses).default('unknown'),
  lastSeenOnEsSite: day.nullish().transform((v) => v ?? null),
  logo: image.nullish().transform((v) => v ?? null),
  /** Kildene per felt i appen (`tagline`, `website`, `status` …). */
  fieldSources,
  timeline: z
    .array(
      z.object({
        date: partialDate,
        type: z.enum(companyEventTypes),
        text: text(2000),
        source: datasetSource.nullish().transform((v) => v ?? null),
        confidence,
      }),
    )
    .default([]),
  articles: z.array(datasetArticle).default([]),
})
export type DatasetCompany = z.output<typeof datasetCompany>

export const datasetPerson = z.object({
  key: text(300),
  fullName: text(200),
  /** Kullene, som uteksamineringsår. */
  graduationYears: z.array(z.number().int().min(1950).max(2100)).max(5).default([]),
  emails: z.array(z.string().trim().toLowerCase().pipe(z.email())).max(20).default([]),
  phone: optional(40),
  linkedinUrl: optional(500),
  studyBackground: optional(200),
  bio: optional(10_000),
  expertise: z.array(text(200)).max(20).default([]),
  industries: z.array(text(200)).max(20).default([]),
  photo: image.nullish().transform((v) => v ?? null),
  /** Selskapene: `es` er ES-selskapet (ES-teamet), de andre blir erfaring. */
  companies: z
    .array(
      z.object({
        companyKey: text(300),
        role: z.enum(['founder', 'es', 'employee']),
        title: optional(200),
        startYear: year.default(null),
        endYear: year.default(null),
      }),
    )
    .max(50)
    .default([]),
  /** Kildene per felt i appen (`bio`, `photo`, `experience` …). */
  fieldSources,
})
export type DatasetPerson = z.output<typeof datasetPerson>

export const datasetQuote = z.object({
  key: text(300),
  text: text(4000),
  speakerName: text(200),
  speakerRole: optional(300),
  date: day.nullish().transform((v) => v ?? null),
  personKey: optional(300),
  companyKey: optional(300),
  source: datasetSource.nullish().transform((v) => v ?? null),
  confidence,
})
export type DatasetQuote = z.output<typeof datasetQuote>

export type Dataset = {
  companies: DatasetCompany[]
  people: DatasetPerson[]
  quotes: DatasetQuote[]
}

export type DatasetCounts = {
  companies: number
  people: number
  quotes: number
  articles: number
  photos: number
  logos: number
}

export const datasetManifest = z.object({
  format: z.literal(DATASET_FORMAT),
  schemaVersion: z.number().int(),
  createdAt: z.iso.datetime({ offset: true }),
  counts: z.object({
    companies: z.number().int().min(0),
    people: z.number().int().min(0),
    quotes: z.number().int().min(0),
    articles: z.number().int().min(0),
    photos: z.number().int().min(0),
    logos: z.number().int().min(0),
  }),
  /** SHA-256 (hex) for hver fil i bunten utenom manifestet. */
  files: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
})
export type DatasetManifest = z.output<typeof datasetManifest>

export type DatasetBundle = {
  manifest: DatasetManifest
  data: Dataset
  /** Bildene, med stien i bunten som nøkkel. */
  images: Map<string, Uint8Array>
}

export class DatasetError extends Error {}

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

/** Antallene i manifestet, regnet ut fra dataene. */
export function countDataset(data: Dataset): DatasetCounts {
  return {
    companies: data.companies.length,
    people: data.people.length,
    quotes: data.quotes.length,
    articles: data.companies.reduce((n, c) => n + c.articles.length, 0),
    photos: data.people.filter((p) => p.photo).length,
    logos: data.companies.filter((c) => c.logo).length,
  }
}

/** Bildene dataene viser til. */
function referencedImages(data: Dataset) {
  return [
    ...data.people.flatMap((p) => (p.photo ? [p.photo.file] : [])),
    ...data.companies.flatMap((c) => (c.logo ? [c.logo.file] : [])),
  ]
}

function parseList<T extends z.ZodType>(schema: T, raw: unknown, file: string): z.output<T>[] {
  if (!Array.isArray(raw)) throw new DatasetError(`${file} må være en liste.`)
  return raw.map((item, i) => {
    const parsed = schema.safeParse(item)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw new DatasetError(
        `${file}, element ${i + 1}: ${issue?.path.join('.') || 'verdien'}: ${issue?.message ?? 'ugyldig'}`,
      )
    }
    return parsed.data
  })
}

/** Sjekker at nøklene er unike og at bildene finnes. Gir advarsler for brutte henvisninger. */
function checkDataset(data: Dataset, images: Map<string, Uint8Array>): string[] {
  for (const [label, list] of [
    ['selskap', data.companies],
    ['person', data.people],
    ['sitat', data.quotes],
  ] as const) {
    const seen = new Set<string>()
    for (const item of list) {
      if (seen.has(item.key)) throw new DatasetError(`Samme nøkkel for to ${label}: ${item.key}`)
      seen.add(item.key)
    }
  }
  for (const file of referencedImages(data)) {
    if (!images.has(file)) throw new DatasetError(`Bildet ${file} mangler i bunten.`)
  }
  const companyKeys = new Set(data.companies.map((c) => c.key))
  const personKeys = new Set(data.people.map((p) => p.key))
  const warnings: string[] = []
  const brokenLinks = data.people.reduce(
    (n, p) => n + p.companies.filter((c) => !companyKeys.has(c.companyKey)).length,
    0,
  )
  if (brokenLinks) {
    warnings.push(
      `${brokenLinks} koblinger fra personer til selskaper som ikke er i bunten, hoppes over.`,
    )
  }
  const brokenQuotes = data.quotes.filter(
    (q) =>
      (q.personKey && !personKeys.has(q.personKey)) ||
      (q.companyKey && !companyKeys.has(q.companyKey)),
  ).length
  if (brokenQuotes) {
    warnings.push(
      `${brokenQuotes} sitater viser til personer eller selskaper som ikke er i bunten.`,
    )
  }
  return warnings
}

/**
 * Leser og sjekker en bunt: formatet og skjemaversjonen, at hver fil har riktig
 * SHA-256, at antallene stemmer, at alle bildene finnes, og at ingen filer er
 * med uten å stå i manifestet. Felt som ikke er i skjemaet, forkastes.
 */
export function readDatasetBundle(archive: Uint8Array): DatasetBundle & { warnings: string[] } {
  const files = readTarGz(archive)
  const rawManifest = files.get(MANIFEST_PATH)
  if (!rawManifest) throw new DatasetError('Bunten mangler manifest.json.')
  let manifestJson: unknown
  try {
    manifestJson = JSON.parse(Buffer.from(rawManifest).toString('utf8'))
  } catch {
    throw new DatasetError('manifest.json er ikke gyldig JSON.')
  }
  if ((manifestJson as { format?: unknown } | null)?.format !== DATASET_FORMAT) {
    throw new DatasetError(`Ikke en ESAF-datasettbunt (format må være «${DATASET_FORMAT}»).`)
  }
  const parsedManifest = datasetManifest.safeParse(manifestJson)
  if (!parsedManifest.success) {
    throw new DatasetError(`Ugyldig manifest.json: ${parsedManifest.error.issues[0]?.message}`)
  }
  const manifest = parsedManifest.data
  if (manifest.schemaVersion !== DATASET_SCHEMA_VERSION) {
    throw new DatasetError(
      `Bunten har skjemaversjon ${manifest.schemaVersion}, men denne versjonen av appen leser ${DATASET_SCHEMA_VERSION}. Lag bunten på nytt med samme versjon av koden som kjører importen.`,
    )
  }

  for (const path of files.keys()) {
    if (path !== MANIFEST_PATH && !(path in manifest.files)) {
      throw new DatasetError(`${path} er i bunten, men ikke i manifestet.`)
    }
  }
  for (const [path, hash] of Object.entries(manifest.files)) {
    const body = files.get(path)
    if (!body) throw new DatasetError(`${path} står i manifestet, men mangler i bunten.`)
    if (sha256(body) !== hash) throw new DatasetError(`${path} er endret eller ødelagt (SHA-256).`)
  }

  const json = (path: string): unknown => {
    const body = files.get(path)
    if (!body) throw new DatasetError(`Bunten mangler ${path}.`)
    try {
      return JSON.parse(Buffer.from(body).toString('utf8'))
    } catch {
      throw new DatasetError(`${path} er ikke gyldig JSON.`)
    }
  }
  const data: Dataset = {
    companies: parseList(datasetCompany, json(DATASET_FILES.companies), DATASET_FILES.companies),
    people: parseList(datasetPerson, json(DATASET_FILES.people), DATASET_FILES.people),
    quotes: parseList(datasetQuote, json(DATASET_FILES.quotes), DATASET_FILES.quotes),
  }
  const images = new Map([...files].filter(([path]) => path.startsWith('images/')))
  const warnings = checkDataset(data, images)

  const counts = countDataset(data)
  for (const key of Object.keys(counts) as (keyof DatasetCounts)[]) {
    if (counts[key] !== manifest.counts[key]) {
      throw new DatasetError(
        `Antallet i manifestet stemmer ikke (${key}: ${manifest.counts[key]} i manifestet, ${counts[key]} i dataene).`,
      )
    }
  }
  const used = new Set(referencedImages(data))
  const unused = [...images.keys()].filter((path) => !used.has(path))
  if (unused.length) warnings.push(`${unused.length} bilder i bunten brukes ikke, og hoppes over.`)
  return { manifest, data, images, warnings }
}

/**
 * Lager en bunt. Dataene sjekkes mot skjemaet først, så en bunt som skrives,
 * også kan leses. Bare bildene dataene viser til, tas med.
 */
export function writeDatasetBundle(
  input: Dataset,
  images: Map<string, Uint8Array>,
  createdAt = new Date(),
): { archive: Buffer; manifest: DatasetManifest } {
  const data: Dataset = {
    companies: parseList(datasetCompany, input.companies, DATASET_FILES.companies),
    people: parseList(datasetPerson, input.people, DATASET_FILES.people),
    quotes: parseList(datasetQuote, input.quotes, DATASET_FILES.quotes),
  }
  checkDataset(data, images)
  const entries = [
    { path: DATASET_FILES.companies, data: Buffer.from(JSON.stringify(data.companies)) },
    { path: DATASET_FILES.people, data: Buffer.from(JSON.stringify(data.people)) },
    { path: DATASET_FILES.quotes, data: Buffer.from(JSON.stringify(data.quotes)) },
    ...[...new Set(referencedImages(data))]
      .sort()
      .map((path) => ({ path, data: images.get(path)! })),
  ]
  const manifest: DatasetManifest = {
    format: DATASET_FORMAT,
    schemaVersion: DATASET_SCHEMA_VERSION,
    createdAt: createdAt.toISOString(),
    counts: countDataset(data),
    files: Object.fromEntries(entries.map((e) => [e.path, sha256(e.data)])),
  }
  const archive = createTarGz(
    [{ path: MANIFEST_PATH, data: Buffer.from(JSON.stringify(manifest, null, 2)) }, ...entries],
    createdAt,
  )
  return { archive, manifest }
}

/** Hva som tas med fra bunten. Fødselsdatoer finnes ikke i skjemaet og importeres aldri. */
export type DatasetOptions = {
  /** Bare selskaper, logoer, historikk og saker i media: ingen persondata, koblinger eller sitater. */
  onlyCompanies: boolean
  /** Profilbilder. */
  photos: boolean
  /** Sitater. */
  quotes: boolean
  /** Bio på profilene. */
  bio: boolean
}

export const allDatasetOptions: DatasetOptions = {
  onlyCompanies: false,
  photos: true,
  quotes: true,
  bio: true,
}

const withoutField = (sources: DatasetPerson['fieldSources'], field: string) =>
  Object.fromEntries(Object.entries(sources).filter(([key]) => key !== field))

/** Dataene med bare det valgene tar med. Endrer ikke det som sendes inn. */
export function filterDataset(data: Dataset, options: DatasetOptions): Dataset {
  if (options.onlyCompanies) return { companies: data.companies, people: [], quotes: [] }
  return {
    companies: data.companies,
    people: data.people.map((p) => {
      let person = p
      if (!options.photos) {
        person = {
          ...person,
          photo: null,
          fieldSources: withoutField(person.fieldSources, 'photo'),
        }
      }
      if (!options.bio) {
        person = { ...person, bio: null, fieldSources: withoutField(person.fieldSources, 'bio') }
      }
      return person
    }),
    quotes: options.quotes ? data.quotes : [],
  }
}

/** Valgene som en kort tekst, til utskrift og revisjonsloggen. */
export function describeDatasetOptions(options: DatasetOptions): string[] {
  if (options.onlyCompanies) return ['bare selskaper']
  return [
    ...(options.photos ? [] : ['uten profilbilder']),
    ...(options.quotes ? [] : ['uten sitater']),
    ...(options.bio ? [] : ['uten bio']),
  ]
}
