import { describe, expect, it } from 'vitest'
import {
  badgeRarity,
  badgeRule,
  describeBadgeRule,
  emptyBadgeFacts,
  evaluateBadgeRule,
  levelFor,
  rankCohorts,
  xpForLevel,
  type BadgeFacts,
  type BadgeRuleInput,
} from '../src/index.ts'

const WEEKEND = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000002'
const EVENT_A = '00000000-0000-4000-8000-0000000000a1'
const EVENT_B = '00000000-0000-4000-8000-0000000000b1'

const rule = (input: BadgeRuleInput) => badgeRule.parse(input)

function facts(patch: Partial<BadgeFacts> = {}): BadgeFacts {
  return { ...emptyBadgeFacts(), ...patch }
}

const went = (
  startDate: string,
  typeId = WEEKEND,
  role: BadgeFacts['participations'][number]['role'] = null,
  eventId = `${startDate}-${typeId}`,
) => ({ eventId, typeId, startDate, role })

const names = {
  eventTypes: new Map([
    [WEEKEND, 'ESAF-helgen'],
    [OTHER, 'Fagkveld'],
  ]),
  events: new Map([
    [EVENT_A, 'ESAF-helgen høst 2018'],
    [EVENT_B, 'ESAF-helgen vår 2019'],
  ]),
}

