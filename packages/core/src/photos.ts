import { randomBytes } from 'node:crypto'
import { schema, type Db } from '@esaf/db'
import { eq } from 'drizzle-orm'
import sharp, { type Metadata } from 'sharp'
import { assertCan, assertMember, type Viewer } from './access.ts'
import { DomainError, NotFoundError } from './errors.ts'
import type { Tx } from './members.ts'
import type { ObjectStorage } from './storage.ts'

const { auditEvent, membership, person } = schema

/**
 * Profilbilder. Reglene:
 *
 * - Eieren kan laste opp, bytte og fjerne sitt eget bilde. Med `profiles.edit`
 *   kan en admin gjøre det for aktive medlemmer og profiler fra kullisten; det
 *   logges. Admins kan fjerne bildet til hvem som helst, så upassende bilder kan
 *   tas bort.
 * - Alt behandles på serveren før det lagres: rotert etter EXIF, ALL metadata
 *   fjernet (også GPS), beskåret til kvadrat fra midten, skalert ned og lagret
 *   som WebP i to størrelser. Det som ikke kan leses som JPEG, PNG eller WebP,
 *   avvises, uansett filnavn eller hva nettleseren sier filtypen er.
 * - Hvert bilde får en ny tilfeldig nøkkel, og det gamle slettes når det byttes
 *   eller fjernes. Bildene serveres bare til aktive medlemmer, og bare så lenge
 *   nøkkelen står på en person.
 */

/** Største fil som tas imot. Appen sjekker det også før opplastingen leses inn. */
export const PHOTO_MAX_BYTES = 10 * 1024 * 1024
/** Bildene lagres i to størrelser: stor til profilsiden, liten til lister. */
export const PHOTO_SIZES = { small: 192, large: 512 } as const
export const PHOTO_CONTENT_TYPE = 'image/webp'

type PhotoSize = keyof typeof PHOTO_SIZES
const sizes = Object.keys(PHOTO_SIZES) as PhotoSize[]

/** Mindre enn dette blir uskarpt selv som liten avatar. */
const MIN_SIDE = 128
/**
 * Vern mot «dekompresjonsbomber» (små filer som utgir seg for å være enorme
 * bilder). Godt over det kameraer lager innenfor 10 MB.
 */
const MAX_PIXELS = 100_000_000

// Bildebiblioteket brukes bare til profilbilder. Bare dekoderne for JPEG, PNG og
// WebP er slått på, så formater med større angrepsflate (SVG, PDF, TIFF, HEIF …)
// aldri blir tolket, selv om en fil skulle slippe forbi sjekken av filtypen.
// Gjelder hele prosessen.
sharp.block({ operation: ['VipsForeignLoad'] })
sharp.unblock({
  operation: ['VipsForeignLoadJpegBuffer', 'VipsForeignLoadPngBuffer', 'VipsForeignLoadWebpBuffer'],
})
// Cachen hjelper bare når samme bilde behandles flere ganger. Her holder den bare på minne.
sharp.cache(false)

/** Adressene til et profilbilde. Bildene serveres bare til aktive medlemmer. */
export type ProfilePhoto = {
  /** 192 × 192, til lister og små avatarer. */
  small: string
  /** 512 × 512 (eller originalen, hvis den var mindre), til profilsiden. */
  large: string
}

/** Ruten i appen som serverer bildene: apps/app/src/routes/api/bilder/$key.ts. */
const PHOTO_ROUTE = '/api/bilder/'
const FILE_NAME = /^([A-Za-z0-9_-]{22})-(\d{1,4})\.webp$/

const fileName = (photoKey: string, size: PhotoSize) => `${photoKey}-${PHOTO_SIZES[size]}.webp`
const objectKey = (photoKey: string, size: PhotoSize) => `profilbilder/${fileName(photoKey, size)}`

/** Adressene til bildet med denne nøkkelen, eller `null` når personen ikke har bilde. */
export function photoUrls(photoKey: string | null): ProfilePhoto | null {
  if (!photoKey) return null
  return {
    small: PHOTO_ROUTE + fileName(photoKey, 'small'),
    large: PHOTO_ROUTE + fileName(photoKey, 'large'),
  }
}

/** 128 tilfeldige bit: kan ikke gjettes, og blir aldri gjenbrukt. */
const newPhotoKey = () => randomBytes(16).toString('base64url')

