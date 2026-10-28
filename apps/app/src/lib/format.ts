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
