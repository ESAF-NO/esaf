import { createHash } from 'node:crypto'
import { schema, type AssetKind, type AssetPurpose, type Db } from '@esaf/db'
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm'
import sharp from 'sharp'
import { assertCan, assertMember, can, type Viewer } from './access.ts'
import { companyForEdit } from './companies.ts'
import { AccessDeniedError, DomainError, NotFoundError } from './errors.ts'
import { osloToday } from './events.ts'
import {
  contentDisposition,
  documentTypeOf,
  safeFileName,
  sniffFile,
  type DocumentType,
} from './file-types.ts'
import {
  animatedReadOptions,
  deleteImageFiles,
  IMAGE_CONTENT_TYPE,
  inspectUpload,
  newImageKey,
  oneImageAtATime,
  putImageFiles,
  readOptions,
  unreadable,
} from './images.ts'
import type { Tx } from './members.ts'
import type { ObjectStorage } from './storage.ts'

const { asset, auditEvent, comment, event, eventParticipation, person, post } = schema

/**
 * Vedlegg: bilder og dokumenter på innlegg, kommentarer, arrangementer («Bilder»
 * og «Dokumenter») og selskaper («Dokumenter»). Reglene:
 *
 * - Hvilke filer som slippes inn, avgjøres av innholdet (`file-types.ts`). Bilder
 *   behandles som profilbilder: rotert etter EXIF, ALL metadata fjernet (også
 *   GPS), og lagret som WebP i 400 og 1600 piksler på den lengste siden, uten
 *   beskjæring. GIF-er og animert WebP lagres som animert WebP, høyst 800 piksler.
 *   Dokumenter lagres som de er. Maks 25 MB per fil.
 * - Alle aktive medlemmer kan legge ved filer i innlegg og kommentarer (maks 10
 *   per innlegg eller kommentar). Bilder på et arrangement kan lastes opp av dem
 *   som var der og av admins, når arrangementet har startet. Dokumenter på et
 *   arrangement kan lastes opp av arrangørene og admins, og på et selskap av de
 *   samme som kan redigere selskapet.
 * - Den som lastet opp, kan slette sine egne filer. Moderatorer og admins kan
 *   fjerne alle, arrangører og admins dokumentene på et arrangement, og de som
 *   kan redigere et selskap, dokumentene der. Fjerner noen andres fil, logges det.
 * - Grense per person: 50 filer og 500 MB per døgn (admins 500 filer og 5 GB, så
 *   et helt album fra ESAF-helgen kan lastes opp).
 * - Filene serveres bare til aktive medlemmer, og bare så lenge forelderen
 *   finnes og ikke er slettet. Filer uten forelder ser bare den som lastet dem
 *   opp (mens innlegget skrives), og de ryddes bort etter et døgn.
 * - Filene lagres før databasen peker på dem, og slettes igjen om lagringen i
 *   databasen feiler.
 */

/** Største fil som tas imot. Appen sjekker det også før opplastingen leses inn. */
export const ASSET_MAX_BYTES = 25 * 1024 * 1024
/** Bildene lagres i to størrelser: liten i rutenett, stor i visningen. Lengste side. */
export const ASSET_IMAGE_SIZES = { small: 400, large: 1600 } as const
/** Høyst så mange vedlegg i ett innlegg eller én kommentar. */
export const MAX_ATTACHMENTS = 10
/** Høyst så mange bilder i albumet til ett arrangement. */
export const MAX_EVENT_PHOTOS = 1000
/** Høyst så mange dokumenter på ett arrangement eller selskap. */
export const MAX_DOCUMENTS = 30
/** Grensene per person og døgn. */
export const UPLOAD_LIMITS = {
  member: { files: 50, bytes: 500 * 1024 * 1024 },
  admin: { files: 500, bytes: 5 * 1024 * 1024 * 1024 },
} as const
/** Filer som aldri ble festet til noe, ryddes bort etter så lang tid. */
export const ORPHAN_AFTER_MS = 24 * 60 * 60 * 1000

/** Den lengste siden på animasjoner: de vises aldri større, og hvert bilde koster. */
const ANIMATED_LARGE_SIDE = 800

/** Mindre enn dette er neppe et bilde noen vil vise. */
const MIN_SIDE = 16

type ImageSize = keyof typeof ASSET_IMAGE_SIZES
const imageSizes = Object.keys(ASSET_IMAGE_SIZES) as ImageSize[]

