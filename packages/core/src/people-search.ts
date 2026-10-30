import { createHash } from 'node:crypto'
import { schema, type Db } from '@esaf/db'
import { asc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { assertCan, assertMember, can, type Viewer } from './access.ts'
import { DomainError, NotFoundError } from './errors.ts'
import type { Tx } from './members.ts'
import { normalizePersonName } from './people-admin.ts'
import { photoUrls, type ProfilePhoto } from './photos.ts'
import {
  interpretQuery,
  takeQuota,
  TAGGING_VERSION,
  type QueryPlan,
  type SearchAi,
} from './search-ai.ts'
import { SEARCH_TAXONOMY } from './search-taxonomy.ts'
import { tidyTag } from './validation.ts'

const {
  auditEvent,
  cohort,
  company,
  experience,
  membership,
  person,
  personAiTopics,
  personCohort,
  personSearchIndex,
} = schema

/**
 * Personsøket: finn folk på det de kan og har gjort, ikke bare navnet. «space»
 * skal finne den som jobber i et romfartsselskap, også når ordet ikke står
 * noe sted. Reglene:
 *
 * - **Hva som søkes i:** bare det medlemmer kan se på profilen: stillinger med
 *   selskapets navn, kortbeskrivelse og bransjer (så selskapet forklarer hva
 *   personen driver med), ES-selskapet, bio, «kan hjelpe med», bransjer,
 *   studieretning, by, og søkeordene admins har satt (`person.search_topics`).
 *   Aldri kontaktinfo.
 * - **Biter:** teksten deles i små biter (én per stilling, to setninger av
 *   bioen om gangen, emnene), og hver bit får en vektor fra en lokal
 *   embedding-modell. Et treff er så godt som den beste biten, og biten vises
 *   som grunnen til treffet. Hele profiler som én vektor ga dårlige treff.
 * - **Hybrid:** ord som står i teksten (også starten av ord, uten aksenter og
 *   store bokstaver) og likhet i mening slås sammen (reciprocal rank fusion).
 *   Navnetreff kommer først. Uten modell (f.eks. før den er lastet ned) virker
 *   ordsøket alene.
 * - **Søkeord:** for det modellen ikke klarer alene, skriver Claude emner på
 *   norsk og engelsk fra profilteksten, også bredere begreper: NASA → romfart,
 *   space, aerospace, satellitter (`refreshAiTopics`, i bakgrunnen). Admins kan
 *   sette egne (`person.search_topics`); da brukes de i stedet.
 * - **Tolkning:** med Claude blir søket gjort om til emner med beslektede ord
 *   og filtre (by, kull, gründer) før det søkes (`interpretQuery` i
 *   `search-ai.ts`). Uten Claude brukes begrepslista i `search-taxonomy.ts`.
 * - **Spør ESAF** (`askPeople`): søket finner kandidatene, Claude leser dem og
 *   velger dem som passer, med en setning om hvorfor.
 * - **Indeksen** oppdateres i bakgrunnen (`reindexPeople`): bitene bygges for
 *   alle, og bare personer der bitene eller modellen er endret, får nye vektorer.
 *   Vektorene holdes i minnet og hentes på nytt når indeksen endres.
 * - **Synlighet:** medlemmer finner bare aktive medlemmer, som i katalogen.
 *   Admins med `profiles.edit` kan søke blant alle.
 */

/** Lager vektorer. `query` og `passage` kan få ulike prefikser i modellen. */
export type Embedder = {
  model: string
  embed(texts: string[], as: 'query' | 'passage'): Promise<Float32Array[]>
}

export type SearchChunk = { kind: 'job' | 'es' | 'bio' | 'topics' | 'study'; text: string }

type PersonDoc = {
  personId: string
  fullName: string
  city: string | null
  status: string | null
  /** Admins har satt søkeord; da brukes ikke de fra Claude. */
  manualTopics: boolean
  chunks: SearchChunk[]
}

const sentences = (text: string) =>
  text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 12)

const firstSentence = (text: string | null) => (text ? (sentences(text)[0] ?? null) : null)

/**
 * Fjerner e-postadresser og telefonnumre fra fritekst (noen bioer fra import har
 * dem), så søket aldri viser kontaktinfo personen har skjult på profilen.
 */
