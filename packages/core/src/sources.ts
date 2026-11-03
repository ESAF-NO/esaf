import { schema, type Db, type FieldSourceEntity, type SourceConfidence } from '@esaf/db'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { AccessDeniedError, DomainError, NotFoundError } from './errors.ts'
import { assertCan, assertMember, can, type Viewer } from './access.ts'
import type { Tx } from './members.ts'
import { hostLabel, optionalSourceUrl, optionalText, safeHttpUrl } from './validation.ts'

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
 * Felt som er lister (flere jobber, emner, bransjer). Kilden gjelder hele lista,
 * så når en admin endrer én oppføring, gjelder den fortsatt resten.
 */
const listFields: ReadonlySet<string> = new Set(['experience', 'expertise', 'industries'])

/**
 * Etter en redigering. `confirm`: eieren (eller noen knyttet til selskapet) har
 * skrevet om feltene, og kildene merkes som bekreftet. `forget`: en admin har
 * endret feltene, eller de er tømt, så kildene gjelder ikke lenger og slettes.
 * Unntaket er lister: der beholdes kilden for resten av oppføringene, og den
 * regnes som sett over, siden en admin nettopp har gått gjennom lista.
 */
export async function recordFieldEdits(
  tx: Db | Tx,
  entityType: FieldSourceEntity,
  entityId: string,
  fields: readonly string[],
  effect: 'confirm' | 'forget',
) {
  if (!fields.length) return
  const where = (only: readonly string[]) =>
    and(
      eq(fieldSource.entityType, entityType),
      eq(fieldSource.entityId, entityId),
      inArray(fieldSource.field, [...only]),
    )
  if (effect === 'confirm') {
    await tx
      .update(fieldSource)
      .set({ confirmedAt: new Date() })
      .where(and(where(fields), isNull(fieldSource.confirmedAt)))
    return
  }
  const lists = fields.filter((f) => listFields.has(f))
  const single = fields.filter((f) => !listFields.has(f))
  if (single.length) await tx.delete(fieldSource).where(where(single))
  if (lists.length) {
    await tx
      .update(fieldSource)
      .set({ reviewedAt: new Date() })
      .where(and(where(lists), isNull(fieldSource.reviewedAt)))
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
 * Når to selskaper eller personer slås sammen: kildene for feltene som hentes fra
 * duplikatet, flyttes med. Resten slettes sammen med duplikatet.
 */
export async function moveFieldSources(
  tx: Tx,
  entityType: FieldSourceEntity,
  sourceId: string,
  targetId: string,
  fields: readonly string[],
) {
  const fromSource = and(eq(fieldSource.entityType, entityType), eq(fieldSource.entityId, sourceId))
  if (fields.length) {
    // Kilder målet allerede har for samme felt og kilde, beholdes.
    const existing = await tx
      .select({ field: fieldSource.field, label: fieldSource.sourceLabel })
      .from(fieldSource)
      .where(and(eq(fieldSource.entityType, entityType), eq(fieldSource.entityId, targetId)))
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

export const moveCompanySources = (
  tx: Tx,
  sourceId: string,
  targetId: string,
  fields: readonly string[],
) => moveFieldSources(tx, 'company', sourceId, targetId, fields)

/** Kildene til noen felt på én person eller ett selskap, når verdien byttes ut. */
export async function deleteFieldSourcesFor(
  tx: Tx,
  entityType: FieldSourceEntity,
  entityId: string,
  fields: readonly string[],
) {
  if (!fields.length) return
  await tx
    .delete(fieldSource)
    .where(
      and(
        eq(fieldSource.entityType, entityType),
        eq(fieldSource.entityId, entityId),
        inArray(fieldSource.field, [...fields]),
      ),
    )
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

/** En kilde en admin legger til for et felt, f.eks. etter å ha funnet informasjonen på nett. */
export const fieldSourceInput = z
  .object({
    field: z.string(),
    /** Kilden slik den skal vises. Uten navn brukes domenet i lenken. */
    label: optionalText(80).default(null),
    url: optionalSourceUrl.default(null),
    confidence: z.enum(schema.sourceConfidence.enumValues),
    /** Når informasjonen ble hentet. Standard nå. */
    fetchedAt: z.coerce.date().optional(),
  })
  .refine((s) => s.label !== null || s.url !== null, {
    message: 'En kilde må ha et navn eller en lenke.',
  })

export type FieldSourceInput = z.input<typeof fieldSourceInput>

/**
 * Skriver kildene i en transaksjon som allerede er i gang. Finnes samme kilde
 * (felt og navn) fra før, får den ny lenke, tidspunkt og sikkerhet, men en
 * bekreftelse fra eieren beholdes. `reviewed` tar feltene ut av Gjennomgang.
 * Rettighetene og at personen eller selskapet finnes, må være sjekket.
 */
export async function writeFieldSources(
  tx: Tx,
  entityType: FieldSourceEntity,
  entityId: string,
  sources: z.output<typeof fieldSourceInput>[],
  { reviewed = false }: { reviewed?: boolean } = {},
): Promise<string[]> {
  const allowed: readonly string[] =
    entityType === 'person' ? profileSourceFields : companySourceFields
  for (const s of sources) {
    if (!allowed.includes(s.field)) {
      throw new DomainError(
        `Feltet «${s.field}» kan ikke ha kilde. Gyldige felt: ${allowed.join(', ')}.`,
      )
    }
  }
  const now = new Date()
  for (const s of sources) {
    const label = s.label ?? hostLabel(s.url)!
    await tx
      .insert(fieldSource)
      .values({
        entityType,
        entityId,
        field: s.field,
        sourceLabel: label,
        sourceUrl: s.url,
        fetchedAt: s.fetchedAt ?? now,
        confidence: s.confidence,
        reviewedAt: reviewed ? now : null,
      })
      .onConflictDoUpdate({
        target: [
          fieldSource.entityType,
          fieldSource.entityId,
          fieldSource.field,
          fieldSource.sourceLabel,
        ],
        set: {
          sourceUrl: s.url,
          fetchedAt: s.fetchedAt ?? now,
          confidence: s.confidence,
          ...(reviewed ? { reviewedAt: now } : {}),
        },
      })
  }
  return [...new Set(sources.map((s) => s.field))]
}

/**
 * Legger til kilder for felt på en profil eller et selskap, så medlemmene ser
 * hvor informasjonen kom fra («Fra proff.no · ikke bekreftet») og eieren kan
 * bekrefte den. Bare admins med `profiles.edit`. Kontaktinfo kan aldri ha kilde.
 * Logges som `source.add`.
 */
export async function addFieldSources(
  db: Db | Tx,
  viewer: Viewer,
  input: {
    entityType: FieldSourceEntity
    entityId: string
    sources: FieldSourceInput[]
    reviewed?: boolean
  },
): Promise<{ fields: string[] }> {
  assertCan(viewer, 'profiles.edit')
  const parsed = z.array(fieldSourceInput).min(1).max(30).safeParse(input.sources)
  if (!parsed.success) throw new DomainError(parsed.error.issues[0]?.message ?? 'Ugyldig kilde.')
  return db.transaction(async (tx) => {
    const table = input.entityType === 'person' ? schema.person : schema.company
    const [row] = await tx
      .select({ id: table.id })
      .from(table)
      .where(eq(table.id, input.entityId))
      .for('update')
    if (!row) {
      throw new NotFoundError(
        input.entityType === 'person' ? 'Fant ikke personen.' : 'Fant ikke selskapet.',
      )
    }
    const fields = await writeFieldSources(tx, input.entityType, input.entityId, parsed.data, {
      reviewed: input.reviewed,
    })
    await tx.insert(schema.auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'source.add',
      subjectPersonId: input.entityType === 'person' ? input.entityId : null,
      details: {
        entityType: input.entityType,
        ...(input.entityType === 'company' ? { companyId: input.entityId } : {}),
        fields,
        labels: [...new Set(parsed.data.map((s) => s.label ?? hostLabel(s.url)))],
      },
    })
    return { fields }
  })
}
