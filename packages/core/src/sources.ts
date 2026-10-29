import { schema, type Db, type FieldSourceEntity, type SourceConfidence } from '@esaf/db'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { AccessDeniedError } from './errors.ts'
import { assertMember, can, type Viewer } from './access.ts'
import type { Tx } from './members.ts'
import { safeHttpUrl } from './validation.ts'

const { fieldSource } = schema

/**
 * Kilder for importerte felt. Reglene:
 *
 * - Bare felt andre medlemmer kan se, har kilder i appen. Kontaktinfo (e-post og
 *   telefon) er aldri med, heller ikke når en import har lagt inn kilder for den:
 *   kilden skal ikke røpe at noe skjult finnes.
 * - Medlemmer ser hvor feltet kom fra og om det er bekreftet. Hvor sikker kilden
 *   er (`confidence`), ser bare admins med `profiles.edit`.
 * - Eieren av profilen bekrefter et felt ved å skrive det om eller trykke
 *   «Stemmer». Retter en admin feltet, gjelder ikke kilden lenger, og den
 *   fjernes (endringen står i revisjonsloggen). For selskaper gjelder det samme:
 *   de som er knyttet til selskapet bekrefter, admins erstatter.
 */

/** Felt på profilen som kan ha kilde, i samme rekkefølge som på profilsiden. */
export const profileSourceFields = [
  'photo',
  'bio',
  'experience',
  'expertise',
  'industries',
  'esCompany',
  'studyBackground',
  'city',
  'linkedinUrl',
] as const
export type ProfileSourceField = (typeof profileSourceFields)[number]

/** Felt på selskapssiden som kan ha kilde, i samme rekkefølge som på siden. */
export const companySourceFields = [
  'name',
  'logo',
  'tagline',
  'description',
  'status',
  'lastSeenOnEsSite',
  'foundedYear',
  'location',
  'website',
  'industries',
] as const
export type CompanySourceField = (typeof companySourceFields)[number]

export type FieldSource<F extends string = string> = {
  field: F
  /** Kilden slik den vises, f.eks. «entreprenorskolen.no» eller «kullisten». */
  label: string
  /** Bare http- og https-lenker; ellers `null`. */
  url: string | null
  fetchedAt: Date | null
  /** Eieren (eller noen knyttet til selskapet) har bekreftet eller skrevet om feltet. */
  confirmed: boolean
  /** Hvor sikker kilden er. Bare for admins med `profiles.edit`, ellers `null`. */
  confidence: SourceConfidence | null
}

const confidenceOrder: Record<SourceConfidence, number> = { high: 0, medium: 1, low: 2 }

/**
 * Kildene for feltene som vises. `fields` er feltene som har en verdi på siden;
 * kilder for tomme eller skjulte felt sendes aldri.
 */
export async function loadFieldSources<F extends string>(
  db: Db,
  viewer: Viewer,
  entityType: FieldSourceEntity,
  entityId: string,
  fields: readonly F[],
): Promise<FieldSource<F>[]> {
  assertMember(viewer)
  if (!fields.length) return []
  const rows = await db
    .select()
    .from(fieldSource)
    .where(
      and(
        eq(fieldSource.entityType, entityType),
        eq(fieldSource.entityId, entityId),
        inArray(fieldSource.field, [...fields]),
      ),
    )
    .orderBy(asc(fieldSource.createdAt))
  const showConfidence = can(viewer, 'profiles.edit')
  const order = new Map(fields.map((f, i) => [f, i]))
  return rows
    .sort(
      (a, b) =>
        order.get(a.field as F)! - order.get(b.field as F)! ||
        confidenceOrder[a.confidence] - confidenceOrder[b.confidence],
    )
    .map((r) => ({
      field: r.field as F,
      label: r.sourceLabel,
      url: safeHttpUrl(r.sourceUrl),
      fetchedAt: r.fetchedAt,
      confirmed: r.confirmedAt !== null,
      confidence: showConfidence ? r.confidence : null,
    }))
}