export function redact(text: string) {
  return text
    .replace(/[^\s<>(),;:"'[\]]+@[^\s<>(),;:"'[\]]+\.[a-z]{2,}/gi, '[e-post]')
    .replace(/(?:\+?\d[\d ().-]{6,}\d)/g, (m) =>
      m.replace(/\D/g, '').length >= 8 ? '[telefon]' : m,
    )
}

/**
 * Bitene for alle personer, eller noen. Rekkefølgen er fast, så hashen blir
 * stabil. `withTopics: false` gir teksten uten søkeord (det Claude skriver
 * søkeord fra).
 */
export async function buildSearchDocs(
  db: Db | Tx,
  personIds?: string[],
  { withTopics = true }: { withTopics?: boolean } = {},
): Promise<PersonDoc[]> {
  const where = personIds ? inArray(person.id, personIds) : undefined
  const [people, jobs, aiTopics] = await Promise.all([
    db
      .select({
        id: person.id,
        fullName: person.fullName,
        city: person.city,
        bio: person.bio,
        expertise: person.expertise,
        industries: person.industries,
        studyBackground: person.studyBackground,
        searchTopics: person.searchTopics,
        status: membership.status,
        esName: company.name,
        esTagline: company.tagline,
        esIndustries: company.industries,
      })
      .from(person)
      .leftJoin(membership, eq(membership.personId, person.id))
      .leftJoin(company, eq(company.id, person.esCompanyId))
      .where(where)
      .orderBy(asc(person.id)),
    db
      .select({
        personId: experience.personId,
        title: experience.title,
        founder: experience.founder,
        startYear: experience.startYear,
        endYear: experience.endYear,
        name: company.name,
        tagline: company.tagline,
        description: company.description,
        industries: company.industries,
      })
      .from(experience)
      .innerJoin(company, eq(company.id, experience.companyId))
      .where(personIds ? inArray(experience.personId, personIds) : undefined)
      .orderBy(asc(experience.personId), asc(experience.position)),
    withTopics
      ? db
          .select({ personId: personAiTopics.personId, topics: personAiTopics.topics })
          .from(personAiTopics)
          .where(personIds ? inArray(personAiTopics.personId, personIds) : undefined)
      : Promise.resolve([]),
  ])
  const aiOf = new Map(aiTopics.map((t) => [t.personId, t.topics]))
  const jobsOf = new Map<string, typeof jobs>()
  for (const j of jobs) jobsOf.set(j.personId, [...(jobsOf.get(j.personId) ?? []), j])

  return people.map((p) => {
    const chunks: SearchChunk[] = []
    for (const j of jobsOf.get(p.id) ?? []) {
      const role = [j.founder ? 'Gründer' : null, j.title].filter(Boolean).join(', ') || 'Jobber'
      const when = j.endYear === null ? '' : ` (til ${j.endYear})`
      const about = j.tagline ?? firstSentence(j.description)
      chunks.push({
        kind: 'job',
        text:
          `${role} i ${j.name}${when}` +
          (about ? ` – ${about}` : '') +
          (j.industries.length ? ` (${j.industries.join(', ')})` : ''),
      })
    }
    if (p.esName && p.esTagline) {
      chunks.push({
        kind: 'es',
        text:
          `ES-selskap: ${p.esName} – ${p.esTagline}` +
          (p.esIndustries?.length ? ` (${p.esIndustries.join(', ')})` : ''),
      })
    }
    // To setninger av bioen om gangen; korte setninger henger på den forrige.
    const bio = p.bio ? sentences(redact(p.bio)) : []
    let part = ''
    for (const sentence of bio) {
      part = part ? `${part} ${sentence}` : sentence
      if (part.length >= 120) {
        chunks.push({ kind: 'bio', text: part })
        part = ''
      }
    }
    if (part.length >= 25) chunks.push({ kind: 'bio', text: part })
    // Korte opplysninger samles i én bit: alene ligner de på nesten alt.
    const own = !withTopics ? [] : p.searchTopics.length ? p.searchTopics : (aiOf.get(p.id) ?? [])
    const topics = [...new Set([...own, ...p.expertise, ...p.industries])]
    const profile = [
      topics.length ? `Emner: ${topics.join(', ')}` : null,
      p.studyBackground ? `Studerte ${p.studyBackground}` : null,
      p.esName && !p.esTagline ? `ES-selskap: ${p.esName}` : null,
    ].filter(Boolean)
    if (profile.length)
      chunks.push({ kind: topics.length ? 'topics' : 'study', text: profile.join('. ') })
    return {
      personId: p.id,
      fullName: p.fullName,
      city: p.city,
      status: p.status,
      manualTopics: p.searchTopics.length > 0,
      chunks,
    }
  })
}

/**
 * Biter som får vektor. Korte opplysninger alene (studieretning, et ES-selskap
 * uten beskrivelse) ligner på nesten alt i modellen, så de finnes bare med ord.
 */
const embeddable = (c: SearchChunk) => c.kind !== 'study' && c.text.length >= 25

const hashDoc = (doc: PersonDoc, model: string) =>
  createHash('sha256')
    .update(JSON.stringify([model, doc.chunks]))
    .digest('hex')

const toBuffer = (vectors: Float32Array[]) => {
  const dims = vectors[0]?.length ?? 0
  const out = new Float32Array(vectors.length * dims)
  vectors.forEach((v, i) => out.set(v, i * dims))
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength)
}

export type ReindexResult = { indexed: number; removed: number; unchanged: number; total: number }

/**
 * Oppdaterer indeksen: personer der bitene eller modellen er endret, får nye
 * vektorer. Personer uten tekst å søke i, tas ut. `limit` begrenser hvor mange
 * som embeddes per runde, så en stor første indeksering ikke blokkerer lenge.
 * Ingen rettighetssjekk: kalles av serveren selv (bakgrunnsjobb og CLI).
 */
export async function reindexPeople(
  db: Db,
  embedder: Embedder,
  { limit = 200, batchSize = 32 }: { limit?: number; batchSize?: number } = {},
): Promise<ReindexResult> {
  const [docs, existing] = await Promise.all([
    buildSearchDocs(db),
    db
      .select({
        personId: personSearchIndex.personId,
        contentHash: personSearchIndex.contentHash,
      })
      .from(personSearchIndex),
  ])
  const known = new Map(existing.map((r) => [r.personId, r.contentHash]))
  const stale = docs.filter(
    (d) => d.chunks.length > 0 && known.get(d.personId) !== hashDoc(d, embedder.model),
  )
  const empty = docs.filter((d) => d.chunks.length === 0 && known.has(d.personId))
  const gone = existing.filter((r) => !docs.some((d) => d.personId === r.personId))
  const removeIds = [...empty.map((d) => d.personId), ...gone.map((r) => r.personId)]
  if (removeIds.length) {
    await db.delete(personSearchIndex).where(inArray(personSearchIndex.personId, removeIds))
  }

  const todo = stale.slice(0, limit)
  for (let i = 0; i < todo.length; i += batchSize) {
    const batch = todo
      .slice(i, i + batchSize)
      .map((d) => ({ doc: d, chunks: d.chunks.filter(embeddable) }))
    const texts = batch.flatMap((b) => b.chunks.map((c) => c.text))
    const vectors = texts.length ? await embedder.embed(texts, 'passage') : []
    let at = 0
    const rows = batch.map(({ doc: d, chunks }) => {
      const own = vectors.slice(at, at + chunks.length)
      at += chunks.length
      return {
        personId: d.personId,
        contentHash: hashDoc(d, embedder.model),
        model: embedder.model,
        chunks,
        vectors: toBuffer(own),
        dims: own[0]?.length ?? 0,
        indexedAt: new Date(),
      }
    })
    await db
      .insert(personSearchIndex)
      .values(rows)
      .onConflictDoUpdate({
        target: personSearchIndex.personId,
        set: {
          contentHash: sql`excluded.content_hash`,
          model: sql`excluded.model`,
          chunks: sql`excluded.chunks`,
          vectors: sql`excluded.vectors`,
          dims: sql`excluded.dims`,
          indexedAt: sql`excluded.indexed_at`,
        },
      })
  }
  invalidateVectors()
  return {
    indexed: todo.length,
    removed: removeIds.length,
    unchanged: docs.length - stale.length - empty.length,
    total: docs.length,
  }
}

// ---------------------------------------------------------------------------
// Søkeord fra Claude
// ---------------------------------------------------------------------------

/** Teksten Claude skriver søkeord fra: alt unntatt søkeordene selv. */
const taggingText = (doc: PersonDoc) => doc.chunks.map((c) => c.text)

/** Om det står nok om personen til at søkeord gir mening (mer enn et navn og en studieretning). */
const worthTagging = (doc: PersonDoc) => doc.chunks.some((c) => c.kind !== 'study')

const hashSource = (doc: PersonDoc) =>
  createHash('sha256')
    .update(JSON.stringify([TAGGING_VERSION, taggingText(doc)]))
    .digest('hex')

export type AiTopicsResult = { tagged: number; removed: number; pending: number }

/**
 * Lar Claude skrive søkeord for personer der profilteksten er ny eller endret.
 * Personer med søkeord fra en admin hoppes over (de brukes i stedet), og
 * personer uten tekst får ingen. `limit` per runde, `groupSize` profiler per
 * kall til Claude. Etterpå må søkeindeksen oppdateres (`reindexPeople`), siden
 * søkeordene er en del av teksten. Ingen rettighetssjekk: kalles av serveren.
 */
export async function refreshAiTopics(
  db: Db,
  ai: SearchAi,
  {
    limit = 40,
    groupSize = 10,
    concurrency = 2,
  }: { limit?: number; groupSize?: number; concurrency?: number } = {},
): Promise<AiTopicsResult> {
  const [docs, existing] = await Promise.all([
    buildSearchDocs(db, undefined, { withTopics: false }),
    db
      .select({ personId: personAiTopics.personId, sourceHash: personAiTopics.sourceHash })
      .from(personAiTopics),
  ])
  const known = new Map(existing.map((r) => [r.personId, r.sourceHash]))
  const wanted = docs.filter((d) => !d.manualTopics && worthTagging(d))
  const wantedIds = new Set(wanted.map((d) => d.personId))
  const removeIds = existing.map((r) => r.personId).filter((id) => !wantedIds.has(id))
  if (removeIds.length) {
    await db.delete(personAiTopics).where(inArray(personAiTopics.personId, removeIds))
  }
  const stale = wanted.filter((d) => known.get(d.personId) !== hashSource(d))
  const todo = stale.slice(0, limit)
  const groups: PersonDoc[][] = []
  for (let i = 0; i < todo.length; i += groupSize) groups.push(todo.slice(i, i + groupSize))

  let tagged = 0
  const work = async (group: PersonDoc[]) => {
    const topics = await ai.tagProfiles(
      group.map((d) => ({ personId: d.personId, text: taggingText(d) })),
    )
    // Søkeordene ryddes som de en admin skriver; det som ikke passer, droppes.
    // Også personer Claude ikke ga søkeord, lagres (tomt), så de ikke spørres
    // om igjen før teksten endres.
    const rows = group.map((d) => {
      const raw = (topics.get(d.personId) ?? [])
        .map((t) => t.trim())
        .filter((t) => t.length >= 2 && t.length <= 40)
      const parsed = searchTopicsInput.safeParse(raw.slice(0, 25))
      return {
        personId: d.personId,
        topics: parsed.success ? parsed.data : [],
        sourceHash: hashSource(d),
        model: ai.model,
        generatedAt: new Date(),
      }
    })
    await db
      .insert(personAiTopics)
      .values(rows)
      .onConflictDoUpdate({
        target: personAiTopics.personId,
        set: {
          topics: sql`excluded.topics`,
          sourceHash: sql`excluded.source_hash`,
          model: sql`excluded.model`,
          generatedAt: sql`excluded.generated_at`,
        },
      })
    tagged += rows.length
  }
  // Noen kall om gangen; feiler ett, stopper runden (neste runde prøver igjen).
  for (let i = 0; i < groups.length; i += concurrency) {
    await Promise.all(groups.slice(i, i + concurrency).map(work))
  }
  return { tagged, removed: removeIds.length, pending: stale.length - tagged }
}

// ---------------------------------------------------------------------------
// Vektorene i minnet
// ---------------------------------------------------------------------------

type Vectors = {
  model: string
  byPerson: Map<string, { chunks: SearchChunk[]; data: Float32Array; dims: number }>
}
let cached: { version: string; vectors: Vectors } | null = null
const invalidateVectors = () => {
  cached = null
}

async function loadVectors(db: Db, model: string): Promise<Vectors> {
  const [state] = await db
    .select({
      n: sql<number>`count(*)::int`,
      at: sql<string | null>`max(${personSearchIndex.indexedAt})::text`,
    })
    .from(personSearchIndex)
    .where(eq(personSearchIndex.model, model))
  const version = `${model}|${state?.n}|${state?.at}`
  if (cached?.version === version) return cached.vectors
  const rows = await db
    .select({
      personId: personSearchIndex.personId,
      chunks: personSearchIndex.chunks,
      vectors: personSearchIndex.vectors,
      dims: personSearchIndex.dims,
    })
    .from(personSearchIndex)
    .where(eq(personSearchIndex.model, model))
  const byPerson = new Map<string, { chunks: SearchChunk[]; data: Float32Array; dims: number }>()
  for (const r of rows) {
    const copy = new Uint8Array(r.vectors)
    byPerson.set(r.personId, {
      chunks: r.chunks as SearchChunk[],
      data: new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4),
      dims: r.dims,
    })
  }
  const vectors = { model, byPerson }
  cached = { version, vectors }
  return vectors
}

