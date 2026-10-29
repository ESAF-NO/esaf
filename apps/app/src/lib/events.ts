import type { EventRole, RoleCounts } from '@esaf/core'
import { plural } from './format.ts'

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