/** Mappen i lagringen (én bøtte for alt). */
const PREFIXES: Record<AssetPurpose, string> = {
  post: 'vedlegg/',
  comment: 'vedlegg/',
  event_photo: 'album/',
  event_document: 'dokumenter/',
  company_document: 'dokumenter/',
}

/** Ruten i appen som serverer filene: apps/app/src/routes/api/vedlegg/$name.ts. */
const ASSET_ROUTE = '/api/vedlegg/'

/** Filnavnet i adressene: nøkkelen, og for bilder størrelsen og `.webp`. */
const ASSET_FILE_NAME = /^([A-Za-z0-9_-]{22})(?:-(\d{1,4})\.webp)?$/

/** Hva fila skal lastes opp til. Innlegg og kommentarer får den først når de lagres. */
export type AssetTarget =
  | { purpose: 'post' | 'comment' }
  | { purpose: 'event_photo' | 'event_document'; eventId: string }
  | { purpose: 'company_document'; companyId: string }

/** En fil slik appen viser den. */
export type AssetView = {
  id: string
  kind: AssetKind
  /** Filnavnet, renset og med filendelsen som passer innholdet. */
  name: string
  contentType: string
  /** Hva slags dokument, til ikon og etikett. Null for bilder. */
  documentType: DocumentType | null
  /** Størrelsen på fila som ble lastet opp. */
  byteSize: number
  /** Den store varianten av bildet. Null for dokumenter. */
  width: number | null
  height: number | null
  /** Bildet i 400 og 1600 piksler. Null for dokumenter. */
  image: { small: string; large: string } | null
  /** Dokumenter: nedlastingen. Bilder: den store varianten. */
  url: string
  uploadedBy: { personId: string; fullName: string } | null
  createdAt: Date
  /** Den innloggede lastet opp fila selv. */
  own: boolean
  /** Den innloggede kan slette eller fjerne fila. */
  canRemove: boolean
}

/** Overskredet grense per døgn. Appen svarer 429. */
export class UploadLimitError extends DomainError {
  constructor(message: string) {
    super(message)
    this.name = 'UploadLimitError'
  }
}

type AssetRow = typeof asset.$inferSelect

const imageUrl = (fileKey: string, size: ImageSize) =>
  `${ASSET_ROUTE}${fileKey}-${ASSET_IMAGE_SIZES[size]}.webp`

function toView(
  row: AssetRow,
  uploader: { personId: string; fullName: string } | null,
  viewer: { personId: string },
  canRemove: boolean,
): AssetView {
  const image =
    row.kind === 'image'
      ? { small: imageUrl(row.fileKey, 'small'), large: imageUrl(row.fileKey, 'large') }
      : null
  return {
    id: row.id,
    kind: row.kind,
    name: row.originalName,
    contentType: row.contentType,
    documentType: row.kind === 'document' ? documentTypeOf(row.contentType) : null,
    byteSize: row.byteSize,
    width: row.width,
    height: row.height,
    image,
    url: image ? image.large : `${ASSET_ROUTE}${row.fileKey}`,
    uploadedBy: uploader,
    createdAt: row.createdAt,
    own: row.ownerPersonId === viewer.personId,
    canRemove,
  }
}

// ---------------------------------------------------------------------------
// Tilgang
// ---------------------------------------------------------------------------

async function eventRole(db: Db | Tx, eventId: string, personId: string, lock: boolean) {
  const query = db
    .select({ id: event.id, name: event.name, startDate: event.startDate })
    .from(event)
    .where(eq(event.id, eventId))
  const [row] = lock ? await query.for('update') : await query
  if (!row) throw new NotFoundError('Fant ikke arrangementet.')
  const [participation] = await db
    .select({ role: eventParticipation.role })
    .from(eventParticipation)
    .where(and(eq(eventParticipation.eventId, eventId), eq(eventParticipation.personId, personId)))
  return { event: row, participant: Boolean(participation), role: participation?.role ?? null }
}

/** Det som skal i loggen når noen laster opp med adminrettighet. */
type UploadAudit = { action: string; details: Record<string, unknown> } | null

/**
 * Om den innloggede kan laste opp til dette, og hva som eventuelt skal logges.
 * Kalles også av appen før selve opplastingen leses inn, så ingen sender 25 MB
 * for å få nei.
 */
