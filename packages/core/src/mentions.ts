import { schema, type Db } from '@esaf/db'
import { and, asc, eq, inArray, isNotNull, ne } from 'drizzle-orm'
import { assertMember, type Viewer } from './access.ts'
import { DomainError } from './errors.ts'
import type { Tx } from './members.ts'

const { cohort, membership, person, personCohort } = schema

/**
 * Omtaler lagres i teksten som `@[Kari Nordmann](<personId>)`. Id-en gjør
 * omtalen entydig også når to heter det samme, og navnet gjør at teksten kan
 * leses uten oppslag, for eksempel i utdrag og varsler. Serveren skriver om
 * alle omtaler før teksten lagres (`resolveMentions`), så navnet alltid er
 * personens eget, og bare medlemmer som kan få varselet, blir lenker.
 *
 * Appen har en kopi av formatet for visning og skriving i
 * `apps/app/src/lib/mentions.ts`, fordi klienten ikke kan importere `@esaf/core`.
 */
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
const MENTION = `@\\[([^\\]\\n]{1,120})\\]\\((${UUID})\\)`
const mentionPattern = () => new RegExp(MENTION, 'g')

/** Så mange personer kan nevnes i ett innlegg eller én kommentar, så ingen kan varsle alle. */
export const MAX_MENTIONS = 20

export type Mention = { personId: string; name: string }

export function formatMention({ personId, name }: Mention): string {
  // Klammer og linjeskift i navnet ville brutt formatet.
  const clean =
    name
      .replace(/[[\]\r\n]+/g, ' ')
      .trim()
      .slice(0, 120) || 'medlem'
  return `@[${clean}](${personId.toLowerCase()})`
}

export function parseMentions(text: string): Mention[] {
  return [...text.matchAll(mentionPattern())].map((m) => ({
    name: m[1]!,
    personId: m[2]!.toLowerCase(),
  }))
}

/** Teksten slik den leses: `@[Kari Nordmann](…)` blir «@Kari Nordmann». */
export function mentionsToPlainText(text: string): string {
  return text.replace(mentionPattern(), (_, name: string) => `@${name}`)
}

/**
 * Hvem av personene som kan nevnes og få varsler, med navnet fra profilen:
 * aktive medlemmer som selv har tatt i bruk profilen. Profiler fra kullisten
 * uten konto og deaktiverte medlemmer ville aldri sett varselet.
 */
export async function reachablePeople(
  db: Db | Tx,
  personIds: string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(personIds)]
  if (!ids.length) return new Map()
  const rows = await db
    .select({ id: person.id, fullName: person.fullName })
    .from(person)
    .innerJoin(membership, eq(membership.personId, person.id))
    .where(and(inArray(person.id, ids), isNotNull(person.userId), eq(membership.status, 'active')))
  return new Map(rows.map((r) => [r.id, r.fullName]))
}

/**
 * Gjør omtalene i en tekst klare til lagring. Medlemmer som kan få varsel, får
 * navnet sitt slik det står på profilen. Alle andre blir vanlig tekst («@Navn»)
 * uten lenke og uten varsel, også omtaler noen har skrevet for hånd.
 */
export async function resolveMentions(
  db: Db | Tx,
  text: string,
): Promise<{ text: string; personIds: string[] }> {
  const mentions = parseMentions(text)
  if (!mentions.length) return { text, personIds: [] }
  const people = await reachablePeople(
    db,
    mentions.map((m) => m.personId),
  )
  if (people.size > MAX_MENTIONS) {
    throw new DomainError(`Du kan nevne opptil ${MAX_MENTIONS} personer om gangen.`)
  }
  const resolved = text.replace(mentionPattern(), (_, name: string, id: string) => {
    const fullName = people.get(id.toLowerCase())
    return fullName ? formatMention({ personId: id, name: fullName }) : `@${name}`
  })
  return { text: resolved, personIds: [...people.keys()] }
}

export type MentionCandidate = { personId: string; fullName: string; cohortYears: number[] }

/**
 * Medlemmer som kan nevnes, til forslagene når noen skriver @. Hele lista hentes
 * én gang og filtreres i nettleseren, som katalogen. Den innloggede er ikke med,
 * siden ingen får varsel om sin egen omtale.
 */
export async function listMentionable(db: Db, viewer: Viewer): Promise<MentionCandidate[]> {
  assertMember(viewer)
  const rows = await db
    .select({ personId: person.id, fullName: person.fullName, year: cohort.graduationYear })
    .from(person)
    .innerJoin(membership, eq(membership.personId, person.id))
    .leftJoin(personCohort, eq(personCohort.personId, person.id))
    .leftJoin(cohort, eq(cohort.id, personCohort.cohortId))
    .where(
      and(
        isNotNull(person.userId),
        eq(membership.status, 'active'),
        ne(person.id, viewer.personId),
      ),
    )
    .orderBy(asc(person.fullName), asc(cohort.graduationYear))

  const byPerson = new Map<string, MentionCandidate>()
  for (const row of rows) {
    const item = byPerson.get(row.personId) ?? {
      personId: row.personId,
      fullName: row.fullName,
      cohortYears: [],
    }
    if (row.year !== null) item.cohortYears.push(row.year)
    byPerson.set(row.personId, item)
  }
  return [...byPerson.values()]
}
