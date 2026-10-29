import { schema, type Db } from '@esaf/db'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import { assertMember, type Viewer } from './access.ts'
import { companyForEdit } from './companies.ts'
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

const { auditEvent, company } = schema

/**
 * Selskapslogoer. Reglene:
 *
 * - De samme som kan redigere selskapsinfoen, kan laste opp, bytte og fjerne
 *   logoen: gründere (også tidligere), ES-teamet, de som jobber der nå og
 *   admins med `profiles.edit`. Admins som ikke selv er knyttet til selskapet,
 *   logges, som ved annen redigering.
 * - Samme filer slippes inn som for profilbilder (JPEG, PNG og WebP, avgjort av
 *   innholdet; se `images.ts`). Logoen beskjæres aldri: den skaleres inn i et
 *   kvadrat med gjennomsiktig kant, gjennomsiktighet beholdes, og den lagres som
 *   WebP i to størrelser uten metadata.
 * - Hver logo får en ny tilfeldig nøkkel, og den gamle slettes når den byttes
 *   eller fjernes. Logoene serveres bare til aktive medlemmer, og bare så lenge
 *   nøkkelen står på et selskap.
 */

/** Største fil som tas imot, som for profilbilder. */
export const LOGO_MAX_BYTES = IMAGE_MAX_BYTES
/** Logoene lagres i to størrelser: stor til selskapssiden, liten til lister. */
export const LOGO_SIZES = { small: 64, large: 256 } as const
export const LOGO_CONTENT_TYPE = IMAGE_CONTENT_TYPE

type LogoSize = keyof typeof LOGO_SIZES
const sizes = Object.keys(LOGO_SIZES) as LogoSize[]

/** Den lengste siden må være minst så lang; ellers blir logoen grøtete selv i lister. */
const MIN_SIDE = 64

/** Adressene til en logo. Logoene serveres bare til aktive medlemmer. */
export type CompanyLogoUrls = {
  /** 64 × 64, til lister og forslag. */
  small: string
  /** 256 × 256 (eller mindre, hvis originalen var mindre), til selskapssiden. */
  large: string
}

/** Ruten i appen som serverer logoene: apps/app/src/routes/api/logoer/$key.ts. */
const LOGO_ROUTE = '/api/logoer/'

const fileName = (logoKey: string, size: LogoSize) => `${logoKey}-${LOGO_SIZES[size]}.webp`
const objectKey = (logoKey: string, size: LogoSize) => `logoer/${fileName(logoKey, size)}`

/** Adressene til logoen med denne nøkkelen, eller `null` når selskapet ikke har logo. */
export function logoUrls(logoKey: string | null): CompanyLogoUrls | null {
  if (!logoKey) return null
  return {
    small: LOGO_ROUTE + fileName(logoKey, 'small'),
    large: LOGO_ROUTE + fileName(logoKey, 'large'),
  }
}

export type ProcessedLogo = Record<LogoSize, Buffer>

// Logoer har skarpe kanter og flater i én farge, så de tåler mindre komprimering enn foto.
const webp = { quality: 90, alphaQuality: 100, smartSubsample: true } as const
const transparent = { r: 255, g: 255, b: 255, alpha: 0 }

/**
 * Gjør en opplastet fil om til logoene som lagres. Kaster `DomainError` med en
 * melding brukeren kan lese hvis fila ikke kan brukes.
 */
export async function processCompanyLogo(file: Uint8Array): Promise<ProcessedLogo> {
  const { width, height } = await inspectUpload(file)
  const longest = Math.max(width, height)
  if (longest < MIN_SIDE) {
    throw new DomainError(
      `Logoen er for liten. Bruk et bilde der den lengste siden er minst ${MIN_SIDE} piksler.`,
    )
  }
  // Skaleres aldri opp: den lengste siden blir sida i kvadratet, eller mindre.
  const side = (size: LogoSize) => Math.min(longest, LOGO_SIZES[size])

  try {
    // Som for profilbilder skriver sharp ingen metadata, og fargene gjøres om til sRGB.
    const large = await sharp(file, readOptions)
      .timeout({ seconds: 20 })
      .resize(side('large'), side('large'), { fit: 'contain', background: transparent })
      .webp(webp)
      .toBuffer()
    const small = await sharp(large).resize(side('small'), side('small')).webp(webp).toBuffer()
    return { small, large }
  } catch {
    throw unreadable()
  }
}

/**
 * Selskapet, når den innloggede kan endre logoen: de samme som kan redigere
 * selskapsinfoen. `adminEdit` betyr at endringen gjøres med adminrettighet og
 * logges. Kalles også av appen før selve opplastingen leses inn, så ingen
 * sender 10 MB for å få nei.
 */