export async function assertCanUpload(
  db: Db | Tx,
  viewer: Viewer,
  target: AssetTarget,
  { lock = false } = {},
): Promise<{ audit: UploadAudit }> {
  assertMember(viewer)
  switch (target.purpose) {
    case 'post':
    case 'comment':
      return { audit: null }
    case 'event_photo': {
      const { event: e, participant } = await eventRole(db, target.eventId, viewer.personId, lock)
      if (!participant && !can(viewer, 'profiles.edit')) {
        // Admins uten sterk innlogging får vite hvorfor; andre får nei.
        if (viewer.membership?.role === 'admin' || viewer.membership?.role === 'owner') {
          assertCan(viewer, 'profiles.edit')
        }
        throw new DomainError(
          'Bare de som var på arrangementet, kan legge inn bilder. Trykk «Jeg var der» først.',
        )
      }
      if (e.startDate > osloToday()) {
        throw new DomainError('Bilder kan legges inn når arrangementet har startet.')
      }
      return { audit: null }
    }
    case 'event_document': {
      const { event: e, role } = await eventRole(db, target.eventId, viewer.personId, lock)
      if (role === 'organizer') return { audit: null }
      assertCan(viewer, 'profiles.edit')
      return {
        audit: {
          action: 'event.admin_document_add',
          details: { eventId: e.id, name: e.name },
        },
      }
    }
    case 'company_document': {
      const c = await companyForEdit(db, viewer, target.companyId, { lock })
      return {
        audit: c.adminEdit
          ? {
              action: 'company.admin_document_add',
              details: { companyId: c.id, slug: c.slug, name: c.name },
            }
          : null,
      }
    }
  }
}

/** Det personen har lastet opp siste døgn, mot grensene. Admins har høyere grenser. */
async function assertQuota(
  db: Db | Tx,
  viewer: { personId: string },
  size: number,
  admin: boolean,
) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const [used] = await db
    .select({
      files: sql<number>`count(*)::int`,
      bytes: sql<number>`coalesce(sum(${asset.byteSize}), 0)::bigint`,
    })
    .from(asset)
    .where(and(eq(asset.ownerPersonId, viewer.personId), gt(asset.createdAt, since)))
  const limit = admin ? UPLOAD_LIMITS.admin : UPLOAD_LIMITS.member
  if (used!.files >= limit.files) {
    throw new UploadLimitError(
      `Du har lastet opp ${limit.files} filer det siste døgnet, som er grensen. Prøv igjen senere.`,
    )
  }
  if (Number(used!.bytes) + size > limit.bytes) {
    throw new UploadLimitError(
      `Du kan laste opp høyst ${Math.round(limit.bytes / 1024 / 1024)} MB per døgn. Prøv igjen senere.`,
    )
  }
}

/** Sjekker grensen per døgn før fila leses inn, så ingen sender 25 MB for å få nei. */
export async function assertUploadQuota(db: Db, viewer: Viewer, size: number) {
  assertMember(viewer)
  await assertQuota(db, viewer, size, can(viewer, 'profiles.edit'))
}

/** Plass til én fil til hos forelderen. */
async function assertRoom(tx: Tx, target: AssetTarget) {
  if (target.purpose === 'post' || target.purpose === 'comment') return
  const parent =
    'companyId' in target
      ? eq(asset.companyId, target.companyId)
      : eq(asset.eventId, (target as { eventId: string }).eventId)
  const count = await tx.$count(
    asset,
    and(parent, eq(asset.purpose, target.purpose), isNull(asset.deletedAt)),
  )
  const max = target.purpose === 'event_photo' ? MAX_EVENT_PHOTOS : MAX_DOCUMENTS
  if (count >= max) {
    throw new DomainError(
      target.purpose === 'event_photo'
        ? `Albumet er fullt (${max} bilder).`
        : `Det kan ligge høyst ${max} dokumenter her. Fjern et gammelt først.`,
    )
  }
  return count
}

// ---------------------------------------------------------------------------
// Opplasting
// ---------------------------------------------------------------------------

export type ProcessedAssetImage = Record<ImageSize, Buffer> & { width: number; height: number }

/**
 * Gjør et opplastet bilde om til variantene som lagres: rotert etter EXIF, uten
 * metadata, som WebP med den lengste siden på høyst 400 og 1600 piksler. Bildet
 * beskjæres aldri og skaleres aldri opp, og gjennomsiktighet beholdes. Ett bilde
 * om gangen i prosessen (`oneImageAtATime`).
 */
