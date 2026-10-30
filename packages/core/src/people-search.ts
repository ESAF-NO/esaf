import { createHash } from 'node:crypto'
import { schema, type Db } from '@esaf/db'
import { asc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { assertCan, assertMember, can, type Viewer } from './access.ts'
import { DomainError, NotFoundError } from './errors.ts'
import type { Tx } from './members.ts'
import { normalizePersonName } from './people-admin.ts'
import { photoUrls, type ProfilePhoto } from './photos.ts'
import { SEARCH_TAXONOMY } from './search-taxonomy.ts'
import { tidyTag } from './validation.ts'

const {
  auditEvent,
  cohort,
  company,
  experience,
  membership,
  person,
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
 * - **Søkeord:** for det modellen ikke klarer alene, setter admins emner på
 *   norsk og engelsk, også bredere begreper: NASA → romfart, space, aerospace,
 *   satellitter (`person.search_topics`). Appen kaller aldri en språkmodell
 *   selv; søkeordene skrives utenfra, typisk av Claude Code eller Codex via
 *   MCP (`listPeopleForTopics`, `setSearchTopics`). Søket utvider ord med
 *   begrepslista i `search-taxonomy.ts`.
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
  chunks: SearchChunk[]
}

const sentences = (text: string) =>
  text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 12)

const firstSentence = (text: string | null) => (text ? (sentences(text)[0] ?? null) : null)

const YEAR_RANGE = /^\(?(?:19|20)\d{2}\s*-\s*(?:19|20)\d{2}\)?$/

/**
 * Fjerner e-postadresser og telefonnumre fra fritekst (noen bioer fra import har
 * dem), så søket aldri viser kontaktinfo personen har skjult på profilen.
 */
