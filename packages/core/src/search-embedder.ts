import { readFileSync } from 'node:fs'
import { totalmem } from 'node:os'
import type { Embedder } from './people-search.ts'

/**
 * Embedding-modellen for personsøket, lokalt i Node (ONNX via
 * @huggingface/transformers). Ingenting om medlemmene sendes til en
 * tredjepart.
 *
 * Standard er BGE-M3: målt mot ekte profiler var den klart best av de lokale
 * modellene vi prøvde (multilingual-e5-small og -base, EmbeddingGemma), særlig
 * på norske søk mot engelske bioer. Den er stor (ca. 560 MB på disk, ca. 1,5 GB
 * minne når den er lastet), så den lastes først når noen søker eller en profil
 * er endret, og slippes igjen etter `idleMs` uten bruk. Et søk tar da rundt 10 ms
 * (pluss under ett sekund første gang etter en pause). På en server med lite
 * minne brukes `SEARCH_MODEL_SMALL` (multilingual-e5-small, 120 MB) i stedet
 * (se `chooseSearchModel`); søket sammenligner treff innenfor hvert søk, så det
 * trenger ingen ny innstilling.
 *
 * Modellen lastes ned første gang til `cacheDir`; i produksjon gjøres det når
 * bildet bygges (`pnpm search:download-model`, begge modellene), så serveren
 * aldri trenger nett.
 */
export const SEARCH_MODEL = 'Xenova/bge-m3'
export const SEARCH_MODEL_SMALL = 'Xenova/multilingual-e5-small'

/** Under så mye minne velges den lille modellen, med mindre `SEARCH_MODEL` er satt. */
export const SEARCH_MODEL_MIN_MEMORY = 3 * 1024 ** 3

/**
 * Minnet appen har: det maskinen har, eller grensen for containeren hvis den
 * er lavere (cgroup v2 og v1).
 */
export function availableMemory() {
  let limit = totalmem()
  for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const value = Number(readFileSync(file, 'utf8').trim())
      if (Number.isFinite(value) && value > 0) limit = Math.min(limit, value)
    } catch {
      // Ikke i en container, eller en annen cgroup-versjon.
    }
  }
  return limit
}

/**
 * Modellen som skal brukes: `SEARCH_MODEL` hvis den er satt, ellers BGE-M3, og
 * den lille modellen når serveren har mindre enn `SEARCH_MODEL_MIN_MEMORY`. BGE-M3
 * bruker rundt 1,5 GB når den er lastet, og ved siden av appen og Postgres kunne
 * den ellers tatt alt minnet på en liten server.
 */
export function chooseSearchModel(configured: string | undefined, memory: number) {
  if (configured) return configured
  return memory < SEARCH_MODEL_MIN_MEMORY ? SEARCH_MODEL_SMALL : SEARCH_MODEL
}

/** Hvordan hver modell skal brukes: pooling og prefikser den er trent med. */
const PROFILES: Record<string, { pooling: 'cls' | 'mean'; query: string; passage: string }> = {
  'Xenova/bge-m3': { pooling: 'cls', query: '', passage: '' },
  'Xenova/multilingual-e5-small': { pooling: 'mean', query: 'query: ', passage: 'passage: ' },
  'Xenova/multilingual-e5-base': { pooling: 'mean', query: 'query: ', passage: 'passage: ' },
}

type Extractor = ((
  texts: string[],
  options: { pooling: 'cls' | 'mean'; normalize: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>) & { dispose?: () => Promise<void> }

export function createLocalEmbedder({
  cacheDir,
  model = process.env.SEARCH_MODEL || SEARCH_MODEL,
  allowDownload = true,
  idleMs = 10 * 60_000,
}: {
  cacheDir: string
  model?: string
  /** `false` i produksjon: modellen skal ligge i bildet. */
  allowDownload?: boolean
  /** Slipper modellen (og minnet) etter så lang tid uten bruk. 0: aldri. */
  idleMs?: number
}): Embedder & { ready(): Promise<void>; unload(): Promise<void> } {
  const profile = PROFILES[model] ?? { pooling: 'mean' as const, query: '', passage: '' }
  let loading: Promise<Extractor> | null = null
  let idle: ReturnType<typeof setTimeout> | null = null
  let active = 0

  const unload = async () => {
    const current = loading
    loading = null
    if (current) await (await current.catch(() => null))?.dispose?.()
  }
  const touch = () => {
    if (!idleMs) return
    if (idle) clearTimeout(idle)
    idle = setTimeout(() => {
      if (active === 0) void unload()
    }, idleMs)
    idle.unref?.()
  }
  const load = () =>
    (loading ??= (async () => {
      const transformers = await import('@huggingface/transformers')
      transformers.env.cacheDir = cacheDir
      transformers.env.allowRemoteModels = allowDownload
      transformers.env.allowLocalModels = true
      const extractor = await transformers.pipeline('feature-extraction', model, { dtype: 'q8' })
      return extractor as unknown as Extractor
    })().catch((error) => {
      // Neste forsøk kan lykkes (f.eks. nettet var nede under nedlasting).
      loading = null
      throw error
    }))

  return {
    model,
    ready: async () => {
      await load()
      touch()
    },
    unload,
    async embed(texts, as) {
      if (!texts.length) return []
      active++
      try {
        const extractor = await load()
        const prefix = as === 'query' ? profile.query : profile.passage
        const result: Float32Array[] = []
        for (let i = 0; i < texts.length; i += 32) {
          const out = await extractor(
            texts.slice(i, i + 32).map((t) => prefix + t.slice(0, 1000)),
            { pooling: profile.pooling, normalize: true },
          )
          const dims = out.dims[1]!
          for (let r = 0; r < out.dims[0]!; r++) {
            result.push(out.data.slice(r * dims, (r + 1) * dims))
          }
        }
        return result
      } finally {
        active--
        touch()
      }
    },
  }
}

/** `SEARCH_MODEL_DIR`, ellers `.data/models` i roten av repoet (gitignorert). */
export function defaultSearchModelDir() {
  return (
    process.env.SEARCH_MODEL_DIR ||
    new URL('../../../.data/models', import.meta.url).pathname.replace(/\/$/, '')
  )
}