type Format = 'jpeg' | 'png' | 'webp'

/**
 * Filtypen ut fra de første bytene i fila. Avgjør hva som slippes videre til
 * bildebiblioteket, så SVG, PDF og andre formater aldri blir tolket.
 */
function sniffFormat(bytes: Uint8Array): Format | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to))
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (ascii(0, 8) === '\x89PNG\r\n\x1a\n') return 'png'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp'
  return null
}

const unreadable = () =>
  new DomainError('Vi klarte ikke å lese bildet. Prøv et annet bilde i JPEG, PNG eller WebP.')

export type ProcessedPhoto = Record<PhotoSize, Buffer>

/**
 * Gjør en opplastet fil om til profilbildene som lagres. Kaster `DomainError`
 * med en melding brukeren kan lese hvis fila ikke kan brukes.
 */
export async function processProfilePhoto(file: Uint8Array): Promise<ProcessedPhoto> {
  if (file.byteLength === 0) throw new DomainError('Fila er tom.')
  if (file.byteLength > PHOTO_MAX_BYTES) throw new DomainError('Bildet er for stort. Maks 10 MB.')
  const format = sniffFormat(file)
  if (!format) throw new DomainError('Bildet må være JPEG, PNG eller WebP.')

  const options = {
    // Avbryt ved alt som ser feil ut i pikseldataene; anbefalt for filer fra brukere.
    failOn: 'warning',
    limitInputPixels: MAX_PIXELS,
    // Roter etter EXIF-orienteringen, så bilder tatt på høykant står riktig.
    autoOrient: true,
  } as const
  let metadata: Metadata
  try {
    // Leser bare headeren. Antall piksler sjekkes under, med en tydeligere melding.
    metadata = await sharp(file, { ...options, limitInputPixels: false }).metadata()
  } catch {
    throw unreadable()
  }
  if (metadata.format !== format) throw unreadable()
  const { width, height } = metadata.autoOrient
  if (width * height > MAX_PIXELS) throw new DomainError('Bildet har for mange piksler.')
  const side = Math.min(width, height)
  if (side < MIN_SIDE) {
    throw new DomainError(
      `Bildet er for lite. Bruk et bilde på minst ${MIN_SIDE} × ${MIN_SIDE} piksler.`,
    )
  }

  try {
    // Uten `keepMetadata()` og lignende skriver sharp verken EXIF (med GPS), XMP,
    // IPTC eller fargeprofil, og fargene gjøres om til sRGB. Testene sjekker det.
    const large = await sharp(file, options)
      .timeout({ seconds: 20 })
      .resize(Math.min(side, PHOTO_SIZES.large), Math.min(side, PHOTO_SIZES.large), {
        fit: 'cover',
        position: 'centre',
      })
      // Gjennomsiktig bakgrunn blir hvit, så alle avatarer er hele sirkler.
      .flatten({ background: '#ffffff' })
      .webp({ quality: 82 })
      .toBuffer()
    const small = await sharp(large)
      .resize(Math.min(side, PHOTO_SIZES.small), Math.min(side, PHOTO_SIZES.small))
      .webp({ quality: 82 })
      .toBuffer()
    return { small, large }
  } catch {
    throw unreadable()
  }
}

/**
 * Eieren, eller en admin med `profiles.edit`. Kalles også av appen før selve
 * opplastingen leses inn, så ingen sender 10 MB for å få nei.
 */
export function assertCanChangePhoto(viewer: Viewer, personId: string): boolean {
  assertMember(viewer)
  const isOwn = viewer.personId === personId
  if (!isOwn) assertCan(viewer, 'profiles.edit')
  return isOwn
}

/**
 * Personen bildet skal på. Admins legger bare inn bilder for aktive medlemmer og
 * profiler fra kullisten, ikke for søkere som ennå ikke er godkjent.
 */
async function uploadTarget(db: Db | Tx, personId: string, isOwn: boolean, lock: boolean) {
  const query = db
    .select({ photoKey: person.photoKey, status: membership.status })
    .from(person)
    .leftJoin(membership, eq(membership.personId, person.id))
    .where(eq(person.id, personId))
  const [row] = lock ? await query.for('update', { of: person }) : await query
  if (!row || (!isOwn && row.status !== 'active')) throw new NotFoundError('Fant ikke profilen.')
  return row
}