export async function processAssetImage(file: Uint8Array): Promise<ProcessedAssetImage> {
  const { width, height, frames } = await inspectUpload(file, ASSET_MAX_BYTES, { animation: true })
  if (Math.min(width, height) < MIN_SIDE) {
    throw new DomainError(`Bildet er for lite. Bruk et bilde på minst ${MIN_SIDE} piksler.`)
  }
  return oneImageAtATime(async () => {
    try {
      if (frames > 1) return await processAnimation(file)
      // Uten `keepMetadata()` skriver sharp verken EXIF (med GPS), XMP, IPTC eller
      // fargeprofil, og fargene gjøres om til sRGB. Testene sjekker det.
      const large = await sharp(file, readOptions)
        .timeout({ seconds: 60 })
        .resize(ASSET_IMAGE_SIZES.large, ASSET_IMAGE_SIZES.large, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 82 })
        .toBuffer({ resolveWithObject: true })
      const small = await sharp(large.data)
        .resize(ASSET_IMAGE_SIZES.small, ASSET_IMAGE_SIZES.small, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 80 })
        .toBuffer()
      return { small, large: large.data, width: large.info.width, height: large.info.height }
    } catch {
      throw unreadable()
    }
  })
}

/** Som over, men alle bildene i animasjonen beholdes, med tidene mellom dem. */
async function processAnimation(file: Uint8Array): Promise<ProcessedAssetImage> {
  const scaled = (input: Uint8Array, side: number) =>
    sharp(input, animatedReadOptions)
      .timeout({ seconds: 30 })
      .resize(side, side, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 75 })
      .toBuffer({ resolveWithObject: true })
  const large = await scaled(file, ANIMATED_LARGE_SIDE)
  const small = await scaled(large.data, ASSET_IMAGE_SIZES.small)
  return {
    small: small.data,
    large: large.data,
    width: large.info.width,
    // Bildene ligger under hverandre, så `height` er høyden på hele stabelen.
    height: large.info.pageHeight ?? large.info.height,
  }
}

const label = (fileKey: string) => `vedlegget ${fileKey}`

/**
 * Laster opp en fil og gir den slik appen viser den. Innlegg og kommentarer får
 * fila når de lagres (`attachAssets`); arrangementer og selskaper med en gang.
 * `fileName` er navnet fra nettleseren, og brukes bare til visning (renset) og
 * for å skille .txt fra .csv.
 */
export async function uploadAsset(
  db: Db,
  storage: ObjectStorage,
  viewer: Viewer,
  target: AssetTarget,
  file: Uint8Array,
  fileName: string,
  /** GIF-er fra søket, så de kan finnes igjen (`gifs.ts`). */
  gif?: { id: string; title: string },
): Promise<AssetView> {
  // Før den tunge jobben, så manglende tilgang eller en full kvote ikke koster en bildebehandling.
  await assertCanUpload(db, viewer, target)
  assertMember(viewer)
  const admin = can(viewer, 'profiles.edit')
  await assertQuota(db, viewer, file.byteLength, admin)
  if (file.byteLength > ASSET_MAX_BYTES) {
    throw new DomainError(`Fila er for stor. Maks ${ASSET_MAX_BYTES / 1024 / 1024} MB.`)
  }
  const sniffed = sniffFile(file, fileName)
  if (target.purpose === 'event_photo' && sniffed.kind !== 'image') {
    throw new DomainError('Albumet tar bare bilder i JPEG, PNG, WebP eller GIF.')
  }

  const fileKey = newImageKey()
  const prefix = PREFIXES[target.purpose]
  let files: { key: string; body: Uint8Array; contentType: string }[]
  let values: Pick<
    typeof asset.$inferInsert,
    'kind' | 'contentType' | 'originalName' | 'width' | 'height' | 'storageKeys'
  >
  if (sniffed.kind === 'image') {
    const processed = await processAssetImage(file)
    files = imageSizes.map((size) => ({
      key: `${prefix}${fileKey}-${ASSET_IMAGE_SIZES[size]}.webp`,
      body: processed[size],
      contentType: IMAGE_CONTENT_TYPE,
    }))
    values = {
      kind: 'image',
      contentType: IMAGE_CONTENT_TYPE,
      originalName: safeFileName(fileName, 'webp', 'bilde'),
      width: processed.width,
      height: processed.height,
      storageKeys: Object.fromEntries(
        imageSizes.map((size, i) => [String(ASSET_IMAGE_SIZES[size]), files[i]!.key]),
      ),
    }
  } else {
    files = [
      {
        key: `${prefix}${fileKey}.${sniffed.extension}`,
        body: file,
        contentType: sniffed.contentType,
      },
    ]
    values = {
      kind: 'document',
      contentType: sniffed.contentType,
      originalName: safeFileName(fileName, sniffed.extension, 'dokument'),
      width: null,
      height: null,
      storageKeys: { original: files[0]!.key },
    }
  }
  const sha256 = createHash('sha256').update(file).digest('hex')

  // Filene lagres før databasen peker på dem, så en fil aldri mangler.
  await putImageFiles(storage, files, label(fileKey))
  try {
    const row = await db.transaction(async (tx) => {
      // Én opplasting om gangen per person, så grensen holder også når flere sendes samtidig.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`asset:${viewer.personId}`}))`)
      // Sjekkes på nytt under lås: tilgangen kan ha endret seg mens fila ble behandlet.
      const { audit } = await assertCanUpload(tx, viewer, target, { lock: true })
      await assertQuota(tx, viewer, file.byteLength, admin)
      const position = (await assertRoom(tx, target)) ?? 0
      const attached = target.purpose !== 'post' && target.purpose !== 'comment'
      const [created] = await tx
        .insert(asset)
        .values({
          ...values,
          gifId: gif?.id ?? null,
          gifTitle: gif?.title ?? null,
          fileKey,
          ownerPersonId: viewer.personId,
          purpose: target.purpose,
          eventId: 'eventId' in target ? target.eventId : null,
          companyId: 'companyId' in target ? target.companyId : null,
          position,
          byteSize: file.byteLength,
          sha256,
          attachedAt: attached ? new Date() : null,
        })
        .returning()
      if (audit) {
        await tx.insert(auditEvent).values({
          actorPersonId: viewer.personId,
          action: audit.action,
          details: { ...audit.details, assetId: created!.id, file: created!.originalName },
        })
      }
      return created!
    })
    const [me] = await db
      .select({ fullName: person.fullName })
      .from(person)
      .where(eq(person.id, viewer.personId))
    return toView(row, { personId: viewer.personId, fullName: me?.fullName ?? '' }, viewer, true)
  } catch (error) {
    await deleteImageFiles(
      storage,
      files.map((f) => f.key),
      label(fileKey),
    )
    throw error
  }
}

