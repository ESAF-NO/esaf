import { schema, type Db, type EventDatePrecision } from '@esaf/db'
import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { assertCan, type Viewer } from './access.ts'
import { DomainError, NotFoundError } from './errors.ts'
import {
  eventPeriod,
  insertEvent,
  osloToday,
  periodEventName,
  periodStart,
  sameEventName,
  type EventPeriod,
} from './events.ts'
import type { Tx } from './members.ts'
import { optionalText } from './validation.ts'

const { auditEvent, event, eventType } = schema

/**
 * «Legg inn historikk»: mange gamle arrangementer av samme type på én gang, når
 * bare året (og kanskje semesteret) er kjent. Admin velger årene og hvor ofte
 * (én gang i året, hver vår, hver høst, eller vår og høst), ser en
 * forhåndsvisning, og oppretter. Navnet lages fra typen («ESAF-helgen høst
 * 2018»), og et navn som finnes for typen fra før, hoppes alltid over, så samme
 * valg to ganger gir ingen duplikater. Finnes det et annet arrangement av typen
 * i samme periode, merkes det, og admin velger selv.
 *
 * Krever `profiles.edit` (sterkt innlogget). Hvert arrangement logges som
 * `event.create` (`via: 'history'`), og hele innleggingen som `event.history`.
 */

/** Hvor ofte arrangementet ble holdt. */
export const historyFrequencies = ['year', 'autumn', 'spring', 'both'] as const
export type HistoryFrequency = (typeof historyFrequencies)[number]

const periodsOf: Record<HistoryFrequency, EventPeriod[]> = {
  year: ['year'],
  spring: ['spring'],
  autumn: ['autumn'],
  both: ['spring', 'autumn'],
}

/** Høyst så mange arrangementer på én gang. */
export const MAX_HISTORY_EVENTS = 100
/** Det tidligste året som kan legges inn. */
export const HISTORY_FIRST_YEAR = 1990

const year = z
  .number('Velg et år.')
  .int('Velg et år.')
  .min(HISTORY_FIRST_YEAR, `Tidligst ${HISTORY_FIRST_YEAR}.`)
  .max(2100, 'Ugyldig år.')

export const eventHistoryInput = z
  .object({
    typeId: z.uuid('Velg en type.'),
    fromYear: year,
    toYear: year,
    frequency: z.enum(historyFrequencies, 'Velg hvor ofte.'),
  })
  .refine((v) => v.fromYear <= v.toYear, { message: 'Fra-året kan ikke være etter til-året.' })
  .refine(
    (v) => (v.toYear - v.fromYear + 1) * periodsOf[v.frequency].length <= MAX_HISTORY_EVENTS,
    { message: `Høyst ${MAX_HISTORY_EVENTS} arrangementer på én gang.` },
  )

export type EventHistoryInput = z.input<typeof eventHistoryInput>

const periodItem = z.object({ year, period: z.enum(['year', 'spring', 'autumn']) })

export const eventHistoryCreateInput = z.object({
  typeId: z.uuid('Velg en type.'),
  items: z
    .array(periodItem)
    .min(1, 'Velg minst ett arrangement.')
    .max(MAX_HISTORY_EVENTS, `Høyst ${MAX_HISTORY_EVENTS} arrangementer på én gang.`),
  location: optionalText(120),
})

export type EventHistoryCreateInput = z.input<typeof eventHistoryCreateInput>

export type HistoryRowStatus =
  /** Lages. */
  | 'new'
  /** Et arrangement av typen har dette navnet allerede; hoppes alltid over. */
  | 'exists'
  /** Et annet arrangement av typen er i samme periode. Admin velger. */
  | 'overlap'
  /** Perioden har ikke startet ennå; historikk er det som har vært. */
  | 'future'

export type HistoryRow = {
  year: number
  period: EventPeriod
  name: string
  startDate: string
  datePrecision: EventDatePrecision
  status: HistoryRowStatus
  /** Arrangementet som har samme navn eller er i samme periode. */
  existing: {
    id: string
    name: string
    startDate: string
    endDate: string | null
    datePrecision: EventDatePrecision
  } | null
}

export type HistoryPreview = {
  type: { id: string; slug: string; name: string }
  /** Eldste først. */
  rows: HistoryRow[]
}

type Existing = NonNullable<HistoryRow['existing']>

async function loadType(db: Db | Tx, typeId: string) {
  const [type] = await db
    .select({ id: eventType.id, slug: eventType.slug, name: eventType.name })
    .from(eventType)
    .where(eq(eventType.id, typeId))
  if (!type) throw new NotFoundError('Fant ikke arrangementstypen.')
  return type
}

function loadEventsOfType(db: Db | Tx, typeId: string): Promise<Existing[]> {
  return db
    .select({
      id: event.id,
      name: event.name,
      startDate: event.startDate,
      endDate: event.endDate,
      datePrecision: event.datePrecision,
    })
    .from(event)
    .where(eq(event.typeId, typeId))
    .orderBy(asc(event.startDate))
}

