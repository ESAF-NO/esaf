import { schema, type Db } from '@esaf/db'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import { z } from 'zod'
import { assertCan, assertMember, type Viewer } from './access.ts'
import { DomainError, NotFoundError } from './errors.ts'
import {
  deleteImageFiles,
  IMAGE_CONTENT_TYPE,
  IMAGE_FILE_NAME,
  inspectUpload,
  newImageKey,
  oneImageAtATime,
  putImageFiles,
  readOptions,
  unreadable,
} from './images.ts'
import type { Tx } from './members.ts'
import type { ObjectStorage } from './storage.ts'

const { auditEvent, badge } = schema

/**
 * Egne bilder på merker. Reglene:
 *
 * - Admins med `badges.manage` kan laste opp, bytte og fjerne bildet. Bildet vises
 *   i stedet for ikonet; ikonet og fargen beholdes, så merket viser ikonet igjen
 *   når bildet fjernes.
 * - Samme filer slippes inn som for profilbilder og logoer (JPEG, PNG og WebP,
 *   avgjort av innholdet; se `images.ts`). Bildet beskjæres til et kvadrat fra
 *   midten, siden medaljen er rund. Gjennomsiktighet beholdes, så fargen på merket
 *   synes bak. Det lagres som WebP i to størrelser uten metadata.
 * - Hvert bilde får en ny tilfeldig nøkkel, og det gamle slettes når det byttes,
 *   fjernes eller merket slettes. Bildene serveres bare til aktive medlemmer, og
 *   bare så lenge nøkkelen står på et merke.
 */

/** Bildene lagres i to størrelser: liten til lister, stor til dialogen med merket. */
export const BADGE_IMAGE_SIZES = { small: 96, large: 256 } as const
export const BADGE_IMAGE_CONTENT_TYPE = IMAGE_CONTENT_TYPE

type BadgeImageSize = keyof typeof BADGE_IMAGE_SIZES
const sizes = Object.keys(BADGE_IMAGE_SIZES) as BadgeImageSize[]

/** Den korteste siden må være minst så lang; ellers blir merket grøtete selv i lister. */
const MIN_SIDE = BADGE_IMAGE_SIZES.small

/** Adressene til et merkebilde. Bildene serveres bare til aktive medlemmer. */
export type BadgeImage = {
  /** 96 × 96 (eller originalen, hvis den var mindre), til lister og profilen. */
  small: string
  /** 256 × 256 (eller originalen, hvis den var mindre), til dialogen med merket. */
  large: string
}

/** Ruten i appen som serverer bildene: apps/app/src/routes/api/merkebilder/$key.ts. */
const IMAGE_ROUTE = '/api/merkebilder/'

const fileName = (imageKey: string, size: BadgeImageSize) =>
  `${imageKey}-${BADGE_IMAGE_SIZES[size]}.webp`
const objectKey = (imageKey: string, size: BadgeImageSize) =>
  `merkebilder/${fileName(imageKey, size)}`

/** Adressene til bildet med denne nøkkelen, eller `null` når merket viser ikonet. */
export function badgeImageUrls(imageKey: string | null): BadgeImage | null {
  if (!imageKey) return null
  return {
    small: IMAGE_ROUTE + fileName(imageKey, 'small'),
    large: IMAGE_ROUTE + fileName(imageKey, 'large'),
  }
}

export type ProcessedBadgeImage = Record<BadgeImageSize, Buffer>

// Merker er ofte tegnede flater med skarpe kanter, som logoer.
const webp = { quality: 90, alphaQuality: 100, smartSubsample: true } as const

/**
 * Gjør en opplastet fil om til bildene som lagres. Kaster `DomainError` med en
 * melding brukeren kan lese hvis fila ikke kan brukes.
 */
export async function processBadgeImage(file: Uint8Array): Promise<ProcessedBadgeImage> {
  const { width, height } = await inspectUpload(file)
  const shortest = Math.min(width, height)
  if (shortest < MIN_SIDE) {
    throw new DomainError(
      `Bildet er for lite. Bruk et bilde på minst ${MIN_SIDE} × ${MIN_SIDE} piksler.`,
    )
  }
  // Skaleres aldri opp.
  const side = (size: BadgeImageSize) => Math.min(shortest, BADGE_IMAGE_SIZES[size])

  return oneImageAtATime(async () => {
    try {
      // Som for profilbilder skriver sharp ingen metadata, og fargene gjøres om til sRGB.
      const large = await sharp(file, readOptions)
        .timeout({ seconds: 20 })
        .resize(side('large'), side('large'), { fit: 'cover', position: 'centre' })
        .webp(webp)
        .toBuffer()
      const small = await sharp(large).resize(side('small'), side('small')).webp(webp).toBuffer()
      return { small, large }
    } catch {
      throw unreadable()
    }
  })
}