// ---------------------------------------------------------------------------
// Søket
// ---------------------------------------------------------------------------

export type PeopleSearchHit = {
  personId: string
  fullName: string
  photo: ProfilePhoto | null
  claimed: boolean
  cohortYears: number[]
  /** Teksten som passet best, til å vise hvorfor personen kom med. */
  reason: string | null
  /**
   * `name`: navnet, `text`: ordene står i profilen, `meaning`: lik i mening,
   * `filter`: søket var bare filtre (by, kull, gründer), og personen passer.
   */
  matchedBy: 'name' | 'text' | 'meaning' | 'filter'
  score: number
}

const norm = (s: string) => normalizePersonName(s)

/** Ord som ikke sier noe om hva noen kan («noen som har erfaring med …»). */
const STOPWORDS = new Set(
  (
    'og i på med for om av til fra som har hatt er var en et ei den det de noen kan vil jeg vi du hvem hva hvor ' +
    'innen innenfor erfaring kunnskap jobbet jobber startet selskap selskaper bakgrunn folk person personer ' +
    'and or the of in on at for with who has have had is are was a an someone somebody people person knows know ' +
    'about worked works working experience background company companies started hjelpe hjelp help helping finne find'
  ).split(' '),
)

const TAXONOMY = SEARCH_TAXONOMY.map((group) => group.map(norm))

