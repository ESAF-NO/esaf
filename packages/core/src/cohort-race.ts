import { schema, type Db } from '@esaf/db'
import { and, asc, eq, sql } from 'drizzle-orm'
import type { Tx } from './members.ts'

const { cohort, cohortCompletion, membership, person, personCohort } = schema

/**
 * Kullkampen: hvilket kull som har flest som har tatt i bruk profilen. Reglene:
 *
 * - Kullene er ulike store (fra under ti til nesten femti), så de rangeres på
 *   andelen, ikke antallet. Ved lik andel vinner kullet som ble fullt først,
 *   og ellers kullet med flest, siden det er vanskeligere å få med mange. Ved
 *   lik andel og likt antall deler kullene plass.
 * - Tellingen er den samme som på kullkortene: aktive medlemmer med tilknytning
 *   til kullet, og de av dem som har konto.
 * - Første gang alle i et kull har tatt i bruk profilen, lagres det
 *   (`cohort_completion`), med tidspunktet det ble oppdaget (merkesynkroniseringen
 *   kjører hvert femte minutt og rett etter endringer). Det blir
 *   stående selv om kullet senere får en ny profil, så rekkefølgen («først til
 *   100 %») ikke endrer seg. Plassen kommer av rekkefølgen tidspunktene har.
 * - Et kull uten noen som har tatt i bruk profilen, er ikke med i kampen ennå.
 */

/** Ett kull i kampen, med tallene nå og når det eventuelt ble fullt. */
export type CohortStanding = {
  cohortId: string
  graduationYear: number
  members: number
  claimed: number
  /** Andelen som har tatt i bruk profilen nå, fra 0 til 1. */
  share: number
  /** Nummer i rekken av kull som har hatt alle med. Null: aldri vært fullt. */
  completedPlace: number | null
  completedAt: Date | null
}

export type RankedCohort = CohortStanding & {
  /** Plassen i kampen, fra 1. Null for kull der ingen er med ennå. */
  rank: number | null
}

/** Tallene for hvert kull med aktive medlemmer, og når de ble fulle. */
async function loadCounts(db: Db | Tx) {
  return db
    .select({
      cohortId: cohort.id,
      graduationYear: cohort.graduationYear,
      members: sql<number>`count(*)::int`,
      claimed: sql<number>`count(${person.userId})::int`,
    })
    .from(cohort)
    .innerJoin(personCohort, eq(personCohort.cohortId, cohort.id))
    .innerJoin(person, eq(person.id, personCohort.personId))
    .innerJoin(membership, and(eq(membership.personId, person.id), eq(membership.status, 'active')))
    .groupBy(cohort.id, cohort.graduationYear)
}

/** Kullene som har vært fulle, i rekkefølgen de ble det. */
async function loadCompletions(db: Db | Tx) {
  const rows = await db
    .select({
      cohortId: cohortCompletion.cohortId,
      graduationYear: cohort.graduationYear,
      completedAt: cohortCompletion.completedAt,
    })
    .from(cohortCompletion)
    .innerJoin(cohort, eq(cohort.id, cohortCompletion.cohortId))
    .orderBy(asc(cohortCompletion.completedAt), asc(cohort.graduationYear))
  return new Map(rows.map((r, i) => [r.cohortId, { place: i + 1, completedAt: r.completedAt }]))
}

/**
 * Lagrer kullene som nå har alle med og ikke er lagret før. Kalles av
 * merkesynkroniseringen (i transaksjonen dens), så merkene for fulle kull deles
 * ut i samme runde. Gir tilbake kullene som ble lagret nå.
 */
export async function recordCohortCompletions(tx: Tx, now = new Date()): Promise<string[]> {
  const [counts, done] = [await loadCounts(tx), await loadCompletions(tx)]
  const fresh = counts.filter(
    (c) => c.members > 0 && c.claimed === c.members && !done.has(c.cohortId),
  )
  if (!fresh.length) return []
  const inserted = await tx
    .insert(cohortCompletion)
    .values(
      fresh.map((c) => ({
        cohortId: c.cohortId,
        // Ikke da den siste tok i bruk profilen: kullet kan også ha blitt fullt
        // ved at en profil ble fjernet. Da ville et kull som ble fullt nå, kunnet
        // gå foran et som allerede var først.
        completedAt: now,
        members: c.members,
      })),
    )
    .onConflictDoNothing()
    .returning({ cohortId: cohortCompletion.cohortId })
  return inserted.map((r) => r.cohortId)
}

/** Hvert kull med aktive medlemmer, med tallene nå og plassen som fullt kull. */
export async function loadCohortStandings(db: Db | Tx): Promise<CohortStanding[]> {
  const [counts, done] = [await loadCounts(db), await loadCompletions(db)]
  return counts.map((c) => {
    const completion = done.get(c.cohortId)
    return {
      cohortId: c.cohortId,
      graduationYear: c.graduationYear,
      members: c.members,
      claimed: c.claimed,
      share: c.members ? c.claimed / c.members : 0,
      completedPlace: completion?.place ?? null,
      completedAt: completion?.completedAt ?? null,
    }
  })
}

/**
 * Rekkefølgen i kampen: høyest andel først, så det som ble fullt først
 * (blant fulle kull leder det som kom først), så flest med, så nyeste kull. Plassen deles når andel og antall er like (og ingen av
 * dem har vært fulle før den andre). Ren funksjon.
 */
export function rankCohorts(standings: CohortStanding[]): RankedCohort[] {
  const sorted = [...standings].sort(
    (a, b) =>
      b.share - a.share ||
      (a.completedPlace ?? Infinity) - (b.completedPlace ?? Infinity) ||
      b.claimed - a.claimed ||
      b.graduationYear - a.graduationYear,
  )
  const ranked: RankedCohort[] = []
  sorted.forEach((s, i) => {
    const prev = ranked[i - 1]
    const tied =
      prev !== undefined &&
      prev.share === s.share &&
      prev.claimed === s.claimed &&
      prev.completedPlace === s.completedPlace
    ranked.push({ ...s, rank: s.claimed === 0 ? null : tied ? prev.rank : i + 1 })
  })
  return ranked
}
