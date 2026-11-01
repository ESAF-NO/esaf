import { schema, type Db } from '@esaf/db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { photoUrls, type ProfilePhoto } from './photos.ts'
import type { Tx } from './members.ts'

const { badge, badgeAward, cohort, membership, person, personCohort } = schema

/**
 * Spillet rundt merkene: hvor sjeldne de er, poeng (XP), nivå og toppliste, og
 * kull mot kull. Alt regnes ut fra hvem som har merkene nå, så ingenting her
 * lagres. Reglene:
 *
 * - Sjeldenheten kommer av hvor stor andel av de aktive medlemmene som har
 *   merket. Sjeldnere merker gir mer XP, så det lønner seg å jakte på dem.
 * - Bare publiserte merker hos aktive medlemmer teller, og et merke personen har
 *   skjult, teller ikke (heller ikke for personen selv, så tallet er det samme
 *   for alle).
 * - Kull mot kull måles i XP per aktivt medlem i kullet, så små kull kan slå
 *   store. Bare studentkull med minst tre aktive medlemmer er med.
 */

export const badgeRarities = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const
export type BadgeRarityTier = (typeof badgeRarities)[number]

export const badgeRarityNames: Record<BadgeRarityTier, string> = {
  common: 'Vanlig',
  uncommon: 'Uvanlig',
  rare: 'Sjelden',
  epic: 'Episk',
  legendary: 'Legendarisk',
}

/** XP for et merke, etter hvor sjeldent det er. */
export const badgeRarityXp: Record<BadgeRarityTier, number> = {
  common: 25,
  uncommon: 40,
  rare: 70,
  epic: 120,
  legendary: 200,
}

export type BadgeRarity = {
  tier: BadgeRarityTier
  /** Andelen aktive medlemmer som har merket, fra 0 til 1. */
  share: number
  xp: number
}

/** Hvor sjeldent et merke er. Ingen som har det ennå, er legendarisk. */
export function badgeRarity(holders: number, members: number): BadgeRarity {
  const share = members > 0 ? holders / members : 0
  const tier: BadgeRarityTier =
    holders === 0 || share <= 0.02
      ? 'legendary'
      : share <= 0.07
        ? 'epic'
        : share <= 0.2
          ? 'rare'
          : share <= 0.45
            ? 'uncommon'
            : 'common'
  return { tier, share, xp: badgeRarityXp[tier] }
}

/** Titlene for nivåene. Fra det siste nivået i lista heter alle det samme. */
const levelTitles = [
  'Nykommer',
  'Deltaker',
  'Stamgjest',
  'Kjentmann',
  'Veteran',
  'Bauta',
  'Legende',
]

/** XP som trengs for å nå et nivå: 0, 40, 100, 180, 280, 400 … To vanlige merker gir nivå 2. */
export const xpForLevel = (level: number) => 10 * (level - 1) * (level + 2)

export type PlayerLevel = {
  level: number
  title: string
  xp: number
  /** XP der dette nivået startet, og der neste starter. */
  levelXp: number
  nextXp: number
}

/** Nivået for så mye XP. */
export function levelFor(xp: number): PlayerLevel {
  let level = 1
  while (xpForLevel(level + 1) <= xp) level++
  return {
    level,
    title: levelTitles[Math.min(level, levelTitles.length) - 1]!,
    xp,
    levelXp: xpForLevel(level),
    nextXp: xpForLevel(level + 1),
  }
}

/** Et merke slik det teller i spillet: hos et aktivt medlem, publisert og ikke skjult. */
type CountedAward = { badgeId: string; personId: string }

/** Tallene spillet regnes ut fra. Én spørring for merkene, én for antall medlemmer. */
export type BadgeStats = {
  /** Aktive medlemmer. */
  members: number
  /** Hvor mange aktive medlemmer som har hvert publiserte merke. */
  holders: Map<string, number>
  rarity: (badgeId: string) => BadgeRarity
  /** XP per person, bare for dem som har noe. */
  xp: Map<string, number>
  /** Antall merker per person. */
  counts: Map<string, number>
}

export async function loadBadgeStats(db: Db | Tx): Promise<BadgeStats> {
  const [{ members }] = (await db
    .select({ members: sql<number>`count(*)::int` })
    .from(membership)
    .where(eq(membership.status, 'active'))) as [{ members: number }]
  const awards: CountedAward[] = await db
    .select({ badgeId: badgeAward.badgeId, personId: badgeAward.personId })
    .from(badgeAward)
    .innerJoin(badge, eq(badge.id, badgeAward.badgeId))
    .innerJoin(membership, eq(membership.personId, badgeAward.personId))
    .where(
      and(
        eq(badge.status, 'published'),
        eq(membership.status, 'active'),
        eq(badgeAward.hidden, false),
      ),
    )
  const holders = new Map<string, number>()
  for (const a of awards) holders.set(a.badgeId, (holders.get(a.badgeId) ?? 0) + 1)
  const rarity = (badgeId: string) => badgeRarity(holders.get(badgeId) ?? 0, members)
  const xp = new Map<string, number>()
  const counts = new Map<string, number>()
  for (const a of awards) {
    xp.set(a.personId, (xp.get(a.personId) ?? 0) + rarity(a.badgeId).xp)
    counts.set(a.personId, (counts.get(a.personId) ?? 0) + 1)
  }
  return { members, holders, rarity, xp, counts }
}

