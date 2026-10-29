import { schema, type CompanyEventType, type Db, type DatePrecision } from '@esaf/db'
import { and, desc, eq, ne } from 'drizzle-orm'
import { z } from 'zod'
import type { Viewer } from './access.ts'
import { companyForEdit } from './companies.ts'
import { DomainError, NotFoundError } from './errors.ts'
import type { Tx } from './members.ts'
import { hostLabel, optionalSourceUrl, optionalText, safeHttpUrl } from './validation.ts'

const { auditEvent, companyEvent } = schema

/**
 * Historikken til et selskap. Reglene:
 *
 * - De samme som kan redigere selskapsinfoen, kan legge til, rette og slette
 *   hendelser: gründere (også tidligere), ES-teamet, de som jobber der nå og
 *   admins med `profiles.edit`. Admins som ikke selv er knyttet til selskapet,
 *   logges, som ved annen redigering.
 * - Hendelser med lav sikkerhet (typisk setninger hentet automatisk fra
 *   nyhetssaker) vises bare for dem som kan redigere selskapet, merket «til
 *   gjennomgang». Lagres en hendelse i appen, regnes den som bekreftet (`high`).
 */

export const companyEventTypes = schema.companyEventType.enumValues

const collapseSpaces = (v: string) => v.replace(/\s+/g, ' ')

const pad = (n: number) => String(n).padStart(2, '0')

/** Felles validering av en hendelse, brukt av webappen og senere MCP. */
export const companyEventInput = z
  .object({
    year: z
      .number()
      .int()
      .min(1800, 'Ugyldig årstall.')
      .refine((y) => y <= new Date().getFullYear() + 1, 'Årstallet er for langt fram i tid.'),
    /** 1–12. Uten måned vises bare året. */
    month: z.number().int().min(1).max(12).nullable(),
    /** Krever måned. Uten dag vises måned og år. */
    day: z.number().int().min(1).max(31).nullable(),
    type: z.enum(companyEventTypes),
    text: z
      .string()
      .trim()
      .min(1, 'Skriv hva som skjedde.')
      .max(500, 'Maks 500 tegn.')
      .transform(collapseSpaces),
    sourceUrl: optionalSourceUrl,
    sourceLabel: optionalText(80),
  })
  .refine((e) => e.day === null || e.month !== null, {
    message: 'Velg måned når du oppgir dag.',
  })
  .refine(
    (e) => e.day === null || new Date(Date.UTC(e.year, e.month! - 1, e.day)).getUTCDate() === e.day,
    { message: 'Datoen finnes ikke.' },
  )

export type CompanyEventInput = z.input<typeof companyEventInput>

/** En hendelse slik den vises på selskapssiden. */
export type CompanyEvent = {
  id: string
  /** `YYYY-MM-DD`. Bare delen `datePrecision` sier, er kjent. */
  date: string
  datePrecision: DatePrecision
  type: CompanyEventType
  text: string
  source: { label: string; url: string | null } | null
  /** Usikker hendelse som bare de som kan redigere, ser. */
  review: boolean
}

function dateFields(values: z.output<typeof companyEventInput>) {
  const precision: DatePrecision = values.day ? 'day' : values.month ? 'month' : 'year'
  return {
    date: `${values.year}-${pad(values.month ?? 1)}-${pad(values.day ?? 1)}`,
    datePrecision: precision,
  }
}

/** Uten eget navn på kilden brukes domenet i lenken. */
function sourceFields(values: z.output<typeof companyEventInput>) {
  return {
    sourceUrl: values.sourceUrl,
    sourceLabel: values.sourceLabel ?? hostLabel(values.sourceUrl),
  }
}

/** Kolonnene for en validert hendelse (uten selskap og sikkerhet). */
export function eventValues(values: z.output<typeof companyEventInput>) {
  return {
    ...dateFields(values),
    ...sourceFields(values),
    type: values.type,
    text: values.text,
  }
}

/**
 * Hendelsene til et selskap, nyeste først. `includeReview` tar med de usikre;
 * det skal bare de som kan redigere selskapet, få.
 */
export async function loadCompanyEvents(
  db: Db,
  companyId: string,
  { includeReview }: { includeReview: boolean },
): Promise<CompanyEvent[]> {
  const rows = await db
    .select()
    .from(companyEvent)
    .where(
      and(
        eq(companyEvent.companyId, companyId),
        includeReview ? undefined : ne(companyEvent.confidence, 'low'),
      ),
    )
    .orderBy(desc(companyEvent.date), desc(companyEvent.createdAt))
  return rows.map((r) => {
    const url = safeHttpUrl(r.sourceUrl)
    const label = r.sourceLabel ?? hostLabel(url)
    return {
      id: r.id,
      date: r.date,
      datePrecision: r.datePrecision,
      type: r.type,
      text: r.text,
      source: label ? { label, url } : null,
      review: r.confidence === 'low',
    }
  })
}

