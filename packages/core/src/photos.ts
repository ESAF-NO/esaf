import { schema, type Db } from '@esaf/db'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import { assertCan, assertMember, type Viewer } from './access.ts'
import { DomainError, NotFoundError } from './errors.ts'
import {
  deleteImageFiles,
  IMAGE_CONTENT_TYPE,
  IMAGE_FILE_NAME,
  IMAGE_MAX_BYTES,
  inspectUpload,
  newImageKey,
  putImageFiles,
  readOptions,
  unreadable,
} from './images.ts'
import type { Tx } from './members.ts'
import { recordFieldEdits } from './sources.ts'
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
 *   fjernet (også GPS), beskåret til kvadrat (se `squareCrop`), skalert ned og lagret
 *   som WebP i to størrelser. Det som ikke kan leses som JPEG, PNG eller WebP,
 *   avvises, uansett filnavn eller hva nettleseren sier filtypen er (se
 *   `images.ts`).
 * - Hvert bilde får en ny tilfeldig nøkkel, og det gamle slettes når det byttes
 *   eller fjernes. Bildene serveres bare til aktive medlemmer, og bare så lenge
 *   nøkkelen står på en person.
 */

/** Største fil som tas imot. Appen sjekker det også før opplastingen leses inn. */
export const PHOTO_MAX_BYTES = IMAGE_MAX_BYTES
/** Bildene lagres i to størrelser: stor til profilsiden, liten til lister. */
export const PHOTO_SIZES = { small: 192, large: 512 } as const
export const PHOTO_CONTENT_TYPE = IMAGE_CONTENT_TYPE

type PhotoSize = keyof typeof PHOTO_SIZES
const sizes = Object.keys(PHOTO_SIZES) as PhotoSize[]

/** Mindre enn dette blir uskarpt selv som liten avatar. */
const MIN_SIDE = 128

/**
 * Hvor høyt kvadratet skjæres ut av et bilde på høykant: 0 er helt øverst, 0,5
 * er midten. Profilbilder er nesten alltid portretter med hodet i øvre del; et
 * kvadrat fra midten kutter pannen og viser mest overkropp. Prøvd på bildene fra
 * kullsidene: 0,15 får med hodet både på nærbilder og på bilder av hele
 * overkroppen. Ansikts- og «attention»-beskjæring i sharp traff ofte en lys
 * skjorte i stedet for ansiktet. Appen viser forhåndsvisningen likt
 * (`object-position: 50% 15%`).
 */
export const PORTRAIT_CROP_TOP = 0.15

/**
 * Kvadratet som skjæres ut av et bilde som står slik (etter EXIF-rotering):
 * midten på bredden, og litt over midten på høyden når bildet står på høykant.
 */
export function squareCrop(width: number, height: number) {
  const side = Math.min(width, height)
  return {
    left: Math.floor((width - side) / 2),
    top: Math.round((height - side) * PORTRAIT_CROP_TOP),
    width: side,
    height: side,
  }
}

/** Adressene til et profilbilde. Bildene serveres bare til aktive medlemmer. */
export type ProfilePhoto = {
  /** 192 × 192, til lister og små avatarer. */
  small: string
  /** 512 × 512 (eller originalen, hvis den var mindre), til profilsiden. */
  large: string
}

/** Ruten i appen som serverer bildene: apps/app/src/routes/api/bilder/$key.ts. */
const PHOTO_ROUTE = '/api/bilder/'

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

export type ProcessedPhoto = Record<PhotoSize, Buffer>

/**
 * Gjør en opplastet fil om til profilbildene som lagres. Kaster `DomainError`
 * med en melding brukeren kan lese hvis fila ikke kan brukes.
 */
export async function processProfilePhoto(file: Uint8Array): Promise<ProcessedPhoto> {
  const { width, height } = await inspectUpload(file)
  const crop = squareCrop(width, height)
  const side = crop.width
  if (side < MIN_SIDE) {
    throw new DomainError(
      `Bildet er for lite. Bruk et bilde på minst ${MIN_SIDE} × ${MIN_SIDE} piksler.`,
    )
  }

  try {
    // Uten `keepMetadata()` og lignende skriver sharp verken EXIF (med GPS), XMP,
    // IPTC eller fargeprofil, og fargene gjøres om til sRGB. Testene sjekker det.
    const large = await sharp(file, readOptions)
      .timeout({ seconds: 20 })
      // `autoOrient` i `readOptions` roterer før utsnittet, så det gjelder bildet
      // slik det står, akkurat som målene fra `inspectUpload`.
      .extract(crop)
      .resize(Math.min(side, PHOTO_SIZES.large), Math.min(side, PHOTO_SIZES.large))
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
export const deletePhotoFiles = (storage: ObjectStorage, photoKey: string) =>
  deleteImageFiles(
    storage,
    sizes.map((s) => objectKey(photoKey, s)),
    `profilbildet ${photoKey}`,
  )

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

  // Filene lagres før databasen peker på dem, så et bilde aldri mangler.
  const photoKey = newImageKey()
  await putImageFiles(
    storage,
    sizes.map((s) => ({ key: objectKey(photoKey, s), body: images[s] })),
    `profilbildet ${photoKey}`,
  )

  let previous: string | null
  try {
    previous = await db.transaction(async (tx) => {
      const target = await uploadTarget(tx, personId, isOwn, true)
      await tx.update(person).set({ photoKey }).where(eq(person.id, personId))
      await recordFieldEdits(tx, 'person', personId, ['photo'], isOwn ? 'confirm' : 'forget')
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
    // Uten bilde finnes det ikke noe å vise kilden for.
    await recordFieldEdits(tx, 'person', personId, ['photo'], 'forget')
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
  const match = IMAGE_FILE_NAME.exec(name)
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