export type PlayerStanding = PlayerLevel & {
  badges: number
  /** Plassen på topplista blant alle med XP. Null uten XP. */
  rank: number | null
  /** Hvor mange som er på topplista. */
  players: number
}

/** Plassene etter XP, så antall merker, så navn. Samme XP gir samme plass. */
function ranking(stats: BadgeStats) {
  const sorted = [...stats.xp].sort((a, b) => b[1] - a[1])
  const rank = new Map<string, number>()
  sorted.forEach(([personId, xp], i) => {
    const previous = sorted[i - 1]
    rank.set(personId, previous && previous[1] === xp ? rank.get(previous[0])! : i + 1)
  })
  return { sorted, rank }
}

/** Nivået og plassen til én person. */
export function playerStanding(stats: BadgeStats, personId: string): PlayerStanding {
  const { rank } = ranking(stats)
  return {
    ...levelFor(stats.xp.get(personId) ?? 0),
    badges: stats.counts.get(personId) ?? 0,
    rank: rank.get(personId) ?? null,
    players: stats.xp.size,
  }
}

export type LeaderboardEntry = {
  rank: number
  personId: string
  fullName: string
  photo: ProfilePhoto | null
  claimed: boolean
  level: number
  title: string
  xp: number
  badges: number
}

/** Topplista: de med mest XP. */
export async function leaderboard(
  db: Db | Tx,
  stats: BadgeStats,
  limit = 10,
): Promise<LeaderboardEntry[]> {
  const { sorted, rank } = ranking(stats)
  const top = sorted.slice(0, limit)
  if (!top.length) return []
  const people = await db
    .select({
      id: person.id,
      fullName: person.fullName,
      photoKey: person.photoKey,
      userId: person.userId,
    })
    .from(person)
    .where(
      inArray(
        person.id,
        top.map(([id]) => id),
      ),
    )
  const byId = new Map(people.map((p) => [p.id, p]))
  return top
    .filter(([id]) => byId.has(id))
    .map(([personId, xp]) => {
      const p = byId.get(personId)!
      const level = levelFor(xp)
      return {
        rank: rank.get(personId)!,
        personId,
        fullName: p.fullName,
        photo: photoUrls(p.photoKey),
        claimed: p.userId !== null,
        level: level.level,
        title: level.title,
        xp,
        badges: stats.counts.get(personId) ?? 0,
      }
    })
    .sort(
      (a, b) =>
        a.rank - b.rank || b.badges - a.badges || a.fullName.localeCompare(b.fullName, 'nb'),
    )
}

export type CohortStanding = {
  rank: number
  graduationYear: number
  /** Aktive medlemmer i kullet (studenter). */
  members: number
  /** XP per aktivt medlem, avrundet til én desimal. */
  xpPerMember: number
  /** Merker per aktivt medlem, avrundet til én desimal. */
  badgesPerMember: number
  /** Andelen i kullet som har minst ett merke, fra 0 til 1. */
  collectors: number
}

/** Minste antall aktive medlemmer for at et kull er med i kull mot kull. */
export const MIN_COHORT_SIZE = 3

const oneDecimal = (n: number) => Math.round(n * 10) / 10

/** Kull mot kull: XP per aktivt medlem, høyest først. */
export async function cohortStandings(db: Db | Tx, stats: BadgeStats): Promise<CohortStanding[]> {
  const rows = await db
    .select({ year: cohort.graduationYear, personId: personCohort.personId })
    .from(personCohort)
    .innerJoin(cohort, eq(cohort.id, personCohort.cohortId))
    .innerJoin(membership, eq(membership.personId, personCohort.personId))
    .where(and(eq(personCohort.relation, 'student'), eq(membership.status, 'active')))
  const byYear = new Map<number, string[]>()
  for (const r of rows) byYear.set(r.year, [...(byYear.get(r.year) ?? []), r.personId])
  const standings = [...byYear]
    .filter(([, people]) => people.length >= MIN_COHORT_SIZE)
    .map(([graduationYear, people]) => {
      const xp = people.reduce((sum, id) => sum + (stats.xp.get(id) ?? 0), 0)
      const badges = people.reduce((sum, id) => sum + (stats.counts.get(id) ?? 0), 0)
      return {
        graduationYear,
        members: people.length,
        xpPerMember: oneDecimal(xp / people.length),
        badgesPerMember: oneDecimal(badges / people.length),
        collectors: people.filter((id) => stats.counts.has(id)).length / people.length,
      }
    })
    .sort((a, b) => b.xpPerMember - a.xpPerMember || b.graduationYear - a.graduationYear)
  return standings.map((s, i) => ({
    ...s,
    rank:
      i > 0 && standings[i - 1]!.xpPerMember === s.xpPerMember
        ? standings.findIndex((o) => o.xpPerMember === s.xpPerMember) + 1
        : i + 1,
  }))
}