export function assertCanChangeLogo(
  db: Db | Tx,
  viewer: Viewer,
  companyId: string,
  options?: { lock?: boolean },
) {
  return companyForEdit(db, viewer, companyId, options)
}

/** Sletter begge størrelsene. En feil her skal ikke stoppe brukeren, men må synes i loggen. */
export const deleteLogoFiles = (storage: ObjectStorage, logoKey: string) =>
  deleteImageFiles(
    storage,
    sizes.map((s) => objectKey(logoKey, s)),
    `logoen ${logoKey}`,
  )

/** Laster opp eller bytter logoen og gir adressene til den nye. */
export async function setCompanyLogo(
  db: Db,
  storage: ObjectStorage,
  viewer: Viewer,
  companyId: string,
  file: Uint8Array,
): Promise<CompanyLogoUrls> {
  // Før den tunge jobben, så en feil adresse eller manglende tilgang ikke koster en bildebehandling.
  await assertCanChangeLogo(db, viewer, companyId)
  const images = await processCompanyLogo(file)

  // Filene lagres før databasen peker på dem, så en logo aldri mangler.
  const logoKey = newImageKey()
  await putImageFiles(
    storage,
    sizes.map((s) => ({ key: objectKey(logoKey, s), body: images[s] })),
    `logoen ${logoKey}`,
  )

  let previous: string | null
  try {
    previous = await db.transaction(async (tx) => {
      // Sjekkes på nytt under lås: tilknytningen kan ha endret seg mens bildet ble behandlet.
      const target = await assertCanChangeLogo(tx, viewer, companyId, { lock: true })
      // Logoen er en redigering, så selskapet ikke ryddes bort som ubrukt.
      await tx
        .update(company)
        .set({ logoKey, editedAt: new Date() })
        .where(eq(company.id, companyId))
      await recordFieldEdits(
        tx,
        'company',
        companyId,
        ['logo'],
        target.adminEdit ? 'forget' : 'confirm',
      )
      if (target.adminEdit) {
        await tx.insert(auditEvent).values({
          actorPersonId: viewer!.personId,
          action: 'company.admin_logo_upload',
          details: {
            companyId,
            slug: target.slug,
            name: target.name,
            replaced: target.logoKey !== null,
          },
        })
      }
      return target.logoKey
    })
  } catch (error) {
    await deleteLogoFiles(storage, logoKey)
    throw error
  }
  if (previous) await deleteLogoFiles(storage, previous)
  return logoUrls(logoKey)!
}

/** Fjerner logoen, så bokstavflisen vises igjen. Gjør ingenting om den ikke finnes. */
export async function removeCompanyLogo(
  db: Db,
  storage: ObjectStorage,
  viewer: Viewer,
  companyId: string,
): Promise<void> {
  const previous = await db.transaction(async (tx) => {
    const target = await assertCanChangeLogo(tx, viewer, companyId, { lock: true })
    if (!target.logoKey) return null
    await tx
      .update(company)
      .set({ logoKey: null, editedAt: new Date() })
      .where(eq(company.id, companyId))
    // Uten logo finnes det ikke noe å vise kilden for.
    await recordFieldEdits(tx, 'company', companyId, ['logo'], 'forget')
    if (target.adminEdit) {
      await tx.insert(auditEvent).values({
        actorPersonId: viewer!.personId,
        action: 'company.admin_logo_remove',
        details: { companyId, slug: target.slug, name: target.name },
      })
    }
    return target.logoKey
  })
  if (previous) await deleteLogoFiles(storage, previous)
}

/**
 * Logofila bak en adresse fra `logoUrls`, for aktive medlemmer. Logoer som er
 * byttet eller fjernet, finnes ikke lenger, selv om sletting i lagringen skulle
 * ha feilet: nøkkelen må stå på et selskap.
 */
export async function readCompanyLogo(
  db: Db,
  storage: ObjectStorage,
  viewer: Viewer,
  name: string,
): Promise<Uint8Array> {
  assertMember(viewer)
  const match = IMAGE_FILE_NAME.exec(name)
  const size = sizes.find((s) => String(LOGO_SIZES[s]) === match?.[2])
  if (!match || !size) throw new NotFoundError('Fant ikke logoen.')
  const logoKey = match[1]!
  const [owner] = await db
    .select({ id: company.id })
    .from(company)
    .where(eq(company.logoKey, logoKey))
  const body = owner ? await storage.get(objectKey(logoKey, size)) : null
  if (!body) throw new NotFoundError('Fant ikke logoen.')
  return body
}