function parse(input: CompanyEventInput) {
  const parsed = companyEventInput.safeParse(input)
  if (!parsed.success) throw new DomainError(parsed.error.issues[0]?.message ?? 'Ugyldige felt.')
  return parsed.data
}

async function lockEvent(tx: Tx, eventId: string) {
  const [row] = await tx
    .select({ id: companyEvent.id, companyId: companyEvent.companyId, type: companyEvent.type })
    .from(companyEvent)
    .where(eq(companyEvent.id, eventId))
    .for('update')
  if (!row) throw new NotFoundError('Fant ikke hendelsen.')
  return row
}

async function logAdminChange(
  tx: Tx,
  viewer: Viewer,
  action:
    | 'company.admin_event_add'
    | 'company.admin_event_edit'
    | 'company.admin_event_confirm'
    | 'company.admin_event_remove',
  target: { id: string; slug: string; name: string },
  event: { id: string; type: CompanyEventType },
) {
  await tx.insert(auditEvent).values({
    actorPersonId: viewer!.personId,
    action,
    details: {
      companyId: target.id,
      slug: target.slug,
      name: target.name,
      eventId: event.id,
      type: event.type,
    },
  })
}

/** Legger til en hendelse i historien til selskapet. */
export async function addCompanyEvent(
  db: Db,
  viewer: Viewer,
  companyId: string,
  input: CompanyEventInput,
): Promise<{ id: string }> {
  const values = parse(input)
  return db.transaction(async (tx) => {
    const target = await companyForEdit(tx, viewer, companyId, { lock: true })
    const [row] = await tx
      .insert(companyEvent)
      .values({
        companyId,
        ...dateFields(values),
        ...sourceFields(values),
        type: values.type,
        text: values.text,
        confidence: 'high',
      })
      .returning({ id: companyEvent.id })
    if (target.adminEdit) {
      await logAdminChange(tx, viewer, 'company.admin_event_add', target, {
        id: row!.id,
        type: values.type,
      })
    }
    return { id: row!.id }
  })
}

/** Retter en hendelse. Den regnes da som bekreftet, også om den var til gjennomgang. */
export async function updateCompanyEvent(
  db: Db,
  viewer: Viewer,
  eventId: string,
  input: CompanyEventInput,
): Promise<void> {
  const values = parse(input)
  await db.transaction(async (tx) => {
    const event = await lockEvent(tx, eventId)
    const target = await companyForEdit(tx, viewer, event.companyId)
    await tx
      .update(companyEvent)
      .set({
        ...dateFields(values),
        ...sourceFields(values),
        type: values.type,
        text: values.text,
        confidence: 'high',
      })
      .where(eq(companyEvent.id, eventId))
    if (target.adminEdit) {
      await logAdminChange(tx, viewer, 'company.admin_event_edit', target, {
        id: eventId,
        type: values.type,
      })
    }
  })
}

/** Sletter en hendelse. */
export async function deleteCompanyEvent(db: Db, viewer: Viewer, eventId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const event = await lockEvent(tx, eventId)
    const target = await companyForEdit(tx, viewer, event.companyId)
    await tx.delete(companyEvent).where(eq(companyEvent.id, eventId))
    if (target.adminEdit) {
      await logAdminChange(tx, viewer, 'company.admin_event_remove', target, event)
    }
  })
}

/**
 * «Stemmer»: en usikker hendelse regnes som bekreftet og vises for alle, uten at
 * noe annet endres. Samme tilgang som redigering.
 */
export async function confirmCompanyEvent(db: Db, viewer: Viewer, eventId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const event = await lockEvent(tx, eventId)
    const target = await companyForEdit(tx, viewer, event.companyId)
    const updated = await tx
      .update(companyEvent)
      .set({ confidence: 'high' })
      .where(and(eq(companyEvent.id, eventId), eq(companyEvent.confidence, 'low')))
      .returning({ id: companyEvent.id })
    if (!updated.length) throw new DomainError('Hendelsen er allerede bekreftet.')
    if (target.adminEdit) {
      await logAdminChange(tx, viewer, 'company.admin_event_confirm', target, event)
    }
  })
}
