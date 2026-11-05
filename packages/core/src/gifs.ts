import { schema, type Db } from '@esaf/db'
import { and, desc, eq, ilike, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { assertMember, type Viewer } from './access.ts'
import {
  ASSET_IMAGE_SIZES,
  ASSET_MAX_BYTES,
  assertUploadQuota,
  uploadAsset,
  type AssetView,
} from './assets.ts'
import { DomainError } from './errors.ts'
import type { ObjectStorage } from './storage.ts'

/**
 * GIF-søket i skrivefeltet, med GIPHY. Reglene:
 *
 * - Søket går gjennom serveren, så GIPHY ser serveren og ikke medlemmene. Bare
 *   den som har velgeren åpen, henter forhåndsvisninger fra GIPHY selv.
 * - En valgt GIF hentes av serveren og blir et vanlig vedlegg (`uploadAsset`):
 *   samme behandling, grenser og moderering som andre bilder, og ingen som leser
 *   innlegget, henter noe fra GIPHY. Den forsvinner heller ikke om GIPHY fjerner den.
 * - Nettleseren sender bare id-en, aldri en adresse, så serveren kan ikke brukes
 *   til å hente noe annet enn filer fra GIPHY.
 * - Bare GIF-er med aldersgrense opp til `RATING` kan søkes opp og velges.
 * - Nøkkelen har en grense på antall kall. Svar mellomlagres, å velge en GIF fra
 *   et søk koster ingen kall, og hver person kan søke et begrenset antall ganger
 *   i minuttet.
 * - Når grensen er nådd eller GIPHY ikke svarer, spørres ikke GIPHY på en stund.
 *   Da gis gamle svar på samme søk, ellers GIF-er som allerede er brukt på ESAF
 *   (`findGifs`). De ligger hos oss, så de virker uansett.
 * - En GIF en moderator har fjernet, kan ikke velges fra de lagrede (`forgetGifs`).
 */

const { asset } = schema

const API = 'https://api.giphy.com/v1/gifs'
const RATING = 'pg'
const ALLOWED_RATINGS = new Set(['y', 'g', 'pg'])
const PAGE_SIZE = 24
const MAX_OFFSET = 240
const MAX_QUERY = 50
const CACHE_ENTRIES = 300
const CACHE_MS = 10 * 60_000
const TRENDING_CACHE_MS = 60 * 60_000
/** Gamle svar brukes når GIPHY ikke svarer, så lenge de er yngre enn dette. */
const STALE_MS = 24 * 60 * 60_000
const KNOWN_GIFS = 2_000
/** Så lenge GIPHY får være i fred etter at grensen er nådd, eller etter en feil. */
const LIMIT_PAUSE_MS = 5 * 60_000
const ERROR_PAUSE_MS = 60_000
const SEARCHES_PER_MINUTE = 30
const API_TIMEOUT_MS = 5_000
const DOWNLOAD_TIMEOUT_MS = 15_000

/** Filene ligger her. Alt annet i et svar blir sett bort fra. */
const GIF_HOST = /^(media\d*|i)\.giphy\.com$/

const giphyFile = (url: unknown) => {
  try {
    const parsed = new URL(String(url))
    return parsed.protocol === 'https:' && GIF_HOST.test(parsed.hostname) ? parsed.href : null
  } catch {
    return null
  }
}

const rendition = z.object({
  url: z.string().optional(),
  webp: z.string().optional(),
  width: z.coerce.number().optional(),
  height: z.coerce.number().optional(),
})

const giphyGif = z.object({
  id: z.string(),
  title: z.string().nullish(),
  rating: z.string().nullish(),
  images: z.object({
    fixed_width: rendition.optional(),
    downsized_medium: rendition.optional(),
    downsized: rendition.optional(),
    original: rendition.optional(),
  }),
})
type GiphyGif = z.infer<typeof giphyGif>

const listResponse = z.object({
  data: z.array(giphyGif),
  pagination: z.object({ total_count: z.number().optional(), count: z.number() }).optional(),
})
const singleResponse = z.object({ data: giphyGif })

/** En GIF i velgeren. Forhåndsvisningen ligger hos GIPHY. */
export type GifResult = {
  id: string
  title: string
  preview: { url: string; width: number; height: number }
}

export type GifPage = {
  results: GifResult[]
  nextOffset: number | null
  /** GIPHY svarer ikke, så dette er GIF-er som er lagret hos oss. */
  stored: boolean
}

/** Prefikset på GIF-er som velges fra dem som er lagret hos oss. */
const STORED = 'lagret:'

/** GIPHY kan ikke brukes akkurat nå. `findGifs` går da til dem som er lagret. */
export class GifsUnavailableError extends DomainError {
  constructor() {
    super('GIF-søket svarer ikke akkurat nå. Prøv igjen om litt, eller last opp en GIF.')
    this.name = 'GifsUnavailableError'
  }
}

export type GifSearch = {
  /** Uten søkeord: det som er populært nå. */
  search(viewer: Viewer, query: string, offset?: number): Promise<GifPage>
  /** Selve fila og tittelen. */
  download(id: string): Promise<{ bytes: Uint8Array; title: string }>
}

const unavailable = () => new GifsUnavailableError()

function toResult(gif: GiphyGif): GifResult | null {
  const preview = gif.images.fixed_width
  const url = giphyFile(preview?.webp ?? preview?.url)
  if (!url || !preview?.width || !preview.height) return null
  if (!ALLOWED_RATINGS.has(gif.rating ?? '')) return null
  return {
    id: gif.id,
    title: gif.title?.trim() || 'GIF',
    preview: { url, width: preview.width, height: preview.height },
  }
}

/** Fila som lagres: en mellomstor utgave, som holder for visningen hos oss. */
function fileOf(gif: GiphyGif) {
  const { downsized_medium: medium, downsized, original } = gif.images
  return giphyFile(medium?.url ?? downsized?.url ?? original?.url)
}

/** Leser svaret, men aldri mer enn `max` byte, selv om det utgir seg for å være mindre. */
async function readLimited(response: Response, max: number): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length') ?? 0) > max) throw unavailable()
  const reader = response.body?.getReader()
  if (!reader) throw unavailable()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      throw new DomainError('GIF-en er for stor. Velg en annen.')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

export function createGifSearch(
  apiKey: string,
  { fetch: request = fetch, now = Date.now }: { fetch?: typeof fetch; now?: () => number } = {},
): GifSearch {
  const cache = new Map<string, { at: number; page: GifPage }>()
  const recent = new Map<string, number[]>()
  /** Filene til GIF-ene i søkene, så det ikke koster et kall å velge en av dem. */
  const known = new Map<string, { url: string; title: string }>()
  let pausedUntil = 0

  function remember(gif: GiphyGif) {
    const url = fileOf(gif)
    if (!url || !ALLOWED_RATINGS.has(gif.rating ?? '')) return
    known.delete(gif.id)
    known.set(gif.id, { url, title: gif.title?.trim() || 'GIF' })
    if (known.size > KNOWN_GIFS) known.delete(known.keys().next().value!)
  }

  /** Nøkkelen står i adressen, så feil logges uten den. */
  async function call(path: string, params: Record<string, string>): Promise<unknown> {
    if (now() < pausedUntil) throw unavailable()
    const url = new URL(`${API}${path}`)
    url.search = new URLSearchParams({ api_key: apiKey, ...params }).toString()
    let response: Response
    try {
      response = await request(url, { signal: AbortSignal.timeout(API_TIMEOUT_MS) })
    } catch {
      console.error('[esaf/core] GIPHY svarte ikke.')
      pausedUntil = now() + ERROR_PAUSE_MS
      throw unavailable()
    }
    if (response.status === 404) throw new DomainError('Fant ikke GIF-en.')
    if (!response.ok) {
      console.error(`[esaf/core] GIPHY svarte ${response.status}.`)
      pausedUntil = now() + (response.status === 429 ? LIMIT_PAUSE_MS : ERROR_PAUSE_MS)
      throw unavailable()
    }
    return response.json().catch(() => {
      throw unavailable()
    })
  }

  function assertBudget(personId: string) {
    const since = now() - 60_000
    const calls = (recent.get(personId) ?? []).filter((at) => at > since)
    if (calls.length >= SEARCHES_PER_MINUTE) {
      throw new DomainError('Du søker veldig raskt. Vent litt og prøv igjen.')
    }
    recent.set(personId, [...calls, now()])
    if (recent.size > 1000) {
      for (const [id, list] of recent) if (!list.some((at) => at > since)) recent.delete(id)
    }
  }

  return {
    async search(viewer, query, offset = 0) {
      assertMember(viewer)
      const q = query.trim().toLowerCase().slice(0, MAX_QUERY)
      const start = Math.min(Math.max(Math.trunc(offset), 0), MAX_OFFSET)
      const key = `${q}:${start}`
      const hit = cache.get(key)
      if (hit && now() - hit.at < (q ? CACHE_MS : TRENDING_CACHE_MS)) return hit.page

      assertBudget(viewer.personId)
      const params = { limit: String(PAGE_SIZE), offset: String(start), rating: RATING }
      let body: unknown
      try {
        body = await call(q ? '/search' : '/trending', q ? { ...params, q, lang: 'no' } : params)
      } catch (error) {
        if (error instanceof GifsUnavailableError && hit && now() - hit.at < STALE_MS) {
          return hit.page
        }
        throw error
      }
      const parsed = listResponse.safeParse(body)
      if (!parsed.success) throw unavailable()
      const { data, pagination } = parsed.data
      data.forEach(remember)
      const next = start + data.length
      const total = pagination?.total_count ?? 0
      const page: GifPage = {
        results: data.flatMap((gif) => toResult(gif) ?? []),
        nextOffset: data.length === PAGE_SIZE && next < total && next <= MAX_OFFSET ? next : null,
        stored: false,
      }
      cache.delete(key)
      cache.set(key, { at: now(), page })
      if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!)
      return page
    },

    async download(id) {
      if (!/^[A-Za-z0-9]{1,64}$/.test(id)) throw new DomainError('Fant ikke GIF-en.')
      let gif = known.get(id)
      if (!gif) {
        const parsed = singleResponse.safeParse(await call(`/${id}`, {}))
        if (!parsed.success) throw new DomainError('Fant ikke GIF-en.')
        // Id-en kommer fra nettleseren, så aldersgrensen sjekkes her også.
        if (!ALLOWED_RATINGS.has(parsed.data.data.rating ?? '')) {
          throw new DomainError('Fant ikke GIF-en.')
        }
        const url = fileOf(parsed.data.data)
        if (!url) throw unavailable()
        gif = { url, title: parsed.data.data.title?.trim() || 'GIF' }
      }
      let response: Response
      try {
        // Ingen omdirigeringer: adressen er sjekket, det de eventuelt peker på, er ikke.
        response = await request(gif.url, {
          redirect: 'error',
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        })
      } catch {
        throw unavailable()
      }
      if (!response.ok) throw unavailable()
      return { bytes: await readLimited(response, ASSET_MAX_BYTES), title: gif.title }
    },
  }
}

