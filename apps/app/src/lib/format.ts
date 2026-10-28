const rtf = new Intl.RelativeTimeFormat('nb', { numeric: 'auto' })
const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
]

/** «for 3 timer siden», «i går» … */
export function timeAgo(date: Date | string) {
  const seconds = (new Date(date).getTime() - Date.now()) / 1000
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit)
  }
  return 'akkurat nå'
}

export function fullDate(date: Date | string) {
  return new Date(date).toLocaleString('nb-NO', { dateStyle: 'long', timeStyle: 'short' })
}

// Klokkeslett og dager vises i norsk tid, så serveren (UTC i drift) og
// nettleseren skriver det samme og siden ikke skifter innhold ved hydrering.
const zone = 'Europe/Oslo'
const isoDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: zone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
const clock = new Intl.DateTimeFormat('nb-NO', { timeZone: zone, timeStyle: 'short' })
const stamp = new Intl.DateTimeFormat('nb-NO', {
  timeZone: zone,
  dateStyle: 'long',
  timeStyle: 'short',
})
const weekday = (withYear: boolean) =>
  new Intl.DateTimeFormat('nb-NO', {
    timeZone: zone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(withYear && { year: 'numeric' }),
  })

/** Dagen i norsk tid som «2026-10-28», til å gruppere og sammenligne på. */
export const dayKey = (date: Date | string) => isoDay.format(new Date(date))

function today() {
  const key = dayKey(new Date())
  const [y, m, d] = key.split('-').map(Number)
  // Fra datoen, ikke 24 timer tilbake, så overgangen til og fra sommertid ikke gir feil dag.
  const yesterday = new Date(Date.UTC(y!, m! - 1, d! - 1)).toISOString().slice(0, 10)
  return { key, yesterday }
}

/** «22:41» i norsk tid. */
export const clockTime = (date: Date | string) => clock.format(new Date(date))

/** «28. oktober 2026 kl. 22:41» i norsk tid. */
export const timestamp = (date: Date | string) => stamp.format(new Date(date))

/** «I dag», «I går», «Mandag 26. oktober», og med år når det ikke er i år. */
export function dayLabel(date: Date | string) {
  const key = dayKey(date)
  const now = today()
  if (key === now.key) return 'I dag'
  if (key === now.yesterday) return 'I går'
  const label = weekday(key.slice(0, 4) !== now.key.slice(0, 4)).format(new Date(date))
  return label.charAt(0).toLocaleUpperCase('nb') + label.slice(1)
}

/**
 * Siste aktivitet med dagsoppløsning: «i dag», «i går», «for 5 dager siden».
 * Økter oppdateres bare omtrent én gang i døgnet, så timer ville vært falsk presisjon.
 */
export function lastActive(date: Date | string) {
  const key = dayKey(date)
  const now = today()
  if (key === now.key) return 'i dag'
  if (key === now.yesterday) return 'i går'
  return timeAgo(date)
}

export function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`
}

export const kull = (years: number[]) => (years.length ? `ES ${years.join(', ')}` : null)

/** ES er et toårig program, og kull navngis etter uteksamineringsåret: ES 2024 gikk 2022–2024. */
export const esPeriod = (graduationYear: number) => `${graduationYear - 2}–${graduationYear}`

/** «2019–2022», «2022–nå», «til 2018», «nå». */
export function yearSpan(start: number | null, end: number | null) {
  if (end === null) return start ? `${start}–nå` : 'Nå'
  if (start === null) return `Til ${end}`
  return start === end ? String(start) : `${start}–${end}`
}