/**
 * Admins med `badges.manage`, og merket må finnes. Kalles også av appen før selve
 * opplastingen leses inn, så ingen sender 10 MB for å få nei.
 */
export async function assertCanChangeBadgeImage(db: Db | Tx, viewer: Viewer, badgeId: string) {
  assertCan(viewer, 'badges.manage')
  if (!z.uuid().safeParse(badgeId).success) throw new NotFoundError('Fant ikke merket.')
  const [found] = await db.select({ id: badge.id }).from(badge).where(eq(badge.id, badgeId))
  if (!found) throw new NotFoundError('Fant ikke merket.')
}

/** Merket under lås, så to opplastinger ikke kan etterlate filer ingen peker på. */
async function lockTarget(tx: Tx, badgeId: string) {
  const [row] = await tx
    .select({ slug: badge.slug, name: badge.name, imageKey: badge.imageKey })
    .from(badge)
    .where(eq(badge.id, badgeId))
    .for('update')
  if (!row) throw new NotFoundError('Fant ikke merket.')
  return row
}

/** Sletter begge størrelsene. En feil her skal ikke stoppe brukeren, men må synes i loggen. */
export const deleteBadgeImageFiles = (storage: ObjectStorage, imageKey: string) =>
  deleteImageFiles(
    storage,
    sizes.map((s) => objectKey(imageKey, s)),
    `merkebildet ${imageKey}`,
  )

/** Laster opp eller bytter bildet på et merke og gir adressene til det nye. */
export async function setBadgeImage(
  db: Db,
  storage: ObjectStorage,
  viewer: Viewer,
  badgeId: string,
  file: Uint8Array,
): Promise<BadgeImage> {
  // Før den tunge jobben, så en feil adresse eller manglende tilgang ikke koster en bildebehandling.
  await assertCanChangeBadgeImage(db, viewer, badgeId)
  const images = await processBadgeImage(file)

  // Filene lagres før databasen peker på dem, så et bilde aldri mangler.
  const imageKey = newImageKey()
  await putImageFiles(
    storage,
    sizes.map((s) => ({ key: objectKey(imageKey, s), body: images[s] })),
    `merkebildet ${imageKey}`,
  )

  let previous: string | null
  try {
    previous = await db.transaction(async (tx) => {
      const target = await lockTarget(tx, badgeId)
      await tx.update(badge).set({ imageKey, updatedAt: new Date() }).where(eq(badge.id, badgeId))
      await tx.insert(auditEvent).values({
        actorPersonId: viewer!.personId,
        action: 'badge.image_upload',
        details: {
          badgeId,
          slug: target.slug,
          name: target.name,
          replaced: target.imageKey !== null,
        },
      })
      return target.imageKey
    })
  } catch (error) {
    await deleteBadgeImageFiles(storage, imageKey)
    throw error
  }
  if (previous) await deleteBadgeImageFiles(storage, previous)
  return badgeImageUrls(imageKey)!
}

/** Fjerner bildet, så merket viser ikonet igjen. Gjør ingenting om det ikke finnes. */
export async function removeBadgeImage(
  db: Db,
  storage: ObjectStorage,
  viewer: Viewer,
  badgeId: string,
): Promise<void> {
  await assertCanChangeBadgeImage(db, viewer, badgeId)
  const previous = await db.transaction(async (tx) => {
    const target = await lockTarget(tx, badgeId)
    if (!target.imageKey) return null
    await tx
      .update(badge)
      .set({ imageKey: null, updatedAt: new Date() })
      .where(eq(badge.id, badgeId))
    await tx.insert(auditEvent).values({
      actorPersonId: viewer!.personId,
      action: 'badge.image_remove',
      details: { badgeId, slug: target.slug, name: target.name },
    })
    return target.imageKey
  })
  if (previous) await deleteBadgeImageFiles(storage, previous)
}

/**
 * Bildefila bak en adresse fra `badgeImageUrls`, for aktive medlemmer. Bilder som
 * er byttet eller fjernet, finnes ikke lenger, selv om sletting i lagringen skulle
 * ha feilet: nøkkelen må stå på et merke.
 */
export async function readBadgeImage(
  db: Db,
  storage: ObjectStorage,
  viewer: Viewer,
  name: string,
): Promise<Uint8Array> {
  assertMember(viewer)
  const match = IMAGE_FILE_NAME.exec(name)
  const size = sizes.find((s) => String(BADGE_IMAGE_SIZES[s]) === match?.[2])
  if (!match || !size) throw new NotFoundError('Fant ikke bildet.')
  const imageKey = match[1]!
  const [owner] = await db.select({ id: badge.id }).from(badge).where(eq(badge.imageKey, imageKey))
  const body = owner ? await storage.get(objectKey(imageKey, size)) : null
  if (!body) throw new NotFoundError('Fant ikke bildet.')
  return body
}
