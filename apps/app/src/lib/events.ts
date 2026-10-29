import type { EventPeriod, EventRole, RoleCounts } from '@esaf/core'
import type { EventDatePrecision } from '@esaf/db'
import { dateRange, plural } from './format.ts'

/** Rollene på et arrangement, slik de vises. Uten rolle er man deltaker. */
export const roleLabels: Record<EventRole, string> = {
  organizer: 'Arrangør',
  speaker: 'Foredragsholder',
  volunteer: 'Frivillig',
}

export const roleOrder: EventRole[] = ['organizer', 'speaker', 'volunteer']

/** Rollene i flertall, til tellinger: «2 arrangører». */
const rolePlural: Record<EventRole, [string, string]> = {
  organizer: ['arrangør', 'arrangører'],
  speaker: ['foredragsholder', 'foredragsholdere'],
  volunteer: ['frivillig', 'frivillige'],
}

/** «2 arrangører, 1 foredragsholder», eller null uten roller. */
export function roleSummary(roles: RoleCounts): string | null {
  const parts = roleOrder.filter((r) => roles[r] > 0).map((r) => plural(roles[r], ...rolePlural[r]))
  return parts.length ? parts.join(', ') : null
}

const times = (n: number) => (n === 1 ? 'én gang' : `${n} ganger`)

/**
 * Linjen på profilen: «deltatt 5 ganger, arrangert 2, holdt foredrag 1,
 * frivillig 1». Alle med en rad har deltatt; rollene kommer i tillegg.
 */
export function participationLine(total: number, roles: RoleCounts): string {
  const parts = [`deltatt ${times(total)}`]
  if (roles.organizer) parts.push(`arrangert ${roles.organizer}`)
  if (roles.speaker) parts.push(`holdt foredrag ${roles.speaker}`)
  if (roles.volunteer) parts.push(`frivillig ${roles.volunteer}`)
  return parts.join(', ')
}

/** Flertallsformen av en type: «Fagkvelder», ellers navnet. */
export const typePlural = (type: { name: string; plural: string | null }) =>
  type.plural ?? type.name

// Datoer. Speiler `periodStart`, `seasonOf` og `periodEventName` i @esaf/core,
// som ikke kan importeres i klientkoden. Serveren normaliserer uansett.

/** Hvor godt datoen er kjent, slik valget heter i skjemaet. */
export const precisionLabels: Record<EventDatePrecision, string> = {
  day: 'Dato',
  semester: 'Semester',
  year: 'Bare år',
}

export const seasonOf = (date: string): 'spring' | 'autumn' =>
  Number(date.slice(5, 7)) <= 6 ? 'spring' : 'autumn'

/** Første dag i perioden: 1. januar for år og vår, 1. juli for høst. */
export const periodStart = (year: number, period: EventPeriod) =>
  `${String(year).padStart(4, '0')}-${period === 'autumn' ? '07' : '01'}-01`

const seasonWords = { spring: 'vår', autumn: 'høst' } as const

/** «ESAF-helgen høst 2018», «ESAF-helgen 2015». */
export const periodEventName = (typeName: string, year: number, period: EventPeriod) =>
  [typeName, period === 'year' ? null : seasonWords[period], year].filter(Boolean).join(' ')

/** Perioden en dato hører til med en gitt presisjon. Datoer gir semesteret. */
export const periodOf = (startDate: string, precision: EventDatePrecision): EventPeriod =>
  precision === 'year' ? 'year' : seasonOf(startDate)

/** Navnet skjemaet foreslår: typen, semesteret og året. Null uten gyldig dato. */
export function suggestEventName(
  typeName: string | undefined,
  startDate: string,
  precision: EventDatePrecision,
): string | null {
  if (!typeName || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return null
  return periodEventName(typeName, Number(startDate.slice(0, 4)), periodOf(startDate, precision))
}

/**
 * Når arrangementet var, så godt det er kjent: «14.–16. september 2018»,
 * «Høst 2018» eller «2015».
 */
export function eventWhen(e: {
  startDate: string
  endDate: string | null
  datePrecision: EventDatePrecision
}) {
  const year = e.startDate.slice(0, 4)
  if (e.datePrecision === 'year') return year
  if (e.datePrecision === 'semester')
    return `${seasonOf(e.startDate) === 'spring' ? 'Vår' : 'Høst'} ${year}`
  return dateRange(e.startDate, e.endDate)
}
