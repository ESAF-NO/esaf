import { schema, type Db, type MembershipStatus } from '@esaf/db'
import { asc, eq } from 'drizzle-orm'
import { DomainError } from './errors.ts'
import { emailKey, type Tx } from './members.ts'
import { normalizePersonName } from './people-admin.ts'

const { cohort, membership, person, personCohort, personEmail } = schema

/**
 * Å finne personer fra navn og e-post slik folk skriver dem i lister og
 * regneark. Brukes av den innlimte lista på et arrangement og av importen av
 * deltakelse og kullrepresentanter. Reglene:
 *
 * - E-post går foran navn. Kjente adresser og kontaktadressen teller, og
 *   Gmail-varianter regnes som samme adresse (`emailKey`).
 * - Navn sammenlignes uten store bokstaver, aksenter og tegn
 *   (`normalizePersonName`). Et kull («Kari Nordmann 2024») skiller mellom
 *   personer med samme navn.
 * - Samme fornavn og etternavn med ulike mellomnavn blir bare et forslag, som
 *   admin må bekrefte.
 */

/** En person slik listen matches mot. */
export type MatchPerson = {
  personId: string
  fullName: string
  /** Kjente adresser og kontaktadressen. */
  emails: string[]
  cohortYears: number[]
  claimed: boolean
  status: MembershipStatus | null
}

export type MatchCandidate = Omit<MatchPerson, 'emails'> & {
  /** Allerede registrert på arrangementet. */
  attending: boolean
}

/**
 * `matched`: én person, på e-post eller fullt navn. `ambiguous`: flere med samme
 * e-post eller navn. `suggested`: bare samme fornavn og etternavn, så admin må
 * bekrefte. `unmatched`: ingen.
 */
export type MatchStatus = 'matched' | 'ambiguous' | 'suggested' | 'unmatched'
export type MatchBy = 'email' | 'name' | 'firstLast' | null

export type MatchLine = {
  /** Linjen slik den ble limt inn. */
  line: string
  /** Som `MatchStatus`, og `duplicate`: samme person som en linje over. */
  status: MatchStatus | 'duplicate'
  by: MatchBy
  candidates: MatchCandidate[]
}

/** Det vi vet om én person fra en linje eller en rad. */
export type PersonClue = { name: string; emails: string[]; year: number | null }

const EMAIL = /[^\s<>(),;:"'[\]]+@[^\s<>(),;:"'[\]]+\.[a-z]{2,}/gi
const YEAR = /\b(?:19|20)\d{2}\b/g

export const MAX_LINES = 500

/** Linjene i en innlimt liste: én person per linje (eller adskilt med semikolon). */
export function attendeeLines(text: string) {
  return text
    .split(/\r?\n|;/)
    .map((l) => l.replace(/^\s*(?:[-*•·]|\d+[.)])\s+/, '').trim())
    .filter(Boolean)
}