/** Innholdsordene i søket, med begrepene (fra `SEARCH_TAXONOMY`) hvert ord treffer. */
export function expandQuery(query: string): { token: string; synonyms: string[] }[] {
  const nq = norm(query)
  const padded = ` ${nq} `
  return nq
    .split(' ')
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map((token) => {
      const groups = TAXONOMY.filter((g) =>
        g.some(
          (s) =>
            s === token ||
            (token.length >= 4 && s.startsWith(token)) ||
            (s.length >= 5 && token.startsWith(s)) ||
            (s.includes(' ') && padded.includes(` ${s} `)),
        ),
      )
      return { token, synonyms: [...new Set(groups.flat())].filter((s) => s !== token) }
    })
}

/**
 * Hvor godt et ord står i en tekst: helt ord 1, starten av et ord 0,6, inne i et
 * sammensatt ord («oppdrett» i «lakseoppdrett») 0,5. Fraser må stå som fraser.
 */
function termScore(term: string, words: string[], padded: string) {
  if (term.includes(' ')) return padded.includes(` ${term} `) ? 1 : 0
  if (words.includes(term)) return 1
  if (term.length >= 4 && words.some((w) => w.startsWith(term))) return 0.6
  if (term.length >= 5 && words.some((w) => w.length > term.length && w.includes(term))) return 0.5
  return 0
}

/**
 * Andelen innholdsord som står i teksten, direkte eller med et ord fra begrepet
 * (×0,8). `direct`: hvert ord som traff, traff selv, ikke via et synonym.
 */
function lexicalScore(terms: ReturnType<typeof expandQuery>, text: string) {
  if (!terms.length) return { score: 0, direct: false }
  const joined = norm(text)
  const words = joined.split(' ')
  const padded = ` ${joined} `
  let sum = 0
  let direct = true
  for (const { token, synonyms } of terms) {
    const own = termScore(token, words, padded)
    let best = own
    for (const s of synonyms) if (best < 1) best = Math.max(best, 0.8 * termScore(s, words, padded))
    if (best > own) direct = false
    sum += best
  }
  const fraction = sum / terms.length
  return { score: fraction >= 0.5 ? fraction : 0, direct }
}

/**
 * Søkeordene fra Claudes tolkning av søket, i samme form som `expandQuery`:
 * hvert emne er ett ord som må treffes, med de beslektede ordene og begrepene
 * fra begrepslista som synonymer.
 */
export function planTerms(plan: QueryPlan): ReturnType<typeof expandQuery> {
  return plan.topics.map(({ term, related }) => {
    const token = norm(term)
    const fromTaxonomy = expandQuery(term).flatMap((t) => [t.token, ...t.synonyms])
    const synonyms = [...new Set([...related.map(norm), ...fromTaxonomy])].filter(
      (s) => s.length > 1 && s !== token,
    )
    return { token, synonyms }
  })
}