// ---------------------------------------------------------------------------
// Feste til innlegg og kommentarer
// ---------------------------------------------------------------------------

export type AttachmentParent = { postId: string } | { commentId: string }

/**
 * Setter vedleggene til et innlegg eller en kommentar til nøyaktig `assetIds`, i
 * den rekkefølgen. Nye må være lastet opp av den innloggede til samme slags
 * forelder og ikke festet til noe annet. Vedlegg som ikke er med lenger, slettes;
 * filene fjernes av `purgeAssets` etter transaksjonen. Gir om noe ble endret, og
 * hvilke filer som skal fjernes fra lagringen.
 */
export async function attachAssets(
  tx: Tx,
  viewer: { personId: string },
  parent: AttachmentParent,
  assetIds: string[],
): Promise<{ changed: boolean; removed: PurgeTarget[] }> {
  const ids = [...new Set(assetIds)]
  if (ids.length > MAX_ATTACHMENTS) {
    throw new DomainError(`Maks ${MAX_ATTACHMENTS} vedlegg.`)
  }
  const purpose = 'postId' in parent ? 'post' : 'comment'
  const column = 'postId' in parent ? asset.postId : asset.commentId
  const parentId = 'postId' in parent ? parent.postId : parent.commentId

  const current = await tx
    .select({ id: asset.id, position: asset.position, storageKeys: asset.storageKeys })
    .from(asset)
    .where(and(eq(column, parentId), isNull(asset.deletedAt)))
    .orderBy(asc(asset.position))
    .for('update')
  const wanted = ids.length
    ? await tx.select().from(asset).where(inArray(asset.id, ids)).for('update')
    : []
  for (const id of ids) {
    const row = wanted.find((w) => w.id === id)
    const own = row?.[purpose === 'post' ? 'postId' : 'commentId']
    if (
      !row ||
      row.deletedAt ||
      row.ownerPersonId !== viewer.personId ||
      row.purpose !== purpose ||
      (own === null ? row.attachedAt !== null : own !== parentId)
    ) {
      throw new DomainError('Et av vedleggene finnes ikke lenger. Last det opp på nytt.')
    }
  }

  const removed = current.filter((c) => !ids.includes(c.id))
  if (removed.length) {
    await tx
      .update(asset)
      .set({ deletedAt: new Date() })
      .where(
        inArray(
          asset.id,
          removed.map((r) => r.id),
        ),
      )
  }
  const before = current.map((c) => c.id).join()
  const link = purpose === 'post' ? { postId: parentId } : { commentId: parentId }
  for (const [position, id] of ids.entries()) {
    await tx
      .update(asset)
      .set({ ...link, attachedAt: sql`coalesce(${asset.attachedAt}, now())`, position })
      .where(eq(asset.id, id))
  }
  return { changed: before !== ids.join(), removed }
}

