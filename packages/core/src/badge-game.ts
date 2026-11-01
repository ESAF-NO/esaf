import { schema, type Db } from '@esaf/db'
import { and, eq, sql } from 'drizzle-orm'
import type { Tx } from './members.ts'

const { badge, badgeAward, membership } = schema

/**
 * Det som gjør merkene til mer enn en liste: hvor sjeldne de er, og poeng (XP)
 * som gir et nivå på profilen. Alt regnes ut fra hvem som har merkene nå, så
 * ingenting her lagres. Reglene:
 *
 * - Sjeldenheten kommer av hvor stor andel av de aktive medlemmene som har
 *   merket. Sjeldnere merker gir mer XP.
 * - Bare publiserte merker hos aktive medlemmer teller, og et merke personen har
 *   skjult, teller ikke (heller ikke for personen selv, så tallet er det samme
 *   for alle).
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

/** Nivået til én person, med antall merker. */
export type PlayerStanding = PlayerLevel & { badges: number }

/** Nivået til én person. */
export function playerStanding(stats: BadgeStats, personId: string): PlayerStanding {
  return { ...levelFor(stats.xp.get(personId) ?? 0), badges: stats.counts.get(personId) ?? 0 }
}