const hasFilters = (plan: QueryPlan | null | undefined): plan is QueryPlan =>
  !!plan &&
  (plan.cities.length > 0 || plan.cohortFrom !== null || plan.cohortTo !== null || plan.founder)

/** Filtrene som tekst, til grunnen for et treff: «Oslo · ES 2015 · gründer». */
export function describeFilters(plan: QueryPlan) {
  const years =
    plan.cohortFrom === null && plan.cohortTo === null
      ? null
      : plan.cohortFrom === plan.cohortTo
        ? `ES ${plan.cohortFrom}`
        : plan.cohortFrom === null
          ? `ES til ${plan.cohortTo}`
          : plan.cohortTo === null
            ? `ES fra ${plan.cohortFrom}`
            : `ES ${plan.cohortFrom}–${plan.cohortTo}`
  return [...plan.cities, years, plan.founder ? 'gründer' : null].filter(Boolean).join(' · ')
}

/** Personene som passer filtrene i tolkningen (by, kull, gründer). */
async function filterByPlan(db: Db, docs: PersonDoc[], plan: QueryPlan) {
  const ids = docs.map((d) => d.personId)
  if (!ids.length) return docs
  const cohortFilter = plan.cohortFrom !== null || plan.cohortTo !== null
  const [years, founders] = await Promise.all([
    cohortFilter
      ? db
          .select({ personId: personCohort.personId, year: cohort.graduationYear })
          .from(personCohort)
          .innerJoin(cohort, eq(cohort.id, personCohort.cohortId))
      : Promise.resolve([]),
    plan.founder
      ? db
          .selectDistinct({ personId: experience.personId })
          .from(experience)
          .where(eq(experience.founder, true))
      : Promise.resolve([]),
  ])
  const from = plan.cohortFrom ?? -Infinity
  const to = plan.cohortTo ?? Infinity
  const inCohort = new Set(
    years.filter((y) => y.year >= from && y.year <= to).map((y) => y.personId),
  )
  const founder = new Set(founders.map((f) => f.personId))
  const cities = plan.cities.map(norm).filter(Boolean)
  return docs.filter((d) => {
    if (cohortFilter && !inCohort.has(d.personId)) return false
    if (plan.founder && !founder.has(d.personId)) return false
    if (cities.length) {
      const city = norm(d.city ?? '')
      if (!city || !cities.some((c) => city === c || city.split(' ').includes(c))) return false
    }
    return true
  })
}

/** Ordtreff veier så mye mer enn likhet i mening (målt i standardavvik). */
const LEXICAL_WEIGHT = 6
/** Et ordtreff teller bare når biten også ligner litt på søket (ikke metaforer som «an impatient rocket»). */
const EVIDENCE_FLOOR = 0.5
/** Treff bare på mening: standardavvik over snittet, når søket har et kjent begrep eller ordtreff. */
const MEANING_CUTOFF = 2
/** … og når det ikke har det. Rundt det tilfeldig støy når blant noen hundre personer. */
const MEANING_CUTOFF_UNKNOWN = 3.5
/** Høyst så mange treff bare på mening (og når søket ikke treffer noe kjent). */
const MEANING_MAX = 10
const MEANING_MAX_UNKNOWN = 5
/** Kandidater til Spør ESAF: lavere krav og flere, Claude sorterer bort det som ikke passer. */
const MEANING_CUTOFF_BROAD = 1
const MEANING_MAX_BROAD = 30

let embedderWarned = false

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1)
const spread = (xs: number[], m: number) =>
  Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length || 1)) || 1

/**
 * Søker etter personer på hva de kan og har gjort. Treffene er
 * sammenlignet innenfor søket (standardavvik over snittet), så det virker likt
 * med ulike modeller. Uten `embedder` (eller før indeksen finnes) er det et rent
 * ordsøk, med begrepene. Medlemmer finner bare aktive medlemmer.
 *
 * Innstillingene er valgt ved å måle mot ekte profiler (673 personer): 48 søk
 * på norsk, engelsk og som setninger, mot fasit fra profilteksten og en
 * manuell vurdering av treffene. Med begreper og disse vektene: nDCG@10 0,87
 * mot 0,48 uten begreper og 0,69 med den første versjonen (e5-small).
 */
