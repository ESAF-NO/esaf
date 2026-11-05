import { randomBytes } from 'node:crypto'
import sharp, { type Metadata } from 'sharp'
import { DomainError } from './errors.ts'
import type { ObjectStorage } from './storage.ts'

/**
 * Det profilbilder og logoer har felles: hvilke filer som slippes inn i
 * bildebiblioteket, nøklene og opprydding i lagringen.
 */

/** Største fil som tas imot. Appen sjekker det også før opplastingen leses inn. */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024
export const IMAGE_CONTENT_TYPE = 'image/webp'

/**
 * Vern mot «dekompresjonsbomber» (små filer som utgir seg for å være enorme
 * bilder). Godt over det kameraer lager innenfor 10 MB.
 */
export const MAX_PIXELS = 100_000_000

/**
 * Grensen for animasjoner, summert over alle bildene. Hele animasjonen behandles på
 * én gang, og bildekøen venter imens. Vanlige GIF-er (480×270 og 200 bilder) er 26
 * millioner og tar om lag ett sekund.
 */
export const MAX_ANIMATED_PIXELS = 30_000_000

// Bildebiblioteket brukes bare til opplastede bilder. Bare dekoderne for JPEG, PNG,
// WebP og GIF er slått på, så formater med større angrepsflate (SVG, PDF, TIFF, HEIF …)
// aldri blir tolket, selv om en fil skulle slippe forbi sjekken av filtypen.
// Gjelder hele prosessen.
sharp.block({ operation: ['VipsForeignLoad'] })
sharp.unblock({
  operation: [
    'VipsForeignLoadJpegBuffer',
    'VipsForeignLoadPngBuffer',
    'VipsForeignLoadWebpBuffer',
    'VipsForeignLoadNsgifBuffer',
  ],
})
// Cachen hjelper bare når samme bilde behandles flere ganger. Her holder den bare på minne.
sharp.cache(false)

/** Filnavnet i adressene: nøkkelen, størrelsen og `.webp`. */
export const IMAGE_FILE_NAME = /^([A-Za-z0-9_-]{22})-(\d{1,4})\.webp$/

/** 128 tilfeldige bit: kan ikke gjettes, og blir aldri gjenbrukt. */
export const newImageKey = () => randomBytes(16).toString('base64url')

export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'gif'

/**
 * Filtypen ut fra de første bytene i fila. Avgjør hva som slippes videre til
 * bildebiblioteket, så SVG, PDF og andre formater aldri blir tolket.
 */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to))
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (ascii(0, 8) === '\x89PNG\r\n\x1a\n') return 'png'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp'
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'gif'
  return null
}

export const unreadable = () =>
  new DomainError('Vi klarte ikke å lese bildet. Prøv et annet bilde i JPEG, PNG eller WebP.')

/** Innstillingene for å lese en opplastet fil. */
export const readOptions = {
  // Avbryt ved alt som ser feil ut i pikseldataene; anbefalt for filer fra brukere.
  failOn: 'warning',
  limitInputPixels: MAX_PIXELS,
  // Roter etter EXIF-orienteringen, så bilder tatt på høykant står riktig.
  autoOrient: true,
} as const

/**
 * Innstillingene for å lese en animasjon. GIF-er fra nettet har ofte små feil som
 * ikke synes, så bare det som ikke kan leses, stopper. Animasjoner har ingen EXIF.
 */
export const animatedReadOptions = {
  animated: true,
  failOn: 'error',
  limitInputPixels: MAX_ANIMATED_PIXELS,
} as const

/**
 * Sjekker en opplastet fil og gir bredden og høyden slik bildet står, og hvor
 * mange bilder den har. Kaster `DomainError` med en melding brukeren kan lese hvis
 * fila ikke kan brukes. `maxBytes` er grensen for profilbilder og logoer, med
 * mindre en annen gis. GIF slippes bare inn med `animation`: et profilbilde eller
 * en logo står stille.
 */
export async function inspectUpload(
  file: Uint8Array,
  maxBytes = IMAGE_MAX_BYTES,
  { animation = false } = {},
): Promise<{ width: number; height: number; frames: number }> {
  if (file.byteLength === 0) throw new DomainError('Fila er tom.')
  if (file.byteLength > maxBytes) {
    throw new DomainError(`Bildet er for stort. Maks ${Math.round(maxBytes / 1024 / 1024)} MB.`)
  }
  const format = sniffImageFormat(file)
  if (!format || (format === 'gif' && !animation)) {
    throw new DomainError('Bildet må være JPEG, PNG eller WebP.')
  }

  let metadata: Metadata
  try {
    // Leser bare headeren. Antall piksler sjekkes under, med en tydeligere melding.
    metadata = await sharp(file, { ...readOptions, limitInputPixels: false }).metadata()
  } catch {
    throw unreadable()
  }
  if (metadata.format !== format) throw unreadable()
  const { width, height } = metadata.autoOrient
  if (width * height > MAX_PIXELS) throw new DomainError('Bildet har for mange piksler.')
  const frames = animation ? (metadata.pages ?? 1) : 1
  if (frames > 1 && width * height * frames > MAX_ANIMATED_PIXELS) {
    throw new DomainError('Animasjonen er for stor. Velg en som er kortere eller mindre.')
  }
  return { width, height, frames }
}

let queue: Promise<unknown> = Promise.resolve()

/**
 * Kjører bildebehandlingen ett bilde om gangen i prosessen. Et stort bilde kan
 * bruke et par hundre MB mens det dekodes (målt: rundt 230 MB for 100 megapiksler
 * i PNG med rotasjon, 110 MB for 48 megapiksler i JPEG); flere samtidig kunne
 * tømt minnet på en liten server. libvips bruker uansett alle kjernene på hvert
 * bilde, så det går ikke tregere totalt.
 */
export function oneImageAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work)
  // Køen går videre også når et bilde feiler.
  queue = run.catch(() => {})
  return run
}

/**
 * Lagrer alle filene til ett bilde (eller et dokument). Feiler én, ryddes det
 * opp først når alle er ferdige; ellers kunne en fil som ennå var under
 * skriving, blitt liggende igjen. Uten `contentType` er fila WebP.
 */
export async function putImageFiles(
  storage: ObjectStorage,
  files: { key: string; body: Uint8Array; contentType?: string }[],
  label: string,
) {
  const saved = await Promise.allSettled(
    files.map((f) => storage.put(f.key, f.body, f.contentType ?? IMAGE_CONTENT_TYPE)),
  )
  const failed = saved.find((r) => r.status === 'rejected')
  if (failed) {
    await deleteImageFiles(
      storage,
      files.map((f) => f.key),
      label,
    )
    throw failed.reason
  }
}

/** Sletter filene. En feil her skal ikke stoppe brukeren, men må synes i loggen. */
export async function deleteImageFiles(storage: ObjectStorage, keys: string[], label: string) {
  const results = await Promise.allSettled(keys.map((key) => storage.delete(key)))
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error(`[esaf/core] Kunne ikke slette ${label}:`, result.reason)
    }
  }
}