/** Sletter vedleggene til innlegg, kommentarer, arrangementer eller selskaper. Gir dem som skal fjernes fra lagringen. */
export async function deleteAssetsOf(
  tx: Tx,
  parents: { postIds?: string[]; commentIds?: string[]; eventId?: string; companyId?: string },
): Promise<PurgeTarget[]> {
  const conditions: SQL[] = []
  if (parents.postIds?.length) conditions.push(inArray(asset.postId, parents.postIds))
  if (parents.commentIds?.length) conditions.push(inArray(asset.commentId, parents.commentIds))
  if (parents.eventId) conditions.push(eq(asset.eventId, parents.eventId))
  if (parents.companyId) conditions.push(eq(asset.companyId, parents.companyId))
  if (!conditions.length) return []
  return tx
    .update(asset)
    .set({ deletedAt: new Date() })
    .where(and(isNull(asset.deletedAt), or(...conditions)))
    .returning({ id: asset.id, storageKeys: asset.storageKeys })
}

// ---------------------------------------------------------------------------
// Sletting og opprydding
// ---------------------------------------------------------------------------

/**
 * En moderator har fjernet disse filene. Er noen av dem GIF-er fra søket, skal de
 * ikke kunne velges fra de lagrede GIF-ene igjen, heller ikke fra andres kopier.
 */
export async function forgetGifs(tx: Tx, assetIds: string[]) {
  if (!assetIds.length) return
  const rows = await tx
    .select({ gifId: asset.gifId })
    .from(asset)
    .where(and(inArray(asset.id, assetIds), isNotNull(asset.gifId)))
  const ids = rows.flatMap((r) => r.gifId ?? [])
  if (ids.length) {
    await tx.update(asset).set({ gifId: null, gifTitle: null }).where(inArray(asset.gifId, ids))
  }
}

export type PurgeTarget = { id: string; storageKeys: Record<string, string> }

/**
 * Sletter filene fra lagringen og merker radene. Det som ikke lot seg slette,
 * prøves igjen av `cleanupAssets`. Kaster aldri: feil logges.
 */
export async function purgeAssets(db: Db, storage: ObjectStorage, targets: PurgeTarget[]) {
  const done: string[] = []
  for (const target of targets) {
    const results = await Promise.allSettled(
      Object.values(target.storageKeys).map((key) => storage.delete(key)),
    )
    const failed = results.find((r) => r.status === 'rejected')
    if (failed) {
      console.error(`[esaf/core] Kunne ikke slette ${label(target.id)}:`, failed.reason)
    } else {
      done.push(target.id)
    }
  }
  if (done.length) {
    try {
      await db.update(asset).set({ purgedAt: new Date() }).where(inArray(asset.id, done))
    } catch (error) {
      console.error('[esaf/core] Kunne ikke merke vedlegg som fjernet:', error)
    }
  }
  return done.length
}

/** Hvem som kan fjerne en fil, utover den som lastet den opp. */
async function canRemoveOthers(
  db: Db | Tx,
  viewer: NonNullable<Viewer> & { personId: string },
  row: AssetRow,
) {
  if (can(viewer, 'content.moderate')) return true
  if (row.purpose === 'event_document' && row.eventId) {
    if (can(viewer, 'profiles.edit')) return true
    const { role } = await eventRole(db, row.eventId, viewer.personId, false)
    return role === 'organizer'
  }
  if (row.purpose === 'company_document' && row.companyId) {
    try {
      await companyForEdit(db, viewer, row.companyId)
      return true
    } catch (error) {
      if (error instanceof AccessDeniedError || error instanceof NotFoundError) return false
      throw error
    }
  }
  return false
}

/**
 * Sletter en fil. Den som lastet den opp, kan alltid; moderatorer og admins kan
 * fjerne alle, arrangører og admins dokumentene på arrangementet, og de som kan
 * redigere et selskap, dokumentene der. Fjerner noen andres fil, logges det
 * (`content.remove_attachment`).
 */