/** Navnet, e-postadressene og et eventuelt kull fra én linje. */
export function parseAttendeeLine(line: string): PersonClue {
  const emails = (line.match(EMAIL) ?? []).map((e) => e.toLowerCase())
  const years = (line.replace(EMAIL, ' ').match(YEAR) ?? []).map(Number)
  const rest = line
    .replace(EMAIL, ' ')
    .replace(YEAR, ' ')
    .replace(/\bES\b|\bkull\b/gi, ' ')
    .replace(/[<>()"'[\]\t]/g, ' ')
  const parts = rest
    .split(',')
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  // «Nordmann, Kari» blir «Kari Nordmann». Ellers er navnet det første feltet.
  const name =
    parts.length === 2 && parts[0]!.split(' ').length === 1 && parts[1]!.split(' ').length <= 2
      ? `${parts[1]} ${parts[0]}`
      : (parts[0] ?? '')
  return { name, emails, year: years[0] ?? null }
}

const firstLast = (name: string) => {
  const parts = name.split(' ')
  return parts.length > 2 ? `${parts[0]} ${parts.at(-1)}` : name
}

export type PersonMatch = { status: MatchStatus; by: MatchBy; candidates: MatchCandidate[] }

/**
 * Lager en matcher for personene. Indeksene bygges én gang, så den kan brukes
 * på tusenvis av rader.
 */
export function personMatcher(
  people: MatchPerson[],
  attending: ReadonlySet<string> = new Set(),
): (clue: PersonClue) => PersonMatch {
  const byEmail = new Map<string, MatchPerson[]>()
  const byName = new Map<string, MatchPerson[]>()
  const byFirstLast = new Map<string, MatchPerson[]>()
  const push = (map: Map<string, MatchPerson[]>, key: string, p: MatchPerson) => {
    const list = map.get(key) ?? []
    if (!list.includes(p)) list.push(p)
    map.set(key, list)
  }
  for (const p of people) {
    for (const e of p.emails) push(byEmail, emailKey(e), p)
    const name = normalizePersonName(p.fullName)
    if (name) {
      push(byName, name, p)
      push(byFirstLast, firstLast(name), p)
    }
  }
  const candidate = (p: MatchPerson): MatchCandidate => ({
    personId: p.personId,
    fullName: p.fullName,
    cohortYears: p.cohortYears,
    claimed: p.claimed,
    status: p.status,
    attending: attending.has(p.personId),
  })
  const sort = (list: MatchPerson[]) =>
    [...list].sort(
      (a, b) =>
        Number(b.status === 'active') - Number(a.status === 'active') ||
        a.fullName.localeCompare(b.fullName, 'nb'),
    )

  return (clue) => {
    const inYear = (list: MatchPerson[]) => {
      if (clue.year === null || list.length < 2) return list
      const hit = list.filter((p) => p.cohortYears.includes(clue.year!))
      return hit.length ? hit : list
    }
    let by: MatchBy = null
    let found: MatchPerson[] = []
    const emailHits = [...new Set(clue.emails.flatMap((e) => byEmail.get(emailKey(e)) ?? []))]
    const name = normalizePersonName(clue.name)
    if (emailHits.length) {
      by = 'email'
      found = inYear(emailHits)
    } else if (name && byName.has(name)) {
      by = 'name'
      found = inYear(byName.get(name)!)
    } else if (name.includes(' ')) {
      // Begge veier: «Kari Nordmann» mot «Kari Marie Nordmann», og omvendt.
      const loose = [
        ...new Set([
          ...(byFirstLast.get(firstLast(name)) ?? []),
          ...(byName.get(firstLast(name)) ?? []),
        ]),
      ]
      if (loose.length) {
        by = 'firstLast'
        found = inYear(loose)
      }
    }
    const status: MatchStatus =
      found.length === 0
        ? 'unmatched'
        : by === 'firstLast'
          ? 'suggested'
          : found.length > 1
            ? 'ambiguous'
            : 'matched'
    return { status, by, candidates: sort(found).map(candidate) }
  }
}

/**
 * Matcher linjene i en innlimt liste mot personene. Samme person to ganger blir
 * `duplicate` på den andre linjen.
 */
export function matchAttendeeLines(
  text: string,
  people: MatchPerson[],
  attending: ReadonlySet<string> = new Set(),
): MatchLine[] {
  const lines = attendeeLines(text)
  if (lines.length > MAX_LINES) throw new DomainError(`Maks ${MAX_LINES} linjer om gangen.`)
  const match = personMatcher(people, attending)
  const seen = new Set<string>()
  return lines.map((line): MatchLine => {
    const result = match(parseAttendeeLine(line))
    let status: MatchLine['status'] = result.status
    if (status === 'matched') {
      const id = result.candidates[0]!.personId
      if (seen.has(id)) status = 'duplicate'
      seen.add(id)
    }
    return { line, status, by: result.by, candidates: result.candidates }
  })
}

/**
 * Alle personer ESAF kjenner, med adresser og kull, til matching. Spørringene
 * går etter hverandre, så den også kan brukes i en transaksjon.
 */
export async function loadMatchPeople(db: Db | Tx): Promise<MatchPerson[]> {
  const rows = await db
    .select({
      personId: person.id,
      fullName: person.fullName,
      userId: person.userId,
      contactEmail: person.contactEmail,
      status: membership.status,
    })
    .from(person)
    .leftJoin(membership, eq(membership.personId, person.id))
  const emails = await db
    .select({ personId: personEmail.personId, email: personEmail.email })
    .from(personEmail)
  const cohorts = await db
    .select({ personId: personCohort.personId, year: cohort.graduationYear })
    .from(personCohort)
    .innerJoin(cohort, eq(cohort.id, personCohort.cohortId))
    .orderBy(asc(cohort.graduationYear))
  const yearsOf = new Map<string, number[]>()
  for (const c of cohorts) yearsOf.set(c.personId, [...(yearsOf.get(c.personId) ?? []), c.year])
  const emailsOf = new Map<string, string[]>()
  for (const e of emails) emailsOf.set(e.personId, [...(emailsOf.get(e.personId) ?? []), e.email])
  return rows.map((r) => ({
    personId: r.personId,
    fullName: r.fullName,
    emails: [...(emailsOf.get(r.personId) ?? []), ...(r.contactEmail ? [r.contactEmail] : [])],
    cohortYears: yearsOf.get(r.personId) ?? [],
    claimed: r.userId !== null,
    status: r.status,
  }))
}