/**
 * GIF-er som er brukt på ESAF, sist brukt først. Bare de som står i et innlegg
 * eller en kommentar som finnes: det som slettes, forsvinner også herfra.
 */
export async function listStoredGifs(
  db: Db,
  viewer: Viewer,
  query: string,
  offset = 0,
): Promise<GifPage> {
  assertMember(viewer)
  const q = query.trim().slice(0, MAX_QUERY)
  const conditions: SQL[] = [
    isNotNull(asset.gifId),
    isNotNull(asset.attachedAt),
    isNull(asset.deletedAt),
  ]
  if (q) conditions.push(ilike(asset.gifTitle, `%${q.replace(/[%_\\]/g, '\\$&')}%`))
  const latest = sql<string>`(array_agg(${asset.id} order by ${asset.createdAt} desc))[1]`
  const groups = await db
    .select({ id: latest })
    .from(asset)
    .where(and(...conditions))
    .groupBy(asset.gifId)
    .orderBy(desc(sql`max(${asset.createdAt})`))
    .limit(PAGE_SIZE + 1)
    .offset(offset)
  const ids = groups.slice(0, PAGE_SIZE).map((g) => g.id)
  const rows = ids.length ? await db.select().from(asset).where(inArray(asset.id, ids)) : []
  const results = ids.flatMap((id) => {
    const row = rows.find((r) => r.id === id)
    if (!row?.gifId) return []
    return {
      id: `${STORED}${row.gifId}`,
      title: row.gifTitle ?? 'GIF',
      preview: {
        url: `/api/vedlegg/${row.fileKey}-${ASSET_IMAGE_SIZES.small}.webp`,
        width: row.width ?? 200,
        height: row.height ?? 200,
      },
    }
  })
  return {
    results,
    nextOffset: groups.length > PAGE_SIZE ? offset + PAGE_SIZE : null,
    stored: true,
  }
}