describe('regler for merker', () => {
  it('teller arrangementer av en type, og merket gjelder fra arrangementet som avgjorde det', () => {
    const r = rule({ kind: 'event_count', eventTypeId: WEEKEND, count: 3 })
    const f = facts({
      participations: [
        went('2017-09-01'),
        went('2018-03-01', OTHER),
        went('2018-09-01'),
        went('2019-09-01'),
        went('2020-09-01'),
      ],
    })
    expect(evaluateBadgeRule(r, f)).toEqual({
      earned: true,
      achievedOn: '2019-09-01',
      progress: { current: 3, target: 3 },
    })
    expect(evaluateBadgeRule(r, facts({ participations: [went('2017-09-01')] }))).toEqual({
      earned: false,
      achievedOn: null,
      progress: { current: 1, target: 3 },
    })
  })

  it('kan kreve en rolle; deltaker uten rolle er «participant»', () => {
    const organizer = rule({
      kind: 'event_count',
      eventTypeId: null,
      roles: ['organizer'],
      count: 1,
    })
    const participant = rule({ kind: 'event_count', roles: ['participant'], count: 2 })
    const f = facts({
      participations: [went('2018-09-01', WEEKEND, 'organizer'), went('2019-09-01', OTHER)],
    })
    expect(evaluateBadgeRule(organizer, f).earned).toBe(true)
    expect(evaluateBadgeRule(participant, f).progress).toEqual({ current: 1, target: 2 })
  })

  it('år på rad teller kalenderår, og et hull starter på nytt', () => {
    const r = rule({ kind: 'event_streak', eventTypeId: WEEKEND, years: 3 })
    const gap = facts({
      participations: [
        went('2015-09-01'),
        went('2016-03-01'),
        went('2018-09-01'),
        went('2019-09-01'),
      ],
    })
    expect(evaluateBadgeRule(r, gap)).toMatchObject({
      earned: false,
      progress: { current: 2, target: 3 },
    })
    const run = facts({
      participations: [
        went('2016-03-01'),
        went('2016-09-01'),
        went('2017-09-01'),
        went('2018-03-01'),
        went('2018-09-01'),
      ],
    })
    expect(evaluateBadgeRule(r, run)).toMatchObject({ earned: true, achievedOn: '2018-03-01' })
  })

  it('bestemte arrangementer: ett av dem, eller alle', () => {
    const f = facts({ participations: [went('2018-09-01', WEEKEND, null, EVENT_A)] })
    expect(
      evaluateBadgeRule(rule({ kind: 'event_attended', eventIds: [EVENT_A, EVENT_B] }), f),
    ).toMatchObject({ earned: true, achievedOn: '2018-09-01' })
    expect(
      evaluateBadgeRule(
        rule({ kind: 'event_attended', eventIds: [EVENT_A, EVENT_B], match: 'all' }),
        f,
      ),
    ).toMatchObject({ earned: false, progress: { current: 1, target: 2 } })
  })

  it('kull, styret, kullrepresentant', () => {
    const f = facts({
      cohorts: [
        { graduationYear: 2004, relation: 'student' },
        { graduationYear: 2015, relation: 'mentor' },
      ],
      board: [{ role: 'chair', endYear: 2020 }],
      representative: [{ endYear: null }],
    })
    expect(
      evaluateBadgeRule(rule({ kind: 'cohort', fromYear: 2000, toYear: 2005 }), f).earned,
    ).toBe(true)
    expect(
      evaluateBadgeRule(rule({ kind: 'cohort', relations: ['mentor'], toYear: 2010 }), f).earned,
    ).toBe(false)
    expect(evaluateBadgeRule(rule({ kind: 'board', roles: ['chair'] }), f).earned).toBe(true)
    expect(evaluateBadgeRule(rule({ kind: 'board', current: true }), f).earned).toBe(false)
    expect(
      evaluateBadgeRule(rule({ kind: 'cohort_representative', current: true }), f).earned,
    ).toBe(true)
  })

  it('selskaper: ES-selskapet, gründer, og status som «kjøpt opp»', () => {
    const f = facts({
      companies: [
        { companyId: 'a', status: 'acquired', founder: true, esCompany: true },
        { companyId: 'b', status: 'active', founder: true, esCompany: false },
        { companyId: 'c', status: 'active', founder: false, esCompany: false },
      ],
    })
    expect(evaluateBadgeRule(rule({ kind: 'company', link: 'es_company' }), f).earned).toBe(true)
    expect(
      evaluateBadgeRule(rule({ kind: 'company', link: 'founder', count: 2 }), f),
    ).toMatchObject({
      earned: true,
      progress: { current: 2, target: 2 },
    })
    expect(
      evaluateBadgeRule(rule({ kind: 'company', link: 'founder', statuses: ['acquired'] }), f)
        .earned,
    ).toBe(true)
    expect(evaluateBadgeRule(rule({ kind: 'company', link: 'any', count: 4 }), f).earned).toBe(
      false,
    )
  })

  it('profilen og feeden teller mot et mål', () => {
    const f = facts({ posts: 2, comments: 0 })
    f.profile.photo = true
    f.profile.bio = true
    expect(
      evaluateBadgeRule(rule({ kind: 'profile', fields: ['photo', 'bio', 'experience'] }), f),
    ).toMatchObject({ earned: false, progress: { current: 2, target: 3 } })
    expect(
      evaluateBadgeRule(rule({ kind: 'community', metric: 'posts', count: 2 }), f).earned,
    ).toBe(true)
  })

  it('merker for hånd gis aldri av regelen', () => {
    expect(evaluateBadgeRule(rule({ kind: 'manual' }), facts()).earned).toBe(false)
  })

  it('ugyldige regler avvises med norsk melding', () => {
    expect(badgeRule.safeParse({ kind: 'event_count', count: 0 }).error?.issues[0]?.message).toBe(
      'Minst 1.',
    )
    expect(
      badgeRule.safeParse({ kind: 'cohort', fromYear: 2010, toYear: 2005 }).error?.issues[0]
        ?.message,
    ).toBe('Siste kull kan ikke være før første kull.')
    expect(badgeRule.safeParse({ kind: 'sql', query: 'drop table' }).success).toBe(false)
  })

  it('regelen forklares i én setning', () => {
    const text = (input: BadgeRuleInput) => describeBadgeRule(rule(input), names)
    expect(text({ kind: 'event_count', eventTypeId: WEEKEND, count: 1 })).toBe(
      'Vært på ESAF-helgen',
    )
    expect(text({ kind: 'event_count', eventTypeId: WEEKEND, count: 5 })).toBe(
      'Vært på ESAF-helgen minst 5 ganger',
    )
    expect(
      text({ kind: 'event_count', eventTypeId: WEEKEND, roles: ['organizer'], count: 2 }),
    ).toBe('Arrangert ESAF-helgen minst 2 ganger')
    expect(text({ kind: 'event_streak', eventTypeId: WEEKEND, years: 3 })).toBe(
      'Vært på ESAF-helgen 3 år på rad',
    )
    expect(text({ kind: 'event_attended', eventIds: [EVENT_A, EVENT_B], match: 'all' })).toBe(
      'Vært på alle disse: ESAF-helgen høst 2018 og ESAF-helgen vår 2019',
    )
    expect(text({ kind: 'cohort', relations: ['mentor'] })).toBe('Mentor på Entreprenørskolen')
    expect(text({ kind: 'cohort', fromYear: 2000, toYear: 2005 })).toBe(
      'Student i et av kullene ES 2000–2005',
    )
    expect(text({ kind: 'board', roles: ['chair', 'vice_chair'] })).toBe(
      'Vært leder eller nestleder i styret',
    )
    expect(text({ kind: 'company', link: 'es_company' })).toBe('Startet et selskap på ES')
    expect(text({ kind: 'company', link: 'founder', statuses: ['acquired'] })).toBe(
      'Grunnlagt et selskap som er kjøpt opp',
    )
    expect(text({ kind: 'profile', fields: ['photo', 'bio', 'experience'] })).toBe(
      'Fylt ut bilde, om deg og erfaring på profilen',
    )
    expect(text({ kind: 'manual' })).toBe('Deles ut av styret')
  })
})