export async function searchPeopleByTopic(
  db: Db,
  viewer: Viewer,
  query: string,
  {
    embedder,
    limit = 20,
    plan,
    broad = false,
  }: {
    embedder?: Embedder | null
    limit?: number
    /** Claudes tolkning av søket (`interpretQuery`). Uten den brukes begrepslista. */
    plan?: QueryPlan | null
    /** Flere og svakere treff på mening, som kandidater til `askPeople`. */
    broad?: boolean
  } = {},
): Promise<PeopleSearchHit[]> {
  assertMember(viewer)
  const q = query.trim().slice(0, 200)
  const nameTokens = norm(q).split(' ').filter(Boolean)
  if (!nameTokens.length) return []
  // En tolkning uten emner og filtre (et navn, f.eks.) gir ingenting å gå på.
  const usePlan = plan && (plan.topics.length > 0 || hasFilters(plan)) ? plan : null
  const terms = usePlan ? planTerms(usePlan) : expandQuery(q)
  const everyone = can(viewer, 'profiles.edit')

  let docs = (await buildSearchDocs(db)).filter((d) => everyone || d.status === 'active')
  const visible = new Map(docs.map((d) => [d.personId, d]))
  const filtered = hasFilters(usePlan)
  if (filtered) docs = await filterByPlan(db, docs, usePlan)

  // Navn: alle ordene i søket står i navnet.
  const byName = new Set(
    (filtered ? [...visible.values()] : docs)
      .filter((d) => {
        const words = norm(d.fullName).split(' ')
        return nameTokens.every((t) =>
          words.some((w) => w === t || (t.length >= 2 && w.startsWith(t))),
        )
      })
      .map((d) => d.personId),
  )

  // Ord i profilen, også begrepene. Direkte treff i søkeord, stillinger og
  // selskaper er sikre; i bioen (fritekst, metaforer) og via synonymer må biten
  // også ligne på søket (se under).
  const lexical = new Map<string, { score: number; chunk: string; trusted: boolean }>()
  for (const d of docs) {
    let best = { score: 0, chunk: '', trusted: false }
    for (const c of d.chunks) {
      const hit = lexicalScore(terms, c.text)
      const score = hit.score * (c.kind === 'topics' ? 1.2 : 1)
      if (score > best.score)
        best = { score, chunk: c.text, trusted: hit.direct && c.kind !== 'bio' }
    }
    if (d.city) {
      const hit = lexicalScore(terms, d.city)
      if (hit.score > best.score) best = { score: hit.score, chunk: d.city, trusted: hit.direct }
    }
    if (best.score > 0) lexical.set(d.personId, best)
  }

  // Mening: søket alene, med begrepene, og begrepene alene; beste bit per person.
  const synonyms = [...new Set(terms.flatMap((t) => t.synonyms))].slice(0, 12)
  const topicText = usePlan ? usePlan.topics.map((t) => t.term).join(', ') : q
  const queryTexts = !terms.length
    ? []
    : synonyms.length
      ? [topicText, `${topicText} (${synonyms.join(', ')})`, synonyms.join(', ')]
      : [topicText]
  const queryVectors =
    embedder && queryTexts.length
      ? await embedder.embed(queryTexts, 'query').catch((error: unknown) => {
          if (!embedderWarned)
            console.error('[esaf/search] Embedding feilet, bruker ordsøk:', error)
          embedderWarned = true
          return null
        })
      : null
  const semantic = new Map<string, { sim: number; chunk: string }>()
  const chunkSims = new Map<string, number>()
  const allSims: number[] = []
  if (embedder && queryVectors?.length) {
    const vectors = await loadVectors(db, embedder.model)
    const inScope = new Set(docs.map((d) => d.personId))
    for (const [personId, v] of vectors.byPerson) {
      if (!inScope.has(personId) || v.dims !== queryVectors[0]!.length) continue
      let best = { sim: -1, chunk: '' }
      for (let c = 0; c < v.chunks.length; c++) {
        const off = c * v.dims
        let sim = -1
        for (const qv of queryVectors) {
          let s = 0
          for (let k = 0; k < v.dims; k++) s += qv[k]! * v.data[off + k]!
          sim = Math.max(sim, s)
        }
        const text = v.chunks[c]!.text
        chunkSims.set(`${personId}\n${text}`, sim)
        allSims.push(sim)
        if (sim > best.sim) best = { sim, chunk: text }
      }
      semantic.set(personId, best)
    }
  }

  // Sammenlignet innenfor søket: hvor mange standardavvik over snittet.
  const personSims = [...semantic.values()].map((s) => s.sim)
  const pm = mean(personSims)
  const ps = spread(personSims, pm)
  const cm = mean(allSims)
  const cs = spread(allSims, cm)
  // Likhet i mening alene er usikker når søket verken treffer et kjent begrep
  // eller står i noen profil («xyzzy», «origami»): da kreves mer. Blant n
  // personer kan ingen ligge mer enn √(n−1) standardavvik over snittet, så med
  // få personer (en ny database, testene) skaleres kravet ned.
  const known = synonyms.length > 0 || lexical.size > 0
  const base = broad ? MEANING_CUTOFF_BROAD : known ? MEANING_CUTOFF : MEANING_CUTOFF_UNKNOWN
  const cutoff = Math.min(base, Math.max(1, 0.6 * Math.sqrt(Math.max(personSims.length - 1, 1))))

  const scored: {
    id: string
    score: number
    matchedBy: PeopleSearchHit['matchedBy']
    reason: string | null
  }[] = []
  // Bare filtre («folk i Oslo fra ES 2015»): alle som passer, etter navn.
  if (filtered && !terms.length) {
    const label = describeFilters(usePlan)
    for (const d of [...docs].sort((a, b) => a.fullName.localeCompare(b.fullName, 'nb'))) {
      scored.push({ id: d.personId, score: 0, matchedBy: 'filter', reason: label })
    }
  }
  for (const d of filtered && !terms.length ? [] : docs) {
    const id = d.personId
    const s = semantic.get(id)
    const z = s ? (s.sim - pm) / ps : -Infinity
    const lex = lexical.get(id)
    const evidence =
      lex &&
      (lex.trusted ||
        !semantic.size ||
        ((chunkSims.get(`${id}\n${lex.chunk}`) ?? cm) - cm) / cs >= EVIDENCE_FLOOR)
    const lexScore = evidence ? lex!.score : 0
    if (byName.has(id)) {
      scored.push({
        id,
        score: 1000 + (Number.isFinite(z) ? z : 0),
        matchedBy: 'name',
        reason: null,
      })
    } else if (lexScore > 0) {
      scored.push({
        id,
        score: (Number.isFinite(z) ? z : 0) + LEXICAL_WEIGHT * lexScore,
        matchedBy: 'text',
        reason: lex!.chunk,
      })
    } else if (s && z >= cutoff) {
      scored.push({ id, score: z, matchedBy: 'meaning', reason: s.chunk })
    }
  }
  // Høyst så mange treff bare på mening: de beste, resten er støy.
  let meaningOnly = 0
  const meaningMax = broad ? MEANING_MAX_BROAD : known ? MEANING_MAX : MEANING_MAX_UNKNOWN
  const ranked = scored
    .sort((a, b) => b.score - a.score)
    .filter((r) => r.matchedBy !== 'meaning' || ++meaningOnly <= meaningMax)
    .slice(0, Math.min(limit, filtered && !terms.length ? 500 : 100))
  if (!ranked.length) return []

  const ids = ranked.map((r) => r.id)
  const [people, years] = await Promise.all([
    db
      .select({ id: person.id, photoKey: person.photoKey, userId: person.userId })
      .from(person)
      .where(inArray(person.id, ids)),
    db
      .select({ personId: personCohort.personId, year: cohort.graduationYear })
      .from(personCohort)
      .innerJoin(cohort, eq(cohort.id, personCohort.cohortId))
      .where(inArray(personCohort.personId, ids))
      .orderBy(asc(cohort.graduationYear)),
  ])
  const extra = new Map(people.map((p) => [p.id, p]))
  return ranked.map((r) => ({
    personId: r.id,
    fullName: visible.get(r.id)!.fullName,
    photo: photoUrls(extra.get(r.id)?.photoKey ?? null),
    claimed: extra.get(r.id)?.userId != null,
    cohortYears: years.filter((y) => y.personId === r.id).map((y) => y.year),
    reason: r.reason,
    matchedBy: r.matchedBy,
    score: Math.round(r.score * 1000) / 1000,
  }))
}