/** Søket i velgeren: GIPHY, eller det som er lagret hos oss når GIPHY ikke kan brukes. */
export async function findGifs(
  db: Db,
  viewer: Viewer,
  gifs: GifSearch,
  query: string,
  offset = 0,
): Promise<GifPage> {
  try {
    return await gifs.search(viewer, query, offset)
  } catch (error) {
    if (!(error instanceof GifsUnavailableError)) throw error
    return listStoredGifs(db, viewer, query, offset)
  }
}

/** Den nyeste kopien av en GIF, med fila, hvis den fortsatt kan brukes. */
async function storedGif(db: Db, storage: ObjectStorage, gifId: string) {
  const [row] = await db
    .select({ title: asset.gifTitle, keys: asset.storageKeys })
    .from(asset)
    .where(and(eq(asset.gifId, gifId), isNotNull(asset.attachedAt), isNull(asset.deletedAt)))
    .orderBy(desc(asset.createdAt))
    .limit(1)
  const key = row?.keys[String(ASSET_IMAGE_SIZES.large)]
  const bytes = key ? await storage.get(key) : null
  return bytes ? { bytes, title: row!.title ?? 'GIF' } : null
}

/**
 * Lagrer en GIF fra velgeren som et vedlegg som ikke er festet ennå, som om den
 * var lastet opp. Den teller med i grensene for opplasting. Finnes den hos oss
 * fra før, brukes den kopien, så GIPHY ikke trengs.
 */
export async function importGif(
  db: Db,
  storage: ObjectStorage,
  viewer: Viewer,
  gifs: GifSearch,
  id: string,
  purpose: 'post' | 'comment',
): Promise<AssetView> {
  // Før nedlastingen, så en full kvote ikke koster noe.
  await assertUploadQuota(db, viewer, 0)
  const fromStorage = id.startsWith(STORED)
  const gifId = fromStorage ? id.slice(STORED.length) : id
  const stored = await storedGif(db, storage, gifId)
  if (!stored && fromStorage) throw new DomainError('GIF-en finnes ikke lenger. Velg en annen.')
  const { bytes, title } = stored ?? (await gifs.download(gifId))
  return uploadAsset(db, storage, viewer, { purpose }, bytes, `${title}.gif`, {
    id: gifId,
    title: title.slice(0, 200),
  })
}
