import { fileURLToPath } from 'node:url'
import {
  createClaudeSearchAi,
  createLocalEmbedder,
  refreshAiTopics,
  reindexPeople,
  type Embedder,
  type SearchAi,
} from '@esaf/core'
import { db } from './db.server.ts'
import { env } from './env.server.ts'

/**
 * Personsøket på serveren: embedding-modellen (lokal, se `search-embedder.ts`
 * i @esaf/core) og en bakgrunnsjobb som holder søkeindeksen oppdatert. Jobben
 * går hvert minutt og embedder bare personer der teksten er endret, så den
 * koster nesten ingenting når ingenting skjer. I produksjon ligger modellen i
 * bildet (`SEARCH_MODEL_DIR`); den lastes aldri ned mens appen kjører.
 *
 * Med `ANTHROPIC_API_KEY` skriver Claude også søkeord for profiler som er nye
 * eller endret (før de embeddes), og tolker søk (se `search-ai.ts` i @esaf/core).
 */

const production = env.NODE_ENV === 'production'
const cacheDir =
  env.SEARCH_MODEL_DIR ?? fileURLToPath(new URL('../../../../.data/models', import.meta.url))

const globalForSearch = globalThis as unknown as {
  esafEmbedder?: Embedder & { ready(): Promise<void> }
  esafSearchTimer?: ReturnType<typeof setInterval>
  esafSearchAi?: SearchAi | null
}

export const embedder = (globalForSearch.esafEmbedder ??= createLocalEmbedder({
  cacheDir,
  model: env.SEARCH_MODEL,
  allowDownload: !production,
}))

/** Claude i søket, eller `null` uten `ANTHROPIC_API_KEY`. */
export const searchAi: SearchAi | null = (globalForSearch.esafSearchAi ??= env.ANTHROPIC_API_KEY
  ? createClaudeSearchAi({ apiKey: env.ANTHROPIC_API_KEY, model: env.SEARCH_AI_MODEL })
  : null)

let running = false
let warned = false
let aiWarned = false

/**
 * Én runde: søkeord fra Claude for høyst 40 personer, så søkeindeksen for høyst
 * 100. Er det mer igjen, kommer neste runde med en gang i stedet for om et minutt.
 */
export async function refreshSearchIndex() {
  if (running) return
  running = true
  let more = false
  try {
    if (searchAi) {
      try {
        const topics = await refreshAiTopics(db, searchAi, { limit: 40 })
        if (topics.tagged) {
          console.info(
            `[esaf/search] Claude skrev søkeord for ${topics.tagged} personer (${topics.pending} igjen).`,
          )
        }
        more ||= topics.pending > 0
        aiWarned = false
      } catch (error) {
        // Indeksen oppdateres uansett; søkeordene prøves igjen neste runde.
        if (!aiWarned) console.error('[esaf/search] Kunne ikke lage søkeord med Claude:', error)
        aiWarned = true
      }
    }
    const result = await reindexPeople(db, embedder, { limit: 100 })
    if (result.indexed) console.info(`[esaf/search] Indekserte ${result.indexed} personer.`)
    more ||= result.indexed === 100
    warned = false
  } catch (error) {
    if (!warned) console.error('[esaf/search] Kunne ikke oppdatere søkeindeksen:', error)
    warned = true
  } finally {
    running = false
  }
  if (more) setTimeout(() => void refreshSearchIndex(), 1000)
}

export function startSearchIndexing() {
  if (globalForSearch.esafSearchTimer) return
  globalForSearch.esafSearchTimer = setInterval(() => void refreshSearchIndex(), 60_000)
  globalForSearch.esafSearchTimer.unref?.()
  setTimeout(() => void refreshSearchIndex(), 5_000)
}