/**
 * Søket med Claudes tolkning når `ai` er satt (se `interpretQuery`): emner med
 * beslektede ord, og filtre for by, kull og gründer. Tolkningen er med i
 * svaret, så den kan vises («helse · Oslo · ES 2015»). Går tolkningen ikke
 * (ingen nøkkel, kvote, feil), er det vanlig søk.
 */
export async function searchPeopleInterpreted(
  db: Db,
  viewer: Viewer,
  query: string,
  {
    embedder,
    ai,
    limit = 20,
  }: { embedder?: Embedder | null; ai?: SearchAi | null; limit?: number } = {},
): Promise<{
  hits: PeopleSearchHit[]
  interpreted: { topics: string[]; filters: string | null } | null
}> {
  assertMember(viewer)
  const plan = query.trim().length >= 2 ? await interpretQuery(ai, query, viewer.personId) : null
  const hits = await searchPeopleByTopic(db, viewer, query, { embedder, limit, plan })
  const used = plan && (plan.topics.length > 0 || hasFilters(plan))
  return {
    hits,
    interpreted: used
      ? {
          topics: plan.topics.map((t) => t.term),
          filters: hasFilters(plan) ? describeFilters(plan) : null,
        }
      : null,
  }
}

// ---------------------------------------------------------------------------
// Spør ESAF
// ---------------------------------------------------------------------------

/** Spørsmål til Spør ESAF per person per time. */
export const ASK_PER_HOUR = 30
/** Så mange kandidater fra søket leser Claude. */
const ASK_CANDIDATES = 30
/** Så mye tekst per kandidat (tegn). */
const ASK_TEXT = 900

export type AskHit = PeopleSearchHit & {
  /** Claudes begrunnelse, fra det som står på profilen. */
  why: string
  /** Passer tydelig (`false`: delvis eller indirekte). */
  strong: boolean
}

export type AskResult = {
  question: string
  summary: string
  /** Filtrene Claude fant i spørsmålet, som tekst («Oslo · ES 2015»), eller `null`. */
  filters: string | null
  hits: AskHit[]
}

/**
 * Spør ESAF: «Hvem kan hjelpe meg å selge til sykehus?». Søket finner opptil
 * 30 kandidater (tolket av Claude, med lavere krav enn vanlig), Claude leser
 * utdrag av profilene deres og velger dem som passer, best først, med en
 * setning om hvorfor. Medlemmer får bare kandidater de ellers kan se. Kvote per
 * person (`ASK_PER_HOUR`).
 */
export async function askPeople(
  db: Db,
  viewer: Viewer,
  question: string,
  { embedder, ai }: { embedder?: Embedder | null; ai: SearchAi | null | undefined },
): Promise<AskResult> {
  assertMember(viewer)
  const q = question.replace(/\s+/g, ' ').trim().slice(0, 300)
  if (q.length < 3) throw new DomainError('Skriv litt mer om hva du leter etter.')
  if (!ai) throw new DomainError('Spør ESAF er ikke slått på.')
  if (!takeQuota(`ask:${viewer.personId}`, ASK_PER_HOUR)) {
    throw new DomainError('Du har spurt mange ganger den siste timen. Prøv igjen litt senere.')
  }
  const plan = await interpretQuery(ai, q, viewer.personId)
  const candidates = await searchPeopleByTopic(db, viewer, q, {
    embedder,
    plan,
    broad: true,
    limit: ASK_CANDIDATES,
  })
  const filters = plan && hasFilters(plan) ? describeFilters(plan) : null
  if (!candidates.length) return { question: q, summary: '', filters, hits: [] }

  const docs = new Map(
    (
      await buildSearchDocs(
        db,
        candidates.map((c) => c.personId),
      )
    ).map((d) => [d.personId, d]),
  )
  const input = candidates.map((c) => {
    const lines: string[] = []
    let used = 0
    for (const chunk of docs.get(c.personId)?.chunks ?? []) {
      if (used + chunk.text.length > ASK_TEXT) {
        if (used < ASK_TEXT - 80) lines.push(`${chunk.text.slice(0, ASK_TEXT - used)}…`)
        break
      }
      lines.push(chunk.text)
      used += chunk.text.length
    }
    if (c.cohortYears.length) lines.push(`ES ${c.cohortYears.join(', ')}`)
    const city = docs.get(c.personId)?.city
    if (city) lines.push(`Bor i ${city}`)
    return { personId: c.personId, text: lines }
  })
  let ranked
  try {
    ranked = await ai.rankCandidates(q, input)
  } catch (error) {
    console.error('[esaf/search] Spør ESAF feilet:', error)
    throw new DomainError('Fikk ikke svar fra Claude akkurat nå. Prøv igjen om litt.')
  }
  const byId = new Map(candidates.map((c) => [c.personId, c]))
  return {
    question: q,
    summary: ranked.summary,
    filters,
    hits: ranked.matches.flatMap((m) => {
      const hit = byId.get(m.personId)
      return hit ? [{ ...hit, why: m.why, strong: m.strong }] : []
    }),
  }
}