/** Sletter begge størrelsene. En feil her skal ikke stoppe brukeren, men må synes i loggen. */
async function deletePhotoFiles(storage: ObjectStorage, photoKey: string) {
  const results = await Promise.allSettled(sizes.map((s) => storage.delete(objectKey(photoKey, s))))
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error(`[esaf/core] Kunne ikke slette profilbildet ${photoKey}:`, result.reason)
    }
  }
}

/** Laster opp eller bytter profilbildet og gir adressene til det nye bildet. */
export async function setProfilePhoto(
  db: Db,
  storage: ObjectStorage,
  viewer: Viewer,
  personId: string,
  file: Uint8Array,
): Promise<ProfilePhoto> {
  const isOwn = assertCanChangePhoto(viewer, personId)
  // Før den tunge jobben, så en feil adresse ikke koster en bildebehandling.
  await uploadTarget(db, personId, isOwn, false)
  const images = await processProfilePhoto(file)

  // Filene lagres før databasen peker på dem, så et bilde aldri mangler. Feiler
  // én, ryddes det opp først når alle er ferdige; ellers kunne en fil som ennå
  // var under skriving, blitt liggende igjen.
  const photoKey = newPhotoKey()
  const saved = await Promise.allSettled(
    sizes.map((s) => storage.put(objectKey(photoKey, s), images[s], PHOTO_CONTENT_TYPE)),
  )
  const failed = saved.find((r) => r.status === 'rejected')
  if (failed) {
    await deletePhotoFiles(storage, photoKey)
    throw failed.reason
  }

  let previous: string | null
  try {
    previous = await db.transaction(async (tx) => {
      const target = await uploadTarget(tx, personId, isOwn, true)
      await tx.update(person).set({ photoKey }).where(eq(person.id, personId))
      if (!isOwn) {
        await tx.insert(auditEvent).values({
          actorPersonId: viewer!.personId,
          action: 'profile.admin_photo_upload',
          subjectPersonId: personId,
          details: { replaced: target.photoKey !== null },
        })
      }
      return target.photoKey
    })
  } catch (error) {
    await deletePhotoFiles(storage, photoKey)
    throw error
  }
  if (previous) await deletePhotoFiles(storage, previous)
  return photoUrls(photoKey)!
}

/** Fjerner profilbildet, så initialene vises igjen. Gjør ingenting om det ikke finnes. */
export async function removeProfilePhoto(
  db: Db,
  storage: ObjectStorage,
  viewer: Viewer,
  personId: string,
): Promise<void> {
  const isOwn = assertCanChangePhoto(viewer, personId)
  const previous = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ photoKey: person.photoKey })
      .from(person)
      .where(eq(person.id, personId))
      .for('update')
    if (!row) throw new NotFoundError('Fant ikke profilen.')
    if (!row.photoKey) return null
    await tx.update(person).set({ photoKey: null }).where(eq(person.id, personId))
    if (!isOwn) {
      await tx.insert(auditEvent).values({
        actorPersonId: viewer!.personId,
        action: 'profile.admin_photo_remove',
        subjectPersonId: personId,
      })
    }
    return row.photoKey
  })
  if (previous) await deletePhotoFiles(storage, previous)
}

/**
 * Bildefila bak en adresse fra `photoUrls`, for aktive medlemmer. Bilder som er
 * byttet eller fjernet, finnes ikke lenger, selv om sletting i lagringen skulle
 * ha feilet: nøkkelen må stå på en person.
 */
export async function readProfilePhoto(
  db: Db,
  storage: ObjectStorage,
  viewer: Viewer,
  name: string,
): Promise<Uint8Array> {
  assertMember(viewer)
  const match = FILE_NAME.exec(name)
  const size = sizes.find((s) => String(PHOTO_SIZES[s]) === match?.[2])
  if (!match || !size) throw new NotFoundError('Fant ikke bildet.')
  const photoKey = match[1]!
  const [owner] = await db
    .select({ id: person.id })
    .from(person)
    .where(eq(person.photoKey, photoKey))
  const body = owner ? await storage.get(objectKey(photoKey, size)) : null
  if (!body) throw new NotFoundError('Fant ikke bildet.')
  return body
}