/**
 * Etter en redigering. `confirm`: eieren (eller noen knyttet til selskapet) har
 * skrevet om feltene, og kildene merkes som bekreftet. `forget`: en admin har
 * endret feltene, eller de er tømt, så kildene gjelder ikke lenger og slettes.
 */
export async function recordFieldEdits(
  tx: Db | Tx,
  entityType: FieldSourceEntity,
  entityId: string,
  fields: readonly string[],
  effect: 'confirm' | 'forget',
) {
  if (!fields.length) return
  const where = and(
    eq(fieldSource.entityType, entityType),
    eq(fieldSource.entityId, entityId),
    inArray(fieldSource.field, [...fields]),
  )
  if (effect === 'confirm') {
    await tx
      .update(fieldSource)
      .set({ confirmedAt: new Date() })
      .where(and(where, isNull(fieldSource.confirmedAt)))
  } else {
    await tx.delete(fieldSource).where(where)
  }
}

/**
 * Eieren bekrefter at importerte felt på profilen stemmer. Uten `fields`
 * bekreftes alle. Bare eieren kan bekrefte; en admin kan ikke gjøre det for
 * andre. Gir antallet felt som ble bekreftet.
 */
export async function confirmProfileFields(
  db: Db,
  viewer: Viewer,
  personId: string,
  fields?: ProfileSourceField[],
): Promise<number> {
  assertMember(viewer)
  if (viewer.personId !== personId) throw new AccessDeniedError('forbidden')
  const wanted = fields ?? profileSourceFields
  if (!wanted.every((f) => (profileSourceFields as readonly string[]).includes(f))) {
    throw new AccessDeniedError('forbidden')
  }
  const confirmed = await db
    .update(fieldSource)
    .set({ confirmedAt: new Date() })
    .where(
      and(
        eq(fieldSource.entityType, 'person'),
        eq(fieldSource.entityId, personId),
        inArray(fieldSource.field, [...wanted]),
        isNull(fieldSource.confirmedAt),
      ),
    )
    .returning({ field: fieldSource.field })
  return new Set(confirmed.map((r) => r.field)).size
}

/**
 * Når et selskap slås sammen med et annet: kildene for feltene som hentes fra
 * duplikatet, flyttes med. Resten slettes sammen med duplikatet.
 */
export async function moveCompanySources(
  tx: Tx,
  sourceId: string,
  targetId: string,
  fields: readonly string[],
) {
  const fromSource = and(eq(fieldSource.entityType, 'company'), eq(fieldSource.entityId, sourceId))
  if (fields.length) {
    // Kilder målet allerede har for samme felt og kilde, beholdes.
    const existing = await tx
      .select({ field: fieldSource.field, label: fieldSource.sourceLabel })
      .from(fieldSource)
      .where(and(eq(fieldSource.entityType, 'company'), eq(fieldSource.entityId, targetId)))
    const taken = new Set(existing.map((r) => `${r.field}\n${r.label}`))
    const moving = await tx
      .select({ id: fieldSource.id, field: fieldSource.field, label: fieldSource.sourceLabel })
      .from(fieldSource)
      .where(and(fromSource, inArray(fieldSource.field, [...fields])))
    const ids = moving.filter((r) => !taken.has(`${r.field}\n${r.label}`)).map((r) => r.id)
    if (ids.length) {
      await tx.update(fieldSource).set({ entityId: targetId }).where(inArray(fieldSource.id, ids))
    }
  }
  await tx.delete(fieldSource).where(fromSource)
}

/** Kildene til personer eller selskaper som slettes. Radene har ingen fremmednøkkel som tar dem. */
export async function deleteFieldSources(
  tx: Db | Tx,
  entityType: FieldSourceEntity,
  entityIds: string[],
) {
  if (!entityIds.length) return
  await tx
    .delete(fieldSource)
    .where(and(eq(fieldSource.entityType, entityType), inArray(fieldSource.entityId, entityIds)))
}
