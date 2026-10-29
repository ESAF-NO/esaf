import type { EventRole, ParticipationLayout, RoleChoice } from '@esaf/core'

/** Hva en verdi i arket betyr, slik admin ser det. */
export const roleChoiceLabels: Record<RoleChoice, string> = {
  attended: 'Deltaker',
  organizer: 'Arrangør',
  speaker: 'Foredragsholder',
  volunteer: 'Frivillig',
  skip: 'Ikke med',
}

/** Rollen på en deltakelse. Null er deltaker. */
export const roleLabel = (role: EventRole | null) => roleChoiceLabels[role ?? 'attended']

export const layoutLabels: Record<ParticipationLayout, string> = {
  matrix: 'Matrise: én rad per person, én kolonne per arrangement',
  sheets: 'Én fane per arrangement',
  long: 'Én rad per deltakelse',
}

/** «14. sep. 2018» for en dato som `YYYY-MM-DD`. */
const short = new Intl.DateTimeFormat('nb-NO', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})
export const shortDate = (date: string) => short.format(new Date(`${date}T00:00:00Z`))

/** «2019–2022», «siden 2021», «til 2018» eller «ukjent». */
export function years(start: number | null, end: number | null) {
  if (start === null && end === null) return 'ukjent periode'
  if (end === null) return `siden ${start}`
  if (start === null) return `til ${end}`
  return start === end ? String(start) : `${start}–${end}`
}