export async function removeAsset(
  db: Db,
  storage: ObjectStorage,
  viewer: Viewer,
  assetId: string,
): Promise<void> {
  assertMember(viewer)
  const removed = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(asset)
      .where(and(eq(asset.id, assetId), isNull(asset.deletedAt)))
      .for('update')
    if (!row || !(await visible(tx, viewer, row))) throw new NotFoundError('Fant ikke fila.')
    const own = row.ownerPersonId === viewer.personId
    if (!own && !(await canRemoveOthers(tx, viewer, row))) {
      // Rollen er der, men økten er ikke sterk nok: si det. Ellers er svaret nei.
      assertCan(viewer, 'content.moderate')
      throw new AccessDeniedError('forbidden')
    }
    await tx.update(asset).set({ deletedAt: new Date() }).where(eq(asset.id, row.id))
    if (!own) {
      await forgetGifs(tx, [row.id])
      await tx.insert(auditEvent).values({
        actorPersonId: viewer.personId,
        action: 'content.remove_attachment',
        subjectPersonId: row.ownerPersonId,
        details: {
          assetId: row.id,
          purpose: row.purpose,
          file: row.originalName,
          postId: row.postId,
          commentId: row.commentId,
          eventId: row.eventId,
          companyId: row.companyId,
        },
      })
    }
    return row
  })
  await purgeAssets(db, storage, [removed])
}

/**
 * Rydder i vedleggene: filer som aldri ble festet til noe (eldre enn et døgn),
 * filer der forelderen er slettet, og filer som er slettet, men ikke fjernet fra
 * lagringen (for eksempel fordi lagringen svarte med feil). Kjøres jevnlig av
 * appen. Gir hvor mange som ble merket og fjernet.
 */
export async function cleanupAssets(
  db: Db,
  storage: ObjectStorage,
  { now = new Date(), batch = 200 } = {},
): Promise<{ deleted: number; purged: number }> {
  const cutoff = new Date(now.getTime() - ORPHAN_AFTER_MS)
  const noParent = and(
    isNull(asset.postId),
    isNull(asset.commentId),
    isNull(asset.eventId),
    isNull(asset.companyId),
  )
  const deleted = await db
    .update(asset)
    .set({ deletedAt: now })
    .where(
      and(
        isNull(asset.deletedAt),
        or(
          // Aldri festet, eller forelderen er slettet (nøkkelen er satt til null).
          and(noParent, or(isNotNull(asset.attachedAt), lt(asset.createdAt, cutoff))),
          // Innlegg og kommentarer slettes mykt; vedleggene skal ikke bli liggende.
          inArray(
            asset.postId,
            db.select({ id: post.id }).from(post).where(isNotNull(post.deletedAt)),
          ),
          inArray(
            asset.commentId,
            db
              .select({ id: comment.id })
              .from(comment)
              .innerJoin(post, eq(post.id, comment.postId))
              .where(or(isNotNull(comment.deletedAt), isNotNull(post.deletedAt))),
          ),
        ),
      ),
    )
    .returning({ id: asset.id })
  const pending = await db
    .select({ id: asset.id, storageKeys: asset.storageKeys })
    .from(asset)
    .where(and(isNotNull(asset.deletedAt), isNull(asset.purgedAt)))
    .orderBy(asc(asset.deletedAt))
    .limit(batch)
  const purged = await purgeAssets(db, storage, pending)
  return { deleted: deleted.length, purged }
}

// ---------------------------------------------------------------------------
// Lesing
// ---------------------------------------------------------------------------

/**
 * Om den innloggede kan se fila: forelderen finnes og er ikke slettet. Filer uten
 * forelder ser bare den som lastet dem opp.
 */
async function visible(db: Db | Tx, viewer: { personId: string }, row: AssetRow) {
  if (row.postId) {
    const [p] = await db
      .select({ id: post.id })
      .from(post)
      .where(and(eq(post.id, row.postId), isNull(post.deletedAt)))
    return Boolean(p)
  }
  if (row.commentId) {
    const [c] = await db
      .select({ id: comment.id })
      .from(comment)
      .innerJoin(post, eq(post.id, comment.postId))
      .where(and(eq(comment.id, row.commentId), isNull(comment.deletedAt), isNull(post.deletedAt)))
    return Boolean(c)
  }
  if (row.eventId || row.companyId) return true
  // Uten forelder: bare en fil som venter på å bli festet, og bare for den som lastet
  // den opp. Var den festet før, er forelderen slettet, og fila skal ryddes bort.
  return row.attachedAt === null && row.ownerPersonId === viewer.personId
}

export type AssetFile = {
  body: Uint8Array
  kind: AssetKind
  contentType: string
  fileName: string
}