export function redact(text: string) {
  return text
    .replace(/[^\s<>(),;:"'[\]]+@[^\s<>(),;:"'[\]]+\.[a-z]{2,}/gi, '[e-post]')
    .replace(/(?:\+?\d[\d ().-]{6,}\d)/g, (m) =>
      // Årstall fra–til («2015-2019», «(2015 - 2019)») har også åtte sifre, men er ikke et nummer.
      m.replace(/\D/g, '').length >= 8 && !YEAR_RANGE.test(m) ? '[telefon]' : m,
    )
}

/**
 * Bitene for alle personer, eller noen. Rekkefølgen er fast, så hashen blir
 * stabil. `withTopics: false` gir teksten uten søkeord (det søkeordene skrives
 * fra).
 */
export async function buildSearchDocs(
  db: Db | Tx,
  personIds?: string[],
  { withTopics = true }: { withTopics?: boolean } = {},
): Promise<PersonDoc[]> {
  const where = personIds ? inArray(person.id, personIds) : undefined
  const [people, jobs] = await Promise.all([
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
  ])
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
    const own = withTopics ? p.searchTopics : []
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
 * `personIds` gjør det bare for dem (f.eks. de som nettopp fikk nye søkeord).
 * Ingen rettighetssjekk: kalles av serveren selv (bakgrunnsjobb og CLI).
 */
export async function reindexPeople(
  db: Db,
  embedder: Embedder,
  {
    limit = 200,
    batchSize = 32,
    personIds,
  }: { limit?: number; batchSize?: number; personIds?: string[] } = {},
): Promise<ReindexResult> {
  if (personIds && !personIds.length) return { indexed: 0, removed: 0, unchanged: 0, total: 0 }
  const [docs, existing] = await Promise.all([
    buildSearchDocs(db, personIds),
    db
      .select({
        personId: personSearchIndex.personId,
        contentHash: personSearchIndex.contentHash,
      })
      .from(personSearchIndex)
      .where(personIds ? inArray(personSearchIndex.personId, personIds) : undefined),
  ])
  const known = new Map(existing.map((r) => [r.personId, r.contentHash]))
  const stale = docs.filter(
    (d) => d.chunks.length > 0 && known.get(d.personId) !== hashDoc(d, embedder.model),
  )
  const empty = docs.filter((d) => d.chunks.length === 0 && known.has(d.personId))
  const present = new Set(docs.map((d) => d.personId))
  const gone = existing.filter((r) => !present.has(r.personId))
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
  /** `name`: navnet, `text`: ordene står i profilen, `meaning`: lik i mening. */
  matchedBy: 'name' | 'text' | 'meaning'
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
  { embedder, limit = 20 }: { embedder?: Embedder | null; limit?: number } = {},
): Promise<PeopleSearchHit[]> {
  assertMember(viewer)
  const q = query.trim().slice(0, 200)
  const nameTokens = norm(q).split(' ').filter(Boolean)
  if (!nameTokens.length) return []
  const terms = expandQuery(q)
  const everyone = can(viewer, 'profiles.edit')

  // Bygges på nytt for hvert søk (rundt 30 ms for 700 personer), så treffene
  // alltid følger hvem som er aktive og det som står på profilene nå.
  const docs = (await buildSearchDocs(db)).filter((d) => everyone || d.status === 'active')
  const visible = new Map(docs.map((d) => [d.personId, d]))

  // Navn: alle ordene i søket står i navnet.
  const byName = new Set(
    docs
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
  const queryTexts = !terms.length
    ? []
    : synonyms.length
      ? [q, `${q} (${synonyms.join(', ')})`, synonyms.join(', ')]
      : [q]
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
    for (const [personId, v] of vectors.byPerson) {
      if (!visible.has(personId) || v.dims !== queryVectors[0]!.length) continue
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
  const base = known ? MEANING_CUTOFF : MEANING_CUTOFF_UNKNOWN
  const cutoff = Math.min(base, Math.max(1, 0.6 * Math.sqrt(Math.max(personSims.length - 1, 1))))

  const scored: {
    id: string
    score: number
    matchedBy: PeopleSearchHit['matchedBy']
    reason: string | null
  }[] = []
  for (const d of docs) {
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
  const meaningMax = known ? MEANING_MAX : MEANING_MAX_UNKNOWN
  const ranked = scored
    .sort((a, b) => b.score - a.score)
    .filter((r) => r.matchedBy !== 'meaning' || ++meaningOnly <= meaningMax)
    .slice(0, Math.min(limit, 100))
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

/** Hashen av teksten søkeordene skrives fra (bitene uten søkeord). */
const topicsSource = (doc: PersonDoc) =>
  createHash('sha256')
    .update(JSON.stringify(doc.chunks.map((c) => c.text)))
    .digest('hex')

/** Om det står nok om personen til at søkeord gir mening (mer enn et navn og en studieretning). */
const worthTagging = (doc: PersonDoc) => doc.chunks.some((c) => c.kind !== 'study')

/**
 * Setter søkeordene til personer (erstatter dem). Bare admins med `profiles.edit`.
 * Husker hvilken profiltekst de ble skrevet fra, så personen kommer tilbake i
 * `listPeopleForTopics` når teksten endres. En tom liste betyr «vurdert, ingen
 * søkeord». Logges som `profile.search_topics`, én hendelse per person der
 * søkeordene endres.
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
  if (new Set(parsed.map((r) => r.personId)).size !== parsed.length)
    throw new DomainError('Samme person står flere ganger.')
  return db.transaction(async (tx) => {
    const ids = parsed.map((r) => r.personId)
    const current = await tx
      .select({ id: person.id, topics: person.searchTopics, source: person.searchTopicsSource })
      .from(person)
      .where(inArray(person.id, ids))
      .for('update')
    const byId = new Map(current.map((r) => [r.id, r]))
    const sources = new Map(
      (await buildSearchDocs(tx, ids, { withTopics: false })).map((d) => [
        d.personId,
        topicsSource(d),
      ]),
    )
    let updated = 0
    for (const row of parsed) {
      const before = byId.get(row.personId)
      if (!before) throw new NotFoundError('Fant ikke personen.')
      const source = sources.get(row.personId) ?? null
      const changed = JSON.stringify(before.topics) !== JSON.stringify(row.topics)
      if (!changed && before.source === source) continue
      await tx
        .update(person)
        .set({ searchTopics: row.topics, searchTopicsSource: source })
        .where(eq(person.id, row.personId))
      // Samme søkeord for ny tekst er bare en bekreftelse; den logges ikke.
      if (!changed) continue
      await tx.insert(auditEvent).values({
        actorPersonId: viewer.personId,
        action: 'profile.search_topics',
        subjectPersonId: row.personId,
        details: { topics: row.topics, previous: before.topics },
      })
      updated++
    }
    return { updated }
  })
}

/**
 * `missing`: aldri vurdert. `outdated`: profilteksten er endret siden
 * søkeordene ble skrevet. `done`: skrevet fra teksten som står nå.
 */
export type TopicsStatus = 'missing' | 'outdated' | 'done'

/**
 * Det som står om personene, til å skrive søkeord: bitene fra søkeindeksen og
 * søkeordene som står nå. `status: 'todo'` (standard) gir dem som mangler
 * søkeord eller har utdaterte. Personer uten noe å gå på (bare navn og
 * studieretning) er ikke med. Bare admins.
 */
export async function listPeopleForTopics(
  db: Db,
  viewer: Viewer,
  {
    status = 'todo',
    cohort: year,
    limit = 50,
    offset = 0,
  }: {
    status?: TopicsStatus | 'todo' | 'all'
    cohort?: number
    limit?: number
    offset?: number
  } = {},
) {
  assertCan(viewer, 'profiles.edit')
  const [docs, saved, years] = await Promise.all([
    buildSearchDocs(db, undefined, { withTopics: false }),
    db
      .select({ id: person.id, topics: person.searchTopics, source: person.searchTopicsSource })
      .from(person),
    db
      .select({ personId: personCohort.personId, year: cohort.graduationYear })
      .from(personCohort)
      .innerJoin(cohort, eq(cohort.id, personCohort.cohortId)),
  ])
  const savedOf = new Map(saved.map((t) => [t.id, t]))
  const yearsOf = new Map<string, number[]>()
  for (const y of years) yearsOf.set(y.personId, [...(yearsOf.get(y.personId) ?? []), y.year])
  const statusOf = (d: PersonDoc): TopicsStatus => {
    const own = savedOf.get(d.personId)
    if (!own?.source) return own?.topics.length ? 'outdated' : 'missing'
    return own.source === topicsSource(d) ? 'done' : 'outdated'
  }
  const rows = docs
    .filter(
      (d) =>
        worthTagging(d) && (year === undefined || (yearsOf.get(d.personId) ?? []).includes(year)),
    )
    .map((d) => ({ doc: d, status: statusOf(d) }))
  const counts = { missing: 0, outdated: 0, done: 0 }
  for (const r of rows) counts[r.status]++
  const list = rows.filter((r) =>
    status === 'all' ? true : status === 'todo' ? r.status !== 'done' : r.status === status,
  )
  return {
    total: list.length,
    counts,
    items: list.slice(offset, offset + limit).map(({ doc: d, status }) => ({
      personId: d.personId,
      fullName: d.fullName,
      cohorts: yearsOf.get(d.personId) ?? [],
      status,
      currentTopics: savedOf.get(d.personId)?.topics ?? [],
      text: d.chunks.map((c) => c.text),
    })),
  }
}