describe('spillet: sjeldenhet og nivå', () => {
  it('sjeldenheten følger andelen aktive medlemmer som har merket', () => {
    expect(badgeRarity(0, 200)).toMatchObject({ tier: 'legendary', xp: 200 })
    expect(badgeRarity(4, 200)).toMatchObject({ tier: 'legendary', share: 0.02 })
    expect(badgeRarity(10, 200).tier).toBe('epic')
    expect(badgeRarity(30, 200).tier).toBe('rare')
    expect(badgeRarity(80, 200).tier).toBe('uncommon')
    expect(badgeRarity(150, 200)).toMatchObject({ tier: 'common', xp: 25 })
  })

  it('nivåene krever stadig mer XP, og har titler', () => {
    expect([1, 2, 3, 4, 5].map(xpForLevel)).toEqual([0, 40, 100, 180, 280])
    expect(levelFor(0)).toMatchObject({ level: 1, title: 'Nykommer', nextXp: 40 })
    expect(levelFor(39).level).toBe(1)
    expect(levelFor(40)).toMatchObject({ level: 2, title: 'Deltaker', levelXp: 40, nextXp: 100 })
    expect(levelFor(5000)).toMatchObject({ title: 'Legende' })
  })
})

describe('kullkampen', () => {
  const standing = (
    graduationYear: number,
    claimed: number,
    members: number,
    completedPlace: number | null = null,
  ) => ({
    cohortId: String(graduationYear),
    graduationYear,
    members,
    claimed,
    share: claimed / members,
    completedPlace,
    completedAt: completedPlace ? new Date(2026, 0, completedPlace) : null,
  })

  it('rangerer på andel, så antall; like kull deler plass, og kull uten noen er ikke med', () => {
    const ranked = rankCohorts([
      standing(2010, 5, 10),
      standing(2020, 20, 40),
      standing(2008, 8, 8, 2),
      standing(2024, 40, 40, 1),
      standing(2012, 5, 10),
      standing(2015, 0, 30),
    ])
    expect(ranked.map((r) => [r.graduationYear, r.rank])).toEqual([
      [2024, 1],
      [2008, 2],
      [2020, 3],
      [2012, 4],
      [2010, 4],
      [2015, null],
    ])
  })

  const race = (
    graduationYear: number,
    claimed: number,
    members: number,
    completedPlace: number | null = null,
  ) => ({
    graduationYear,
    members,
    claimed,
    completedPlace,
    completedOn: completedPlace ? `2026-0${completedPlace}-01` : null,
  })

  it('fullt kull: det første kullet, eller et av de første', () => {
    const first = rule({ kind: 'cohort_complete', place: 1 })
    const anyFull = rule({ kind: 'cohort_complete' })
    const second = facts({ cohortRace: [race(2019, 30, 30, 2)], cohortsCompleted: 2 })
    expect(evaluateBadgeRule(first, second)).toEqual({
      earned: false,
      achievedOn: null,
      progress: null,
    })
    expect(evaluateBadgeRule(anyFull, second)).toEqual({
      earned: true,
      achievedOn: '2026-02-01',
      progress: null,
    })
    expect(evaluateBadgeRule(rule({ kind: 'cohort_complete', place: 2 }), second).earned).toBe(true)
    // Fortsatt mulig: fremgangen er kullet som er nærmest.
    expect(
      evaluateBadgeRule(first, facts({ cohortRace: [race(2019, 12, 30), race(2020, 3, 4)] })),
    ).toEqual({ earned: false, achievedOn: null, progress: { current: 3, target: 4 } })
  })

  it('forklarer regelen', () => {
    expect(describeBadgeRule(rule({ kind: 'cohort_complete' }), names)).toBe(
      'Gått i et kull der alle har tatt i bruk profilen',
    )
    expect(describeBadgeRule(rule({ kind: 'cohort_complete', place: 3 }), names)).toBe(
      'Gått i et av de 3 første kullene der alle tok i bruk profilen',
    )
  })
})