/**
 * Fila bak en adresse fra `AssetView`, for aktive medlemmer. Slettede filer, og
 * filer der innlegget eller kommentaren er slettet, finnes ikke.
 */
export async function readAsset(
  db: Db,
  storage: ObjectStorage,
  viewer: Viewer,
  name: string,
): Promise<AssetFile> {
  assertMember(viewer)
  const match = ASSET_FILE_NAME.exec(name)
  if (!match) throw new NotFoundError('Fant ikke fila.')
  const [, fileKey, size] = match
  const [row] = await db
    .select()
    .from(asset)
    .where(and(eq(asset.fileKey, fileKey!), isNull(asset.deletedAt)))
  const variant = row?.kind === 'image' ? size : size === undefined ? 'original' : undefined
  const key = variant ? row?.storageKeys[variant] : undefined
  if (!row || !key || !(await visible(db, viewer, row))) throw new NotFoundError('Fant ikke fila.')
  const body = await storage.get(key)
  if (!body) throw new NotFoundError('Fant ikke fila.')
  return { body, kind: row.kind, contentType: row.contentType, fileName: row.originalName }
}

/**
 * Svaret med en fil. Bilder vises i siden og kan mellomlagres lenge i
 * nettleseren (hver variant har sin egen adresse og endres aldri). Dokumenter
 * lastes alltid ned, og mellomlagres ikke. Begge får `nosniff`, så nettleseren
 * aldri gjetter en annen type, og en CSP med `sandbox`, så selv en fil som
 * åpnes direkte, aldri kan kjøre skript eller vises som en side fra appen.
 */
export function assetHeaders(
  file: Omit<AssetFile, 'body'>,
  byteLength: number,
): Record<string, string> {
  const image = file.kind === 'image'
  return {
    'content-type': file.contentType,
    'content-length': String(byteLength),
    'content-disposition': contentDisposition(image ? 'inline' : 'attachment', file.fileName),
    'cache-control': image ? 'private, max-age=31536000, immutable' : 'private, no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox; frame-ancestors 'none'",
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
  }
}

/**
 * Filene til innlegg, kommentarer, et arrangement eller et selskap, i
 * rekkefølgen de står i. `canRemove` avgjør om den innloggede kan fjerne en fil
 * de ikke lastet opp selv.
 */
export async function loadAssets(
  db: Db | Tx,
  viewer: { personId: string },
  parents: { postIds?: string[]; commentIds?: string[]; eventId?: string; companyId?: string },
  canRemove: (row: AssetRow) => boolean = () => false,
): Promise<(AssetView & { parentId: string; purpose: AssetPurpose })[]> {
  const conditions: SQL[] = []
  if (parents.postIds?.length) conditions.push(inArray(asset.postId, parents.postIds))
  if (parents.commentIds?.length) conditions.push(inArray(asset.commentId, parents.commentIds))
  if (parents.eventId) conditions.push(eq(asset.eventId, parents.eventId))
  if (parents.companyId) conditions.push(eq(asset.companyId, parents.companyId))
  if (!conditions.length) return []
  const rows = await db
    .select({ asset, fullName: person.fullName })
    .from(asset)
    .leftJoin(person, eq(person.id, asset.ownerPersonId))
    .where(and(isNull(asset.deletedAt), or(...conditions)))
    .orderBy(asc(asset.position), asc(asset.createdAt))
  return rows.map(({ asset: row, fullName }) => ({
    ...toView(
      row,
      row.ownerPersonId && fullName ? { personId: row.ownerPersonId, fullName } : null,
      viewer,
      row.ownerPersonId === viewer.personId || canRemove(row),
    ),
    parentId: (row.postId ?? row.commentId ?? row.eventId ?? row.companyId)!,
    purpose: row.purpose,
  }))
}

/** Grupperer filene fra `loadAssets` per forelder, uten de interne feltene. */
export function groupAssets(
  rows: (AssetView & { parentId: string; purpose: AssetPurpose })[],
): Map<string, AssetView[]> {
  const groups = new Map<string, AssetView[]>()
  for (const { parentId, purpose: _purpose, ...view } of rows) {
    groups.set(parentId, [...(groups.get(parentId) ?? []), view])
  }
  return groups
}

/** Bare filene, uten de interne feltene fra `loadAssets`. */
export const assetViews = (rows: (AssetView & { parentId: string; purpose: AssetPurpose })[]) =>
  rows.map(({ parentId: _parentId, purpose: _purpose, ...view }) => view)