// ---------------------------------------------------------------------------
// Søkeord
// ---------------------------------------------------------------------------

export const searchTopicsInput = z
  .array(z.string().trim().min(2).max(40, 'Hvert søkeord kan ha maks 40 tegn.').transform(tidyTag))
  .max(25, 'Maks 25 søkeord.')
  .transform((list) =>
    list.filter(
      (t, i) =>
        list.findIndex((o) => o.toLocaleLowerCase('nb') === t.toLocaleLowerCase('nb')) === i,
    ),
  )

/**
 * Setter søkeordene til personer (erstatter dem). Bare admins med `profiles.edit`.
 * Logges som `profile.search_topics`, én hendelse per person som endres.
 */
export async function setSearchTopics(
  db: Db,
  viewer: Viewer,
  input: { personId: string; topics: string[] }[],
): Promise<{ updated: number }> {
  assertCan(viewer, 'profiles.edit')
  if (!input.length) return { updated: 0 }
  if (input.length > 200) throw new DomainError('Høyst 200 personer om gangen.')
  const parsed = input.map((row) => {
    const topics = searchTopicsInput.safeParse(row.topics)
    if (!topics.success)
      throw new DomainError(topics.error.issues[0]?.message ?? 'Ugyldige søkeord.')
    return { personId: row.personId, topics: topics.data }
  })
  return db.transaction(async (tx) => {
    const ids = parsed.map((r) => r.personId)
    const current = await tx
      .select({ id: person.id, topics: person.searchTopics })
      .from(person)
      .where(inArray(person.id, ids))
      .for('update')
    const byId = new Map(current.map((r) => [r.id, r.topics]))
    let updated = 0
    for (const row of parsed) {
      const before = byId.get(row.personId)
      if (!before) throw new NotFoundError('Fant ikke personen.')
      if (JSON.stringify(before) === JSON.stringify(row.topics)) continue
      await tx.update(person).set({ searchTopics: row.topics }).where(eq(person.id, row.personId))
      await tx.insert(auditEvent).values({
        actorPersonId: viewer.personId,
        action: 'profile.search_topics',
        subjectPersonId: row.personId,
        details: { topics: row.topics, previous: before },
      })
      updated++
    }
    return { updated }
  })
}

/**
 * Det som står om personene, til å skrive søkeord: bitene fra søkeindeksen og
 * søkeordene som står nå. `missingOnly` gir dem uten søkeord. Bare admins.
 */
export async function listPeopleForTopics(
  db: Db,
  viewer: Viewer,
  {
    missingOnly = true,
    cohort: year,
    limit = 50,
    offset = 0,
  }: {
    missingOnly?: boolean
    cohort?: number
    limit?: number
    offset?: number
  } = {},
) {
  assertCan(viewer, 'profiles.edit')
  const [docs, topics, years, ai] = await Promise.all([
    buildSearchDocs(db, undefined, { withTopics: false }),
    db.select({ id: person.id, topics: person.searchTopics }).from(person),
    db
      .select({ personId: personCohort.personId, year: cohort.graduationYear })
      .from(personCohort)
      .innerJoin(cohort, eq(cohort.id, personCohort.cohortId)),
    db
      .select({ personId: personAiTopics.personId, topics: personAiTopics.topics })
      .from(personAiTopics),
  ])
  const aiOf = new Map(ai.map((t) => [t.personId, t.topics]))
  const topicsOf = new Map(topics.map((t) => [t.id, t.topics]))
  const yearsOf = new Map<string, number[]>()
  for (const y of years) yearsOf.set(y.personId, [...(yearsOf.get(y.personId) ?? []), y.year])
  const list = docs.filter(
    (d) =>
      d.chunks.some((c) => c.kind !== 'study') &&
      (!missingOnly || !(topicsOf.get(d.personId) ?? []).length) &&
      (year === undefined || (yearsOf.get(d.personId) ?? []).includes(year)),
  )
  return {
    total: list.length,
    items: list.slice(offset, offset + limit).map((d) => ({
      personId: d.personId,
      fullName: d.fullName,
      cohorts: yearsOf.get(d.personId) ?? [],
      currentTopics: topicsOf.get(d.personId) ?? [],
      aiTopics: aiOf.get(d.personId) ?? [],
      text: d.chunks.map((c) => c.text),
    })),
  }
}