/** Om et arrangement er i perioden: samme år, og samme semester når begge har et. */
function inPeriod(e: Existing, year: number, period: EventPeriod) {
  const p = eventPeriod(e)
  if (p.year !== year) return false
  return period === 'year' || p.season === null || p.season === period
}

/** Raden for én periode, sjekket mot arrangementene som finnes. Ren funksjon. */
export function historyRow(
  type: { name: string },
  existing: Existing[],
  year: number,
  period: EventPeriod,
  today = osloToday(),
): HistoryRow {
  const name = periodEventName(type.name, year, period)
  const startDate = periodStart(year, period)
  const datePrecision: EventDatePrecision = period === 'year' ? 'year' : 'semester'
  const sameName = existing.find((e) => sameEventName(e.name, name))
  const overlap = sameName ? undefined : existing.find((e) => inPeriod(e, year, period))
  const status: HistoryRowStatus = sameName
    ? 'exists'
    : startDate > today
      ? 'future'
      : overlap
        ? 'overlap'
        : 'new'
  return {
    year,
    period,
    name,
    startDate,
    datePrecision,
    status,
    existing: sameName ?? overlap ?? null,
  }
}

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new DomainError(parsed.error.issues[0]?.message ?? 'Ugyldige felt.')
  return parsed.data
}

/** Forhåndsvisningen: én rad per periode, med det som finnes fra før. Lagrer ingenting. */
export async function previewEventHistory(
  db: Db,
  viewer: Viewer,
  input: EventHistoryInput,
): Promise<HistoryPreview> {
  assertCan(viewer, 'profiles.edit')
  const values = parse(eventHistoryInput, input)
  const type = await loadType(db, values.typeId)
  const existing = await loadEventsOfType(db, type.id)
  const today = osloToday()
  const rows: HistoryRow[] = []
  for (let y = values.fromYear; y <= values.toYear; y++) {
    for (const period of periodsOf[values.frequency]) {
      rows.push(historyRow(type, existing, y, period, today))
    }
  }
  return { type, rows }
}

/**
 * Oppretter de valgte periodene i én transaksjon. Navn som finnes for typen
 * (også om noen andre la dem inn i mellomtiden), hoppes over; perioder som ikke
 * har startet, avvises. Gir det som ble laget og det som ble hoppet over.
 */
export async function createEventHistory(
  db: Db,
  viewer: Viewer,
  input: EventHistoryCreateInput,
): Promise<{
  typeSlug: string
  created: { id: string; name: string }[]
  skipped: string[]
}> {
  assertCan(viewer, 'profiles.edit')
  const values = parse(eventHistoryCreateInput, input)
  return db.transaction(async (tx) => {
    // Låser typen, så to som legger inn historikk samtidig ikke lager samme navn to ganger.
    const [locked] = await tx
      .select({ id: eventType.id })
      .from(eventType)
      .where(eq(eventType.id, values.typeId))
      .for('update')
    if (!locked) throw new NotFoundError('Fant ikke arrangementstypen.')
    const type = await loadType(tx, values.typeId)
    const existing = await loadEventsOfType(tx, type.id)
    const today = osloToday()
    const seen = new Set<string>()
    const created: { id: string; name: string }[] = []
    const skipped: string[] = []
    const items = [...values.items].sort(
      (a, b) =>
        a.year - b.year ||
        periodStart(a.year, a.period).localeCompare(periodStart(b.year, b.period)),
    )
    for (const item of items) {
      const row = historyRow(type, existing, item.year, item.period, today)
      const key = row.name.toLocaleLowerCase('nb')
      if (seen.has(key)) continue
      seen.add(key)
      if (row.status === 'future') {
        throw new DomainError(`${row.name} har ikke vært ennå. Historikk er det som har vært.`)
      }
      if (row.status === 'exists') {
        skipped.push(row.name)
        continue
      }
      const { id } = await insertEvent(
        tx,
        viewer,
        {
          typeId: type.id,
          name: row.name,
          startDate: row.startDate,
          endDate: null,
          datePrecision: row.datePrecision,
          location: values.location,
          description: null,
        },
        { via: 'history' },
      )
      created.push({ id, name: row.name })
    }
    if (created.length) {
      await tx.insert(auditEvent).values({
        actorPersonId: viewer.personId,
        action: 'event.history',
        details: {
          typeId: type.id,
          slug: type.slug,
          typeName: type.name,
          created: created.length,
          skipped: skipped.length,
          names: created.map((c) => c.name),
          fromYear: items[0]!.year,
          toYear: items.at(-1)!.year,
        },
      })
    }
    return { typeSlug: type.slug, created, skipped }
  })
}
