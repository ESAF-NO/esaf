import { fold } from './member-search.ts'

/**
 * Omtaler i tekst: `@[Kari Nordmann](<personId>)`. Formatet er definert i
 * @esaf/core (mentions.ts), som også skriver om alle omtaler før lagring. Her
 * er bare det klienten trenger: vise omtaler som lenker, og la skrivefeltet
 * vise «@Kari Nordmann» mens teksten som sendes, har hele omtalen.
 */
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
const MENTION = `@\\[([^\\]\\n]{1,120})\\]\\((${UUID})\\)`

export type Segment =
  { type: 'text'; text: string } | { type: 'mention'; personId: string; name: string }

/** Deler teksten i vanlig tekst og omtaler. */
export function segments(markup: string): Segment[] {
  const parts: Segment[] = []
  let last = 0
  for (const m of markup.matchAll(new RegExp(MENTION, 'g'))) {
    if (m.index > last) parts.push({ type: 'text', text: markup.slice(last, m.index) })
    parts.push({ type: 'mention', name: m[1]!, personId: m[2]!.toLowerCase() })
    last = m.index + m[0].length
  }
  if (last < markup.length) parts.push({ type: 'text', text: markup.slice(last) })
  return parts
}

const shown = (part: Segment) => (part.type === 'text' ? part.text : `@${part.name}`)

function serialize(parts: Segment[]) {
  return parts.map((p) => (p.type === 'text' ? p.text : `@[${p.name}](${p.personId})`)).join('')
}

/** Teksten slik den står i skrivefeltet, med «@Kari Nordmann» for hver omtale. */
export const plainText = (markup: string) => segments(markup).map(shown).join('')

/** De forskjellige personene som er nevnt, i rekkefølgen de først står. */
export function mentionedPeople(markup: string) {
  const people = new Map<string, string>()
  for (const part of segments(markup)) {
    if (part.type === 'mention' && !people.has(part.personId)) {
      people.set(part.personId, part.name)
    }
  }
  return [...people].map(([personId, name]) => ({ personId, name }))
}

/** Delen av teksten mellom to posisjoner i skrivefeltet. En omtale som kuttes, blir vanlig tekst. */
function slice(parts: Segment[], from: number, to: number): Segment[] {
  const out: Segment[] = []
  let start = 0
  for (const part of parts) {
    const text = shown(part)
    const end = start + text.length
    if (end > from && start < to) {
      if (part.type === 'mention' && start >= from && end <= to) out.push(part)
      else out.push({ type: 'text', text: text.slice(Math.max(0, from - start), to - start) })
    }
    start = end
  }
  return out
}

/**
 * Overfører en endring i skrivefeltet til teksten med omtaler. Endringen finnes
 * ved å sammenligne før og etter; det som er felles i slutten, kan ikke gå
 * forbi markøren, der det nye slutter. Omtaler som endringen treffer, blir
 * vanlig tekst, så «@Kari Nordman» uten siste n ikke lenger varsler noen.
 */
export function applyEdit(markup: string, next: string, caret: number): string {
  const parts = segments(markup)
  const prev = parts.map(shown).join('')
  if (prev === next) return markup
  let suffix = 0
  const maxSuffix = Math.min(prev.length, next.length - caret)
  while (suffix < maxSuffix && prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]) {
    suffix++
  }
  let prefix = 0
  const maxPrefix = Math.min(prev.length, next.length) - suffix
  while (prefix < maxPrefix && prev[prefix] === next[prefix]) prefix++

  const inserted = next.slice(prefix, next.length - suffix)
  return serialize([
    ...slice(parts, 0, prefix),
    ...(inserted ? [{ type: 'text' as const, text: inserted }] : []),
    ...slice(parts, prev.length - suffix, prev.length),
  ])
}

/**
 * Hva som er skrevet etter en @ rett før markøren, hvis det kan bli en omtale:
 * @ må stå først eller etter mellomrom eller en startparentes, så e-postadresser
 * ikke teller, og det kan ikke være inne i en omtale som alt er valgt.
 */
export function mentionQuery(
  markup: string,
  caret: number,
): { start: number; query: string } | null {
  const parts = segments(markup)
  const before = parts.map(shown).join('').slice(0, caret)
  const match = /(?:^|[\s([{"'«])@([^\s@][^@\n]{0,49})?$/u.exec(before)
  if (!match) return null
  const query = match[1] ?? ''
  if (query.split(' ').length > 3) return null
  const start = caret - query.length - 1
  let pos = 0
  for (const part of parts) {
    const end = pos + shown(part).length
    if (part.type === 'mention' && start < end && caret > pos) return null
    pos = end
  }
  return { start, query }
}

/** Erstatter det som er skrevet fra @ til markøren med en omtale og et mellomrom. */
export function insertMention(
  markup: string,
  from: number,
  to: number,
  person: { personId: string; name: string },
): { markup: string; caret: number } {
  const parts = segments(markup)
  const length = parts.map(shown).join('').length
  const after = slice(parts, to, length)
  const name = person.name.replace(/[[\]\r\n]+/g, ' ').trim()
  const first = after[0]
  const spaced = first?.type === 'text' && /^\s/.test(first.text)
  return {
    markup: serialize([
      ...slice(parts, 0, from),
      { type: 'mention', personId: person.personId, name },
      ...(spaced ? [] : [{ type: 'text' as const, text: ' ' }]),
      ...after,
    ]),
    caret: from + name.length + 2,
  }
}

/**
 * Personer som passer til det som er skrevet etter @: hvert ord må være starten
 * på et av navnene. Treff på fornavn og personer i samme tråd kommer først.
 */
export function matchPeople<T extends { personId: string; fullName: string }>(
  people: T[],
  query: string,
  preferred: string[] = [],
  limit = 6,
): T[] {
  const words = fold(query).split(/\s+/).filter(Boolean)
  const scored: { person: T; score: number }[] = []
  for (const person of people) {
    const names = fold(person.fullName).split(/[\s-]+/)
    if (!words.every((w) => names.some((n) => n.startsWith(w)))) continue
    const score =
      (preferred.includes(person.personId) ? 4 : 0) +
      (words[0] && names[0]?.startsWith(words[0]) ? 2 : 0) +
      (fold(person.fullName).startsWith(words.join(' ')) ? 1 : 0)
    scored.push({ person, score })
  }
  return scored
    .sort((a, b) => b.score - a.score || a.person.fullName.localeCompare(b.person.fullName, 'nb'))
    .slice(0, limit)
    .map((s) => s.person)
}
