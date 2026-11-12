import {
  schema,
  type BadgeStatus,
  type BoardRole,
  type CohortRelation,
  type CompanyStatus,
  type Db,
  type EventDatePrecision,
  type ProgrammeKind,
} from '@esaf/db'
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  lte,
  ne,
  sql,
  type AnyColumn,
} from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { z } from 'zod'
import { assertCan, assertMember, type Viewer } from './access.ts'
import { badgeImageUrls, deleteBadgeImageFiles, type BadgeImage } from './badge-images.ts'
import {
  loadBadgeStats,
  playerStanding,
  type BadgeRarity,
  type PlayerStanding,
} from './badge-game.ts'
import { boardRoleNames, boardRoles } from './board.ts'
import { companySlug } from './companies.ts'
import { programmeKindLabels, programmeKinds } from './company-events.ts'
import { DomainError, NotFoundError } from './errors.ts'
import { normalizeRole, osloToday, type EventRole } from './events.ts'
import { inOrder, type Tx } from './members.ts'
import type { ObjectStorage } from './storage.ts'
import { optionalText } from './validation.ts'

const {
  auditEvent,
  badge,
  badgeAward,
  boardMember,
  cohort,
  cohortRepresentative,
  comment,
  company,
  companyEvent,
  event,
  eventParticipation,
  eventType,
  experience,
  membership,
  person,
  personCohort,
  post,
} = schema

/**
 * Merker (achievements). Reglene:
 *
 * - Admins med `badges.manage` lager merker med navn, tekst, ikon, farge og en
 *   regel. Regelen er en av typene under (`badgeRule`), aldri fri tekst eller
 *   SQL, så den kan valideres, forhåndsvises og forklares. Et merke kan også ha et
 *   eget bilde, som vises i stedet for ikonet (`badge-images.ts`).
 * - Et merke er et utkast til det publiseres. Før det kan admins se hvem som
 *   ville fått det (`previewBadgeRule`). Publiserte merker deles ut og vises;
 *   arkiverte vises ikke, men hvem som hadde dem, blir stående.
 * - Merker med regel holdes oppdatert av serveren (`syncBadges`): når noen
 *   oppfyller regelen, får de merket, og når de ikke lenger gjør det (dataene er
 *   rettet), mister de det. Ingen kan dele ut eller ta fra noen et slikt merke
 *   for hånd; da rettes dataene i stedet. Merker av typen `manual` deles ut og
 *   tas tilbake av admins, med en begrunnelse som vises.
 * - Den som får et merke, får varsel når merket er publisert (én gang per merke).
 * - Medlemmer ser merkene til aktive medlemmer. Hver person kan skjule sine egne
 *   merker; da vises de ikke på profilen eller i listene for andre.
 * - Alt admins gjør med merker, logges (`badge.*`). Utdeling etter regel logges
 *   ikke: den følger av dataene, som har sin egen logg.
 */

// ---------------------------------------------------------------------------
// Ikoner, farger og regler
// ---------------------------------------------------------------------------

/** Ikonene et merke kan ha. Navnene er fra Lucide (lucide.dev), som appen bruker. */
export const badgeIcons = [
  'award',
  'medal',
  'trophy',
  'star',
  'crown',
  'flame',
  'rocket',
  'tent',
  'mic',
  'megaphone',
  'handshake',
  'hand-heart',
  'users',
  'graduation-cap',
  'sparkles',
  'gem',
  'heart',
  'compass',
  'calendar-check',
  'briefcase',
  'lightbulb',
  'mountain',
  'sun',
  'zap',
  'target',
  'flag',
  'book-open',
  'pen-line',
  'camera',
  'gift',
  'party-popper',
  'coffee',
  'globe',
  'shield',
  'leaf',
  'anchor',
  'feather',
  'footprints',
  'puzzle',
  'sprout',
] as const
export type BadgeIcon = (typeof badgeIcons)[number]

/** Fargene et merke kan ha. `brand` er ESAF-rødt. */
export const badgeColors = [
  'brand',
  'amber',
  'emerald',
  'sky',
  'violet',
  'rose',
  'teal',
  'stone',
] as const
export type BadgeColor = (typeof badgeColors)[number]

/** Rollene på et arrangement en regel kan kreve. `participant` er deltaker uten særskilt rolle. */
export const badgeEventRoles = ['participant', 'organizer', 'speaker', 'volunteer'] as const
export type BadgeEventRole = (typeof badgeEventRoles)[number]

/** Feltene på profilen en regel kan kreve at er fylt ut. */
export const badgeProfileFields = [
  'photo',
  'bio',
  'experience',
  'expertise',
  'industries',
  'city',
  'linkedin',
  'studyBackground',
  'esCompany',
] as const
export type BadgeProfileField = (typeof badgeProfileFields)[number]

export const badgeProfileFieldNames: Record<BadgeProfileField, string> = {
  photo: 'bilde',
  bio: 'om deg',
  experience: 'erfaring',
  expertise: 'kan hjelpe med',
  industries: 'bransjer',
  city: 'bosted',
  linkedin: 'LinkedIn',
  studyBackground: 'studieretning',
  esCompany: 'selskap på ES',
}

/** Hvordan personen er knyttet til et selskap: ES-selskapet, som gründer, eller begge og ansatt. */
export const badgeCompanyLinks = ['es_company', 'founder', 'any'] as const
export type BadgeCompanyLink = (typeof badgeCompanyLinks)[number]

const companyStatuses = [
  'active',
  'acquired',
  'closed',
  'unknown',
] as const satisfies CompanyStatus[]
const cohortRelations = ['student', 'staff', 'mentor'] as const satisfies CohortRelation[]

const amount = (max: number) =>
  z
    .number('Må være et tall.')
    .int('Må være et helt tall.')
    .min(1, 'Minst 1.')
    .max(max, `Høyst ${max}.`)

const ruleYear = z
  .number()
  .int()
  .min(1990, 'Ugyldig årstall.')
  .max(2100, 'Ugyldig årstall.')
  .nullable()
  .default(null)

/**
 * Regelen for et merke. Hver type leser data som allerede finnes i appen, så
 * merkene deles ut av seg selv når dataene fylles inn.
 */
export const badgeRule = z
  .discriminatedUnion(
    'kind',
    [
      z.object({
        /** Vært på arrangementer (av en type) minst så mange ganger, eventuelt i en rolle. */
        kind: z.literal('event_count'),
        /** Null: alle typer. */
        eventTypeId: z.uuid('Ugyldig arrangementstype.').nullable().default(null),
        /** Tom: alle roller, også vanlig deltaker. */
        roles: z.array(z.enum(badgeEventRoles, 'Ugyldig rolle.')).max(4).default([]),
        count: amount(200),
      }),
      z.object({
        /** Vært på arrangementer (av en type) så mange kalenderår på rad. */
        kind: z.literal('event_streak'),
        eventTypeId: z.uuid('Ugyldig arrangementstype.').nullable().default(null),
        years: z.number().int().min(2, 'Minst 2 år.').max(50, 'Høyst 50 år.'),
      }),
      z.object({
        /** Vært på bestemte arrangementer: ett av dem, eller alle. */
        kind: z.literal('event_attended'),
        eventIds: z
          .array(z.uuid('Ugyldig arrangement.'))
          .min(1, 'Velg minst ett arrangement.')
          .max(100, 'Høyst 100 arrangementer.'),
        match: z.enum(['any', 'all']).default('any'),
      }),
      z.object({
        /** Gått på ES (eller vært ansatt eller mentor), eventuelt i noen av kullene. */
        kind: z.literal('cohort'),
        relations: z
          .array(z.enum(cohortRelations, 'Ugyldig tilknytning.'))
          .min(1, 'Velg minst én tilknytning.')
          .default(['student']),
        /** Første og siste kull (uteksamineringsår). Null: ingen grense. */
        fromYear: ruleYear,
        toYear: ruleYear,
      }),
      z.object({
        /** Sittet i styret i ESAF, eventuelt i en rolle, eventuelt nå. */
        kind: z.literal('board'),
        roles: z.array(z.enum(boardRoles, 'Ugyldig rolle.')).max(4).default([]),
        current: z.boolean().default(false),
      }),
      z.object({
        /** Vært kullrepresentant, eventuelt nå. */
        kind: z.literal('cohort_representative'),
        current: z.boolean().default(false),
      }),
      z.object({
        /** Startet eller jobbet i minst så mange selskaper, eventuelt med en status (kjøpt opp). */
        kind: z.literal('company'),
        link: z.enum(badgeCompanyLinks, 'Ugyldig tilknytning.').default('founder'),
        /** Tom: alle statuser. */
        statuses: z.array(z.enum(companyStatuses, 'Ugyldig status.')).max(4).default([]),
        count: amount(20).default(1),
      }),
      z.object({
        /**
         * Vært med i et selskap som gikk gjennom et program (akselerator, inkubator),
         * eventuelt bestemte programmer, som det første selskapet i ESAF der, eller
         * mens personen gikk på ES.
         */
        kind: z.literal('programme'),
        link: z.enum(badgeCompanyLinks, 'Ugyldig tilknytning.').default('founder'),
        /** Programmene (selskapene i ESAF). Tom: alle. */
        programmeIds: z
          .array(z.uuid('Ugyldig program.'))
          .max(20, 'Høyst 20 programmer.')
          .default([]),
        /** Tom: alle typer program. */
        programmeKinds: z.array(z.enum(programmeKinds, 'Ugyldig type.')).max(4).default([]),
        /** Bare det første selskapet i ESAF i programmet (alle med samme dato). */
        first: z.boolean().default(false),
        /** Bare når programmet var mens personen gikk på ES, som student. */
        duringEs: z.boolean().default(false),
      }),
      z.object({
        /** Fylt ut feltene på profilen. */
        kind: z.literal('profile'),
        fields: z
          .array(z.enum(badgeProfileFields, 'Ugyldig felt.'))
          .min(1, 'Velg minst ett felt.')
          .max(badgeProfileFields.length),
      }),
      z.object({
        /** Skrevet minst så mange innlegg eller kommentarer i feeden. */
        kind: z.literal('community'),
        metric: z.enum(['posts', 'comments'], 'Ugyldig mål.'),
        count: amount(1000),
      }),
      z.object({
        /** Deles ut for hånd av admins. */
        kind: z.literal('manual'),
      }),
    ],
    'Ukjent regeltype.',
  )
  .superRefine((rule, ctx) => {
    if (
      rule.kind === 'cohort' &&
      rule.fromYear !== null &&
      rule.toYear !== null &&
      rule.toYear < rule.fromYear
    ) {
      ctx.addIssue({ code: 'custom', message: 'Siste kull kan ikke være før første kull.' })
    }
  })

export type BadgeRule = z.output<typeof badgeRule>
export type BadgeRuleInput = z.input<typeof badgeRule>
export type BadgeRuleKind = BadgeRule['kind']

/** Regeltypene slik admins ser dem, i rekkefølgen de vises. */
export const badgeRuleKinds: { kind: BadgeRuleKind; label: string; help: string }[] = [
  {
    kind: 'event_count',
    label: 'Arrangementer',
    help: 'Vært på arrangementer minst så mange ganger, eventuelt som arrangør, foredragsholder eller frivillig.',
  },
  {
    kind: 'event_streak',
    label: 'År på rad',
    help: 'Vært på et arrangement hvert år, så mange år på rad.',
  },
  {
    kind: 'event_attended',
    label: 'Bestemte arrangementer',
    help: 'Vært på ett eller alle av noen bestemte arrangementer.',
  },
  {
    kind: 'cohort',
    label: 'Kull',
    help: 'Student, ansatt eller mentor på ES, eventuelt i noen av kullene.',
  },
  {
    kind: 'board',
    label: 'Styret',
    help: 'Sittet i styret i ESAF, eventuelt i en rolle eller nå.',
  },
  {
    kind: 'cohort_representative',
    label: 'Kullrepresentant',
    help: 'Vært kullrepresentant, eventuelt nå.',
  },
  {
    kind: 'company',
    label: 'Selskaper',
    help: 'Startet selskap på ES, grunnlagt selskaper, eventuelt med en status som «kjøpt opp».',
  },
  {
    kind: 'programme',
    label: 'Programmer',
    help: 'Vært med i et selskap som gikk gjennom en akselerator eller inkubator, eventuelt som det første i ESAF eller mens de gikk på ES.',
  },
  { kind: 'profile', label: 'Profilen', help: 'Fylt ut feltene på profilen.' },
  {
    kind: 'community',
    label: 'Feeden',
    help: 'Skrevet minst så mange innlegg eller kommentarer.',
  },
  { kind: 'manual', label: 'For hånd', help: 'Admins deler ut merket, med en begrunnelse.' },
]

export const isManualRule = (rule: Pick<BadgeRule, 'kind'>) => rule.kind === 'manual'

// ---------------------------------------------------------------------------
// Fakta om personene, og hva en regel sier om dem
// ---------------------------------------------------------------------------

/** Det reglene leser om én person. */
export type BadgeFacts = {
  /** Arrangementer som har startet, eldste først. */
  participations: { eventId: string; typeId: string; startDate: string; role: EventRole | null }[]
  cohorts: { graduationYear: number; relation: CohortRelation }[]
  board: { role: BoardRole; endYear: number | null }[]
  representative: { endYear: number | null }[]
  /** Ett innslag per selskap. */
  companies: {
    companyId: string
    status: CompanyStatus
    founder: boolean
    esCompany: boolean
    /** Programmene selskapet gikk gjennom, eldste først. */
    programmes: BadgeProgrammeFact[]
  }[]
  profile: Record<BadgeProfileField, boolean>
  posts: number
  comments: number
}

/** Et program et selskap gikk gjennom. */
export type BadgeProgrammeFact = {
  /** Null når programmet er slettet fra ESAF. */
  programmeId: string | null
  kind: ProgrammeKind
  /** `YYYY-MM-DD`. */
  date: string
  /** Det første selskapet i ESAF i dette programmet (eller ett av dem, ved samme dato). */
  first: boolean
}

export const emptyBadgeFacts = (): BadgeFacts => ({
  participations: [],
  cohorts: [],
  board: [],
  representative: [],
  companies: [],
  profile: Object.fromEntries(badgeProfileFields.map((f) => [f, false])) as Record<
    BadgeProfileField,
    boolean
  >,
  posts: 0,
  comments: 0,
})

/** Hvor langt personen har kommet mot et merke: «3 av 5». */
export type BadgeProgress = { current: number; target: number }

export type BadgeResult = {
  earned: boolean
  /** Datoen regelen slo til, når dataene sier det (arrangementer). */
  achievedOn: string | null
  /** For regler med et mål å telle mot. */
  progress: BadgeProgress | null
}

const progress = (current: number, target: number): BadgeProgress => ({
  current: Math.min(current, target),
  target,
})

function roleMatches(roles: BadgeEventRole[], role: EventRole | null) {
  if (!roles.length) return true
  return roles.includes(role ?? 'participant')
}

function companyLinkMatches(
  link: BadgeCompanyLink,
  c: Pick<BadgeFacts['companies'][number], 'founder' | 'esCompany'>,
) {
  return (
    link === 'any' || (link === 'founder' && c.founder) || (link === 'es_company' && c.esCompany)
  )
}

/** Hva regelen sier om personen. Ren funksjon: samme svar for samme fakta. */
export function evaluateBadgeRule(rule: BadgeRule, f: BadgeFacts): BadgeResult {
  switch (rule.kind) {
    case 'event_count': {
      const hits = f.participations.filter(
        (p) =>
          (rule.eventTypeId === null || p.typeId === rule.eventTypeId) &&
          roleMatches(rule.roles, p.role),
      )
      const earned = hits.length >= rule.count
      return {
        earned,
        achievedOn: earned ? hits[rule.count - 1]!.startDate : null,
        progress: progress(hits.length, rule.count),
      }
    }
    case 'event_streak': {
      const firstByYear = new Map<number, string>()
      for (const p of f.participations) {
        if (rule.eventTypeId !== null && p.typeId !== rule.eventTypeId) continue
        const year = Number(p.startDate.slice(0, 4))
        if (!firstByYear.has(year)) firstByYear.set(year, p.startDate)
      }
      const years = [...firstByYear.keys()].sort((a, b) => a - b)
      let run = 0
      let longest = 0
      let achievedOn: string | null = null
      years.forEach((year, i) => {
        run = i > 0 && years[i - 1] === year - 1 ? run + 1 : 1
        longest = Math.max(longest, run)
        if (run >= rule.years && achievedOn === null) achievedOn = firstByYear.get(year)!
      })
      return {
        earned: achievedOn !== null,
        achievedOn,
        progress: progress(longest, rule.years),
      }
    }
    case 'event_attended': {
      const wanted = new Set(rule.eventIds)
      // Alle arrangementene er slettet: da kan ingen få merket.
      if (!wanted.size) return { earned: false, achievedOn: null, progress: null }
      const hits = f.participations.filter((p) => wanted.has(p.eventId))
      const distinct = new Set(hits.map((p) => p.eventId)).size
      if (rule.match === 'any') {
        return { earned: hits.length > 0, achievedOn: hits[0]?.startDate ?? null, progress: null }
      }
      const earned = distinct >= wanted.size
      return {
        earned,
        achievedOn: earned ? hits.at(-1)!.startDate : null,
        progress: progress(distinct, wanted.size),
      }
    }
    case 'cohort': {
      const earned = f.cohorts.some(
        (c) =>
          rule.relations.includes(c.relation) &&
          (rule.fromYear === null || c.graduationYear >= rule.fromYear) &&
          (rule.toYear === null || c.graduationYear <= rule.toYear),
      )
      return { earned, achievedOn: null, progress: null }
    }
    case 'board': {
      const earned = f.board.some(
        (t) =>
          (!rule.roles.length || rule.roles.includes(t.role)) &&
          (!rule.current || t.endYear === null),
      )
      return { earned, achievedOn: null, progress: null }
    }
    case 'cohort_representative': {
      const earned = f.representative.some((t) => !rule.current || t.endYear === null)
      return { earned, achievedOn: null, progress: null }
    }
    case 'company': {
      const hits = f.companies.filter(
        (c) =>
          companyLinkMatches(rule.link, c) &&
          (!rule.statuses.length || rule.statuses.includes(c.status)),
      )
      return {
        earned: hits.length >= rule.count,
        achievedOn: null,
        progress: rule.count > 1 ? progress(hits.length, rule.count) : null,
      }
    }
    case 'programme': {
      const studied = (date: string) => {
        const year = Number(date.slice(0, 4))
        // «ES 2024» gikk 2022–2024.
        return f.cohorts.some(
          (c) =>
            c.relation === 'student' && year >= c.graduationYear - 2 && year <= c.graduationYear,
        )
      }
      const hits = f.companies
        .filter((c) => companyLinkMatches(rule.link, c))
        .flatMap((c) => c.programmes)
        .filter(
          (p) =>
            (!rule.programmeIds.length ||
              (p.programmeId !== null && rule.programmeIds.includes(p.programmeId))) &&
            (!rule.programmeKinds.length || rule.programmeKinds.includes(p.kind)) &&
            (!rule.first || p.first) &&
            (!rule.duringEs || studied(p.date)),
        )
        .sort((a, b) => a.date.localeCompare(b.date))
      return { earned: hits.length > 0, achievedOn: hits[0]?.date ?? null, progress: null }
    }
    case 'profile': {
      const done = rule.fields.filter((field) => f.profile[field]).length
      return {
        earned: done === rule.fields.length,
        achievedOn: null,
        progress: progress(done, rule.fields.length),
      }
    }
    case 'community': {
      const n = rule.metric === 'posts' ? f.posts : f.comments
      return { earned: n >= rule.count, achievedOn: null, progress: progress(n, rule.count) }
    }
    case 'manual':
      return { earned: false, achievedOn: null, progress: null }
  }
}

/** Avgrenser til personene, eller ingenting når alle (`null`) skal med. */
const within = (column: AnyColumn, ids: string[] | null) => (ids ? inArray(column, ids) : undefined)

/**
 * Faktaene reglene leser, for noen personer eller alle (`null`). Et par spørringer
 * over hele tabellene; ESAF har noen tusen personer, så det går fort.
 */
export async function loadBadgeFacts(
  db: Db | Tx,
  personIds: string[] | null,
): Promise<Map<string, BadgeFacts>> {
  const facts = new Map<string, BadgeFacts>()
  if (personIds && !personIds.length) return facts
  const ids = personIds ? [...new Set(personIds)] : null
  const today = osloToday()
  // Etter hverandre: synkroniseringen kaller dette inne i en transaksjon.
  const [people, participations, cohorts, board, reps, jobs, posts, comments, programmeEvents] =
    await inOrder([
      () =>
        db
          .select({
            id: person.id,
            photoKey: person.photoKey,
            bio: person.bio,
            expertise: person.expertise,
            industries: person.industries,
            city: person.city,
            linkedinUrl: person.linkedinUrl,
            studyBackground: person.studyBackground,
            esCompanyId: person.esCompanyId,
            esCompanyStatus: company.status,
          })
          .from(person)
          .leftJoin(company, eq(company.id, person.esCompanyId))
          .where(within(person.id, ids)),
      () =>
        db
          .select({
            personId: eventParticipation.personId,
            eventId: eventParticipation.eventId,
            role: eventParticipation.role,
            typeId: event.typeId,
            startDate: event.startDate,
          })
          .from(eventParticipation)
          .innerJoin(event, eq(event.id, eventParticipation.eventId))
          .where(and(within(eventParticipation.personId, ids), lte(event.startDate, today)))
          .orderBy(asc(event.startDate), asc(event.id)),
      () =>
        db
          .select({
            personId: personCohort.personId,
            graduationYear: cohort.graduationYear,
            relation: personCohort.relation,
          })
          .from(personCohort)
          .innerJoin(cohort, eq(cohort.id, personCohort.cohortId))
          .where(within(personCohort.personId, ids)),
      () =>
        db
          .select({
            personId: boardMember.personId,
            role: boardMember.role,
            endYear: boardMember.endYear,
          })
          .from(boardMember)
          .where(within(boardMember.personId, ids)),
      () =>
        db
          .select({
            personId: cohortRepresentative.personId,
            endYear: cohortRepresentative.endYear,
          })
          .from(cohortRepresentative)
          .where(within(cohortRepresentative.personId, ids)),
      () =>
        db
          .select({
            personId: experience.personId,
            companyId: experience.companyId,
            founder: experience.founder,
            status: company.status,
          })
          .from(experience)
          .innerJoin(company, eq(company.id, experience.companyId))
          .where(within(experience.personId, ids)),
      () =>
        db
          .select({ personId: post.authorPersonId, n: sql<number>`count(*)::int` })
          .from(post)
          .where(and(within(post.authorPersonId, ids), isNull(post.deletedAt)))
          .groupBy(post.authorPersonId),
      () =>
        db
          .select({ personId: comment.authorPersonId, n: sql<number>`count(*)::int` })
          .from(comment)
          .where(and(within(comment.authorPersonId, ids), isNull(comment.deletedAt)))
          .groupBy(comment.authorPersonId),
      // Alle, også for selskaper ingen av personene er i: «først» gjelder hele ESAF.
      () =>
        db
          .select({
            companyId: companyEvent.companyId,
            programmeId: companyEvent.programmeCompanyId,
            kind: companyEvent.programmeKind,
            date: companyEvent.date,
          })
          .from(companyEvent)
          .where(and(eq(companyEvent.type, 'programme'), ne(companyEvent.confidence, 'low')))
          .orderBy(asc(companyEvent.date)),
    ] as const)
  for (const p of people) {
    const f = emptyBadgeFacts()
    f.profile = {
      photo: p.photoKey !== null,
      bio: !!p.bio?.trim(),
      experience: false,
      expertise: p.expertise.length > 0,
      industries: p.industries.length > 0,
      city: !!p.city?.trim(),
      linkedin: !!p.linkedinUrl,
      studyBackground: !!p.studyBackground?.trim(),
      esCompany: p.esCompanyId !== null,
    }
    if (p.esCompanyId) {
      f.companies.push({
        companyId: p.esCompanyId,
        status: p.esCompanyStatus ?? 'unknown',
        founder: false,
        esCompany: true,
        programmes: [],
      })
    }
    facts.set(p.id, f)
  }
  for (const { personId, role, ...rest } of participations) {
    facts.get(personId)?.participations.push({ ...rest, role: normalizeRole(role) })
  }
  for (const { personId, ...c } of cohorts) facts.get(personId)?.cohorts.push(c)
  for (const { personId, ...t } of board) facts.get(personId)?.board.push(t)
  for (const { personId, ...t } of reps) facts.get(personId)?.representative.push(t)
  for (const job of jobs) {
    const f = facts.get(job.personId)
    if (!f) continue
    f.profile.experience = true
    const known = f.companies.find((c) => c.companyId === job.companyId)
    if (known) known.founder ||= job.founder
    else {
      f.companies.push({
        companyId: job.companyId,
        status: job.status,
        founder: job.founder,
        esCompany: false,
        programmes: [],
      })
    }
  }
  const firstDate = new Map<string, string>()
  for (const e of programmeEvents) {
    if (e.programmeId && !firstDate.has(e.programmeId)) firstDate.set(e.programmeId, e.date)
  }
  const programmesOf = new Map<string, BadgeProgrammeFact[]>()
  for (const e of programmeEvents) {
    programmesOf.set(e.companyId, [
      ...(programmesOf.get(e.companyId) ?? []),
      {
        programmeId: e.programmeId,
        kind: e.kind ?? 'other',
        date: e.date,
        first: e.programmeId !== null && firstDate.get(e.programmeId) === e.date,
      },
    ])
  }
  for (const f of facts.values()) {
    for (const c of f.companies) c.programmes = programmesOf.get(c.companyId) ?? []
  }
  for (const { personId, n } of posts) {
    const f = facts.get(personId)
    if (f) f.posts = n
  }
  for (const { personId, n } of comments) {
    const f = facts.get(personId)
    if (f) f.comments = n
  }
  return facts
}

// ---------------------------------------------------------------------------
// Regelen i ord
// ---------------------------------------------------------------------------

/** Navnene regelen viser til, så den kan forklares. */
export type BadgeRuleNames = {
  eventTypes: Map<string, string>
  events: Map<string, string>
  /** Programmene (selskaper i ESAF). */
  companies: Map<string, string>
}

const orList = (items: string[]) =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} eller ${items.at(-1)}` : (items[0] ?? '')
const andList = (items: string[]) =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} og ${items.at(-1)}` : (items[0] ?? '')
const times = (n: number) => (n === 1 ? 'én gang' : `${n} ganger`)

/** Med preposisjonen: «arrangert ESAF-helgen», «holdt foredrag på ESAF-helgen». */
const eventRoleVerbs: Record<BadgeEventRole, string> = {
  participant: 'vært på',
  organizer: 'arrangert',
  speaker: 'holdt foredrag på',
  volunteer: 'vært frivillig på',
}
const relationNames: Record<CohortRelation, string> = {
  student: 'student',
  staff: 'ansatt',
  mentor: 'mentor',
}
const companyStatusNames: Record<CompanyStatus, string> = {
  active: 'i drift',
  acquired: 'kjøpt opp',
  closed: 'lagt ned',
  unknown: 'ukjent status',
}

/** Med ubestemt artikkel: «en akselerator». */
const programmeKindNames: Record<ProgrammeKind, string> = {
  accelerator: 'en akselerator',
  incubator: 'en inkubator',
  pre_incubator: 'en pre-inkubator',
  other: 'et program',
}

const capitalize = (text: string) => text.charAt(0).toLocaleUpperCase('nb') + text.slice(1)

/** Regelen som én setning på norsk: «Vært på ESAF-helgen minst 3 ganger». */
export function describeBadgeRule(rule: BadgeRule, names: BadgeRuleNames): string {
  const typeName = (id: string | null) =>
    id === null
      ? 'arrangementer'
      : (names.eventTypes.get(id) ?? 'en arrangementstype som er slettet')
  switch (rule.kind) {
    case 'event_count': {
      const where = typeName(rule.eventTypeId)
      if (!rule.roles.length || (rule.roles.length === 1 && rule.roles[0] === 'participant')) {
        return rule.count === 1 ? `Vært på ${where}` : `Vært på ${where} minst ${times(rule.count)}`
      }
      return capitalize(
        `${orList(rule.roles.map((r) => eventRoleVerbs[r]))} ${where} minst ${times(rule.count)}`,
      )
    }
    case 'event_streak':
      return `Vært på ${typeName(rule.eventTypeId)} ${rule.years} år på rad`
    case 'event_attended': {
      const events = rule.eventIds.map((id) => names.events.get(id) ?? 'et slettet arrangement')
      return rule.match === 'all' && events.length > 1
        ? `Vært på alle disse: ${andList(events)}`
        : `Vært på ${orList(events)}`
    }
    case 'cohort': {
      const who = orList(rule.relations.map((r) => relationNames[r]))
      const years =
        rule.fromYear !== null && rule.toYear !== null
          ? rule.fromYear === rule.toYear
            ? ` i ES ${rule.fromYear}`
            : ` i et av kullene ES ${rule.fromYear}–${rule.toYear}`
          : rule.fromYear !== null
            ? ` i ES ${rule.fromYear} eller senere`
            : rule.toYear !== null
              ? ` i ES ${rule.toYear} eller tidligere`
              : ' på Entreprenørskolen'
      return capitalize(`${who}${years}`)
    }
    case 'board': {
      const roles = rule.roles.map((r) => boardRoleNames[r].toLocaleLowerCase('nb'))
      if (rule.current) {
        return roles.length ? `Er ${orList(roles)} i styret nå` : 'Sitter i styret nå'
      }
      return roles.length ? `Vært ${orList(roles)} i styret` : 'Sittet i styret i ESAF'
    }
    case 'cohort_representative':
      return rule.current ? 'Er kullrepresentant nå' : 'Vært kullrepresentant'
    case 'company': {
      const statuses = rule.statuses.length
        ? ` som er ${orList(rule.statuses.map((s) => companyStatusNames[s]))}`
        : ''
      const companies = rule.count === 1 ? 'et selskap' : `minst ${rule.count} selskaper`
      if (rule.link === 'es_company') return `Startet ${companies} på ES${statuses}`
      if (rule.link === 'founder') return `Grunnlagt ${companies}${statuses}`
      return `Startet eller jobbet i ${companies}${statuses}`
    }
    case 'programme': {
      const which = rule.programmeIds.length
        ? orList(
            rule.programmeIds.map((id) => names.companies.get(id) ?? 'et program som er slettet'),
          )
        : rule.programmeKinds.length
          ? orList(rule.programmeKinds.map((k) => programmeKindNames[k]))
          : 'en akselerator eller inkubator'
      const base =
        rule.link === 'es_company'
          ? `Startet et selskap på ES som gikk gjennom ${which}`
          : rule.link === 'founder'
            ? `Grunnlagt et selskap som gikk gjennom ${which}`
            : `Startet eller jobbet i et selskap som gikk gjennom ${which}`
      const first = rule.first ? ', som det første selskapet i ESAF' : ''
      return `${base}${first}${rule.duringEs ? ', mens de gikk på ES' : ''}`
    }
    case 'profile':
      return `Fylt ut ${andList(rule.fields.map((f) => badgeProfileFieldNames[f]))} på profilen`
    case 'community':
      return rule.metric === 'posts'
        ? rule.count === 1
          ? 'Skrevet et innlegg i feeden'
          : `Skrevet minst ${rule.count} innlegg i feeden`
        : rule.count === 1
          ? 'Kommentert i feeden'
          : `Skrevet minst ${rule.count} kommentarer i feeden`
    case 'manual':
      return 'Deles ut av styret'
  }
}

/** Navnene på typene og arrangementene reglene viser til. */
async function loadRuleNames(db: Db | Tx, rules: BadgeRule[]): Promise<BadgeRuleNames> {
  const eventIds = [
    ...new Set(rules.flatMap((r) => (r.kind === 'event_attended' ? r.eventIds : []))),
  ]
  const companyIds = [
    ...new Set(rules.flatMap((r) => (r.kind === 'programme' ? r.programmeIds : []))),
  ]
  const [types, events, programmes] = await inOrder([
    () => db.select({ id: eventType.id, name: eventType.name }).from(eventType),
    () =>
      eventIds.length
        ? db
            .select({ id: event.id, name: event.name })
            .from(event)
            .where(inArray(event.id, eventIds))
        : Promise.resolve([]),
    () =>
      companyIds.length
        ? db
            .select({ id: company.id, name: company.name })
            .from(company)
            .where(inArray(company.id, companyIds))
        : Promise.resolve([]),
  ] as const)
  return {
    eventTypes: new Map(types.map((t) => [t.id, t.name])),
    events: new Map(events.map((e) => [e.id, e.name])),
    companies: new Map(programmes.map((c) => [c.id, c.name])),
  }
}

/** Regelen fra databasen. En regel som ikke lenger er gyldig, gir aldri merket. */
function storedRule(value: unknown): BadgeRule {
  const parsed = badgeRule.safeParse(value)
  return parsed.success ? parsed.data : { kind: 'manual' }
}

// ---------------------------------------------------------------------------
// Utdeling etter regel
// ---------------------------------------------------------------------------

/**
 * Synkroniseringen og endringer admins gjør på merker, går etter hverandre. Ellers
 * kunne en synkronisering som leste et merke før det ble gjort om til et merke for
 * hånd (eller arkivert), skrive merker etter den gamle regelen etterpå.
 */
const lockBadgeWork = (tx: Tx) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext('badge_sync'))`)

/**
 * Reglene uten arrangementer som er slettet etterpå. Et slettet arrangement
 * teller ikke, så «alle disse» betyr alle som fortsatt finnes.
 */
async function withLiveEvents(db: Db | Tx, rules: BadgeRule[]): Promise<BadgeRule[]> {
  const ids = [...new Set(rules.flatMap((r) => (r.kind === 'event_attended' ? r.eventIds : [])))]
  if (!ids.length) return rules
  const live = new Set(
    (await db.select({ id: event.id }).from(event).where(inArray(event.id, ids))).map((r) => r.id),
  )
  return rules.map((r) =>
    r.kind === 'event_attended' ? { ...r, eventIds: r.eventIds.filter((id) => live.has(id)) } : r,
  )
}

/** Hvor høyt et trinn er i en serie: tallet regelen krever. Avgjør når rekkefølgen er lik. */
function ruleLevel(rule: BadgeRule): number {
  switch (rule.kind) {
    case 'event_count':
    case 'company':
    case 'community':
      return rule.count
    case 'event_streak':
      return rule.years
    case 'event_attended':
      return rule.match === 'all' ? rule.eventIds.length : 1
    case 'profile':
      return rule.fields.length
    default:
      return 0
  }
}

export type BadgeAwardChange = { badgeId: string; personId: string }

/**
 * Holder merkene med regel oppdatert: gir dem til den som oppfyller regelen,
 * og tar dem fra den som ikke lenger gjør det. Bare publiserte merker. Uten
 * avgrensning gjelder det alle merker og alle personer; serveren kjører det
 * jevnlig, og med avgrensning rett etter endringer (eget arrangement, nytt
 * merke). Nye merker gir varsel.
 */
export async function syncBadges(
  db: Db,
  scope: { personIds?: string[]; badgeIds?: string[] } = {},
): Promise<{ awarded: BadgeAwardChange[]; removed: number; updated: number }> {
  return db.transaction(async (tx) => {
    // To synkroniseringer samtidig ville sett de samme manglende radene.
    await lockBadgeWork(tx)
    const badges = (
      await tx
        .select({ id: badge.id, name: badge.name, rule: badge.rule })
        .from(badge)
        .where(
          and(
            eq(badge.status, 'published'),
            scope.badgeIds ? inArray(badge.id, scope.badgeIds) : undefined,
          ),
        )
    )
      .map((b) => ({ ...b, rule: storedRule(b.rule) }))
      .filter((b) => !isManualRule(b.rule))
    if (!badges.length) return { awarded: [], removed: 0, updated: 0 }
    const rules = await withLiveEvents(
      tx,
      badges.map((b) => b.rule),
    )
    badges.forEach((b, i) => (b.rule = rules[i]!))

    const facts = await loadBadgeFacts(tx, scope.personIds ?? null)
    const existing = await tx
      .select({
        badgeId: badgeAward.badgeId,
        personId: badgeAward.personId,
        achievedOn: badgeAward.achievedOn,
      })
      .from(badgeAward)
      .where(
        and(
          eq(badgeAward.source, 'rule'),
          inArray(
            badgeAward.badgeId,
            badges.map((b) => b.id),
          ),
          scope.personIds ? inArray(badgeAward.personId, scope.personIds) : undefined,
        ),
      )
    const had = new Map(existing.map((a) => [`${a.badgeId}:${a.personId}`, a]))

    const awarded: (BadgeAwardChange & { achievedOn: string | null })[] = []
    const moved: (BadgeAwardChange & { achievedOn: string | null })[] = []
    const lost = new Map<string, string[]>()
    for (const b of badges) {
      for (const [personId, f] of facts) {
        const key = `${b.id}:${personId}`
        const result = evaluateBadgeRule(b.rule, f)
        const before = had.get(key)
        had.delete(key)
        if (result.earned && !before) {
          awarded.push({ badgeId: b.id, personId, achievedOn: result.achievedOn })
        } else if (result.earned && before && before.achievedOn !== result.achievedOn) {
          moved.push({ badgeId: b.id, personId, achievedOn: result.achievedOn })
        } else if (!result.earned && before) {
          lost.set(b.id, [...(lost.get(b.id) ?? []), personId])
        }
      }
    }
    // Rader for personer som ikke var med i faktaene, finnes ikke lenger.
    for (const a of had.values()) lost.set(a.badgeId, [...(lost.get(a.badgeId) ?? []), a.personId])

    for (let i = 0; i < awarded.length; i += 1000) {
      await tx
        .insert(badgeAward)
        .values(awarded.slice(i, i + 1000).map((a) => ({ ...a, source: 'rule' as const })))
        .onConflictDoNothing()
    }
    for (const m of moved) {
      await tx
        .update(badgeAward)
        .set({ achievedOn: m.achievedOn })
        .where(and(eq(badgeAward.badgeId, m.badgeId), eq(badgeAward.personId, m.personId)))
    }
    let removed = 0
    for (const [badgeId, personIds] of lost) {
      const gone = await tx
        .delete(badgeAward)
        .where(
          and(
            eq(badgeAward.badgeId, badgeId),
            eq(badgeAward.source, 'rule'),
            inArray(badgeAward.personId, personIds),
          ),
        )
        .returning({ personId: badgeAward.personId })
      removed += gone.length
    }
    return {
      awarded: awarded.map(({ badgeId, personId }) => ({ badgeId, personId })),
      removed,
      updated: moved.length,
    }
  })
}

// ---------------------------------------------------------------------------
// For medlemmene
// ---------------------------------------------------------------------------

/** Et merke slik det vises: ikonet (eller bildet), fargen og navnet. */
export type BadgeChip = {
  id: string
  slug: string
  name: string
  description: string
  icon: BadgeIcon
  color: BadgeColor
  /** Vises i stedet for ikonet. Fargen synes bak gjennomsiktige deler. */
  image: BadgeImage | null
}

const chipColumns = {
  id: badge.id,
  slug: badge.slug,
  name: badge.name,
  description: badge.description,
  icon: badge.icon,
  color: badge.color,
  imageKey: badge.imageKey,
}

/** Ukjente ikoner og farger (fra en eldre versjon) vises som standard. */
function chip({
  imageKey,
  ...row
}: {
  id: string
  slug: string
  name: string
  description: string
  icon: string
  color: string
  imageKey: string | null
}): BadgeChip {
  return {
    ...row,
    image: badgeImageUrls(imageKey),
    icon: (badgeIcons as readonly string[]).includes(row.icon) ? (row.icon as BadgeIcon) : 'award',
    color: (badgeColors as readonly string[]).includes(row.color)
      ? (row.color as BadgeColor)
      : 'stone',
  }
}

/** Trinnet et merke er i serien sin, fra 1. */
export type BadgeStep = { index: number; count: number }

/**
 * Trinnene i hver serie, i rekkefølgen admins har satt og så etter tallet
 * regelen krever. Serier med bare ett merke har ingen trinn.
 */
function seriesSteps(
  rows: { id: string; name: string; series: string | null; sortOrder: number; rule: BadgeRule }[],
): Map<string, BadgeStep> {
  const bySeries = new Map<string, typeof rows>()
  for (const r of rows) {
    if (!r.series) continue
    const key = r.series.toLocaleLowerCase('nb')
    bySeries.set(key, [...(bySeries.get(key) ?? []), r])
  }
  const steps = new Map<string, BadgeStep>()
  for (const ladder of bySeries.values()) {
    if (ladder.length < 2) continue
    ladder
      .sort(
        (a, b) =>
          a.sortOrder - b.sortOrder ||
          ruleLevel(a.rule) - ruleLevel(b.rule) ||
          a.name.localeCompare(b.name, 'nb'),
      )
      .forEach((r, i) => steps.set(r.id, { index: i + 1, count: ladder.length }))
  }
  return steps
}

/** Et merke på profilen. */
export type ProfileBadge = BadgeChip & {
  achievedOn: string | null
  citation: string | null
  /** Personen har skjult det; bare personen selv ser det da. */
  hidden: boolean
  rarity: BadgeRarity
  step: BadgeStep | null
  /** Regelen i ord: «Vært på ESAF-helgen minst 3 ganger». */
  ruleText: string
  /** Aktive medlemmer som har merket og ikke har skjult det. */
  holders: number
}

/** Merkene og nivået på en profil. */
export type ProfileBadges = { badges: ProfileBadge[]; level: PlayerStanding }

/**
 * Merkene på en profil. I en serie vises bare det høyeste trinnet. Skjulte
 * merker ser bare personen selv.
 */
export async function loadProfileBadges(
  db: Db,
  viewer: Viewer,
  personId: string,
): Promise<ProfileBadges> {
  assertMember(viewer)
  const own = viewer.personId === personId
  const [stats, published] = await Promise.all([
    loadBadgeStats(db),
    db
      .select({
        id: badge.id,
        name: badge.name,
        series: badge.series,
        sortOrder: badge.sortOrder,
        rule: badge.rule,
      })
      .from(badge)
      .where(eq(badge.status, 'published')),
  ])
  const steps = seriesSteps(published.map((b) => ({ ...b, rule: storedRule(b.rule) })))
  const rows = await db
    .select({
      ...chipColumns,
      series: badge.series,
      sortOrder: badge.sortOrder,
      rule: badge.rule,
      achievedOn: badgeAward.achievedOn,
      citation: badgeAward.citation,
      hidden: badgeAward.hidden,
    })
    .from(badgeAward)
    .innerJoin(badge, eq(badge.id, badgeAward.badgeId))
    .where(
      and(
        eq(badgeAward.personId, personId),
        eq(badge.status, 'published'),
        own ? undefined : eq(badgeAward.hidden, false),
      ),
    )
  // Laveste først: rekkefølgen admins har satt, så tallet regelen krever, så navnet.
  const rules = await withLiveEvents(
    db,
    rows.map((r) => storedRule(r.rule)),
  )
  const names = await loadRuleNames(db, rules)
  const sorted = rows
    .map((r, i) => ({ ...r, rule: rules[i]!, level: ruleLevel(rules[i]!) }))
    .sort(
      (a, b) =>
        a.sortOrder - b.sortOrder || a.level - b.level || a.name.localeCompare(b.name, 'nb'),
    )
  // I en serie vises bare det høyeste trinnet: det siste.
  const top = new Map<string, string>()
  for (const r of sorted) if (r.series) top.set(r.series.toLocaleLowerCase('nb'), r.id)
  const badges = sorted
    .filter((r) => !r.series || top.get(r.series.toLocaleLowerCase('nb')) === r.id)
    .map((r) => ({
      // Feltene plukkes ut: `chip` tar med alt den får, og regelen skal ikke til medlemmene.
      ...chip({
        id: r.id,
        slug: r.slug,
        name: r.name,
        description: r.description,
        icon: r.icon,
        color: r.color,
        imageKey: r.imageKey,
      }),
      achievedOn: r.achievedOn,
      citation: r.citation,
      hidden: r.hidden,
      rarity: stats.rarity(r.id),
      step: steps.get(r.id) ?? null,
      ruleText: describeBadgeRule(r.rule, names),
      holders: stats.holders.get(r.id) ?? 0,
    }))
  return { badges, level: playerStanding(stats, personId) }
}

/** Skjuler eller viser et av ens egne merker. */
export async function setOwnBadgeHidden(
  db: Db,
  viewer: Viewer,
  badgeId: string,
  hidden: boolean,
): Promise<void> {
  assertMember(viewer)
  const updated = await db
    .update(badgeAward)
    .set({ hidden })
    .where(and(eq(badgeAward.badgeId, badgeId), eq(badgeAward.personId, viewer.personId)))
    .returning({ badgeId: badgeAward.badgeId })
  if (!updated.length) throw new NotFoundError('Du har ikke dette merket.')
}

/** Et nytt merke, med hvor sjeldent det er og XP-en det gir, til feiringen. */
export type EarnedBadge = BadgeChip & { rarity: BadgeRarity }

/** Merkene som ble delt ut, slik de vises når den innloggede har fått nye. */
export async function badgeChips(db: Db | Tx, badgeIds: string[]): Promise<EarnedBadge[]> {
  if (!badgeIds.length) return []
  const [rows, stats] = await inOrder([
    () =>
      db
        .select(chipColumns)
        .from(badge)
        .where(inArray(badge.id, [...new Set(badgeIds)]))
        .orderBy(asc(badge.sortOrder), asc(badge.name)),
    () => loadBadgeStats(db),
  ] as const)
  return rows.map((row) => ({ ...chip(row), rarity: stats.rarity(row.id) }))
}

/** Merkene den innloggede nettopp fikk, og nivået etterpå. */
export type OwnBadgeUpdate = {
  badges: EarnedBadge[]
  level: PlayerStanding
  /** Nivået før, når det ble høyere nå. Null ellers. */
  previousLevel: number | null
}

/**
 * Oppdaterer merkene til den innloggede rett etter at hen har endret noe selv
 * (arrangementer, profilen), og gir tilbake merkene hen fikk nå og om nivået
 * gikk opp.
 */
export async function refreshOwnBadges(db: Db, viewer: Viewer): Promise<OwnBadgeUpdate> {
  assertMember(viewer)
  const before = playerStanding(await loadBadgeStats(db), viewer.personId)
  const { awarded } = await syncBadges(db, { personIds: [viewer.personId] })
  const [badges, stats] = await Promise.all([
    badgeChips(
      db,
      awarded.map((a) => a.badgeId),
    ),
    loadBadgeStats(db),
  ])
  const level = playerStanding(stats, viewer.personId)
  return { badges, level, previousLevel: level.level > before.level ? before.level : null }
}

// ---------------------------------------------------------------------------
// «Var du der?»: fylle inn arrangementene man har vært på
// ---------------------------------------------------------------------------

export type MissedEvent = {
  id: string
  name: string
  startDate: string
  endDate: string | null
  datePrecision: EventDatePrecision
  location: string | null
  /** Aktive medlemmer som var der. */
  participants: number
  /** Av dem, hvor mange fra den innloggedes kull. */
  fromCohort: number
}

export type MissedEventGroup = {
  type: { id: string; slug: string; name: string }
  events: MissedEvent[]
}

/**
 * Arrangementene den innloggede kan ha vært på, men ikke har sagt at hen var på:
 * de som har startet, fra året kullet hens startet på ES. Nyeste først, per
 * type, med hvor mange fra kullet som var der.
 */
export async function listMissedEvents(db: Db, viewer: Viewer): Promise<MissedEventGroup[]> {
  assertMember(viewer)
  const years = await db
    .select({ year: cohort.graduationYear })
    .from(personCohort)
    .innerJoin(cohort, eq(cohort.id, personCohort.cohortId))
    .where(eq(personCohort.personId, viewer.personId))
  const studentYears = years.map((y) => y.year)
  // Et kull starter på ES to år før det blir uteksaminert.
  const from = studentYears.length ? `${Math.min(...studentYears) - 2}-01-01` : null
  const mine = alias(eventParticipation, 'mine')
  const rows = await db
    .select({
      id: event.id,
      name: event.name,
      startDate: event.startDate,
      endDate: event.endDate,
      datePrecision: event.datePrecision,
      location: event.location,
      typeId: eventType.id,
      typeSlug: eventType.slug,
      typeName: eventType.name,
      participants: sql<number>`(select count(*)::int from ${eventParticipation} p inner join ${membership} m on m.person_id = p.person_id where p.event_id = ${event.id} and m.status = 'active')`,
      fromCohort: studentYears.length
        ? sql<number>`(select count(distinct p.person_id)::int from ${eventParticipation} p inner join ${membership} m on m.person_id = p.person_id inner join ${personCohort} pc on pc.person_id = p.person_id inner join ${cohort} c on c.id = pc.cohort_id where p.event_id = ${event.id} and m.status = 'active' and c.graduation_year in ${studentYears})`
        : sql<number>`0`,
    })
    .from(event)
    .innerJoin(eventType, eq(eventType.id, event.typeId))
    .leftJoin(mine, and(eq(mine.eventId, event.id), eq(mine.personId, viewer.personId)))
    .where(
      and(
        lte(event.startDate, osloToday()),
        from ? sql`${event.startDate} >= ${from}` : undefined,
        isNull(mine.personId),
      ),
    )
    .orderBy(asc(eventType.sortOrder), asc(eventType.name), desc(event.startDate))
    .limit(500)
  const groups: MissedEventGroup[] = []
  for (const { typeId, typeSlug, typeName, ...e } of rows) {
    let group = groups.at(-1)
    if (group?.type.id !== typeId) {
      group = { type: { id: typeId, slug: typeSlug, name: typeName }, events: [] }
      groups.push(group)
    }
    group.events.push(e)
  }
  return groups
}

/**
 * «Jeg var der» for flere arrangementer på én gang. Bare arrangementer som har
 * startet. Gir tilbake merkene den innloggede fikk av det.
 */
export async function addOwnParticipations(
  db: Db,
  viewer: Viewer,
  input: { eventIds: string[] },
): Promise<{ added: number } & OwnBadgeUpdate> {
  assertMember(viewer)
  const eventIds = z
    .array(z.uuid())
    .min(1, 'Velg minst ett arrangement.')
    .max(200, 'Høyst 200 om gangen.')
    .parse(input.eventIds)
  const added = await db.transaction(async (tx) => {
    const found = await tx
      .select({ id: event.id, startDate: event.startDate })
      .from(event)
      .where(inArray(event.id, [...new Set(eventIds)]))
    if (found.length !== new Set(eventIds).size) throw new NotFoundError('Fant ikke arrangementet.')
    if (found.some((e) => e.startDate > osloToday())) {
      throw new DomainError('Du kan bare si at du var på arrangementer som har vært.')
    }
    const rows = await tx
      .insert(eventParticipation)
      .values(
        found.map((e) => ({ eventId: e.id, personId: viewer.personId, source: 'self' as const })),
      )
      .onConflictDoNothing()
      .returning({ eventId: eventParticipation.eventId })
    return rows.length
  })
  return { added, ...(await refreshOwnBadges(db, viewer)) }
}

// ---------------------------------------------------------------------------
// For admins
// ---------------------------------------------------------------------------

export const badgeInput = z.object({
  name: z
    .string('Skriv et navn.')
    .trim()
    .min(2, 'Navnet må ha minst 2 tegn.')
    .max(40, 'Navnet kan ha maks 40 tegn.'),
  description: z
    .string('Skriv hva som skal til.')
    .trim()
    .min(3, 'Skriv hva som skal til.')
    .max(200, 'Teksten kan ha maks 200 tegn.'),
  icon: z.enum(badgeIcons, 'Velg et ikon.'),
  color: z.enum(badgeColors, 'Velg en farge.'),
  rule: badgeRule,
  series: optionalText(40).default(null),
  sortOrder: z.number().int().min(0).max(10_000).default(100),
})
export type BadgeInput = z.input<typeof badgeInput>
export type BadgeValues = z.output<typeof badgeInput>

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new DomainError(parsed.error.issues[0]?.message ?? 'Ugyldige felt.')
  return parsed.data
}

/** Regelen, validert, med typene og arrangementene den viser til. */
async function validRule(db: Db | Tx, input: unknown): Promise<BadgeRule> {
  const rule = parse(badgeRule, input)
  if ((rule.kind === 'event_count' || rule.kind === 'event_streak') && rule.eventTypeId) {
    const [found] = await db
      .select({ id: eventType.id })
      .from(eventType)
      .where(eq(eventType.id, rule.eventTypeId))
    if (!found) throw new NotFoundError('Fant ikke arrangementstypen.')
  }
  if (rule.kind === 'event_attended') {
    const ids = [...new Set(rule.eventIds)]
    const found = await db.select({ id: event.id }).from(event).where(inArray(event.id, ids))
    if (found.length !== ids.length) throw new NotFoundError('Fant ikke alle arrangementene.')
    return { ...rule, eventIds: ids }
  }
  return rule
}

/** Adressen for et nytt merke, fra navnet: «ESAF-helgen ×5» blir `esaf-helgen-5`. */
export const badgeSlug = (name: string) =>
  companySlug(name)
    .replace(/^selskap-/, 'merke-')
    .slice(0, 60)
    .replace(/-$/, '')

export type AdminBadge = BadgeChip & {
  status: BadgeStatus
  series: string | null
  sortOrder: number
  rule: BadgeRule
  ruleText: string
  manual: boolean
  /** Alle som har merket, uansett medlemskap. */
  awarded: number
  /** Av dem, aktive medlemmer: de som vises. */
  visible: number
  publishedAt: Date | null
  updatedAt: Date
}

/** Alle merkene, også utkast og arkiverte, til adminsiden. */
export async function listBadgesForAdmin(db: Db, viewer: Viewer): Promise<AdminBadge[]> {
  assertCan(viewer, 'badges.manage')
  const rows = await db
    .select({
      ...chipColumns,
      status: badge.status,
      series: badge.series,
      sortOrder: badge.sortOrder,
      rule: badge.rule,
      publishedAt: badge.publishedAt,
      updatedAt: badge.updatedAt,
      // Spørringen har bare én tabell, så kolonnene i underspørringene skrives med tabellnavn.
      awarded: sql<number>`(select count(*)::int from badge_award a where a.badge_id = "badge"."id")`,
      visible: sql<number>`(select count(*)::int from badge_award a inner join membership m on m.person_id = a.person_id where a.badge_id = "badge"."id" and m.status = 'active')`,
    })
    .from(badge)
    .orderBy(
      sql`case ${badge.status} when 'published' then 0 when 'draft' then 1 else 2 end`,
      asc(badge.sortOrder),
      asc(badge.name),
    )
  const rules = await withLiveEvents(
    db,
    rows.map((r) => storedRule(r.rule)),
  )
  const names = await loadRuleNames(db, rules)
  return rows.map(({ imageKey, ...row }, i) => ({
    ...row,
    ...chip({ ...row, imageKey }),
    rule: rules[i]!,
    ruleText: describeBadgeRule(rules[i]!, names),
    manual: isManualRule(rules[i]!),
  }))
}

export type AdminBadgeAward = {
  personId: string
  fullName: string
  status: string | null
  claimed: boolean
  source: 'rule' | 'manual'
  achievedOn: string | null
  citation: string | null
  hidden: boolean
  awardedBy: string | null
  createdAt: Date
}

/** Ett merke med alle som har det, til adminsiden og MCP. På id eller adresse. */
export async function getBadgeForAdmin(
  db: Db,
  viewer: Viewer,
  idOrSlug: string,
): Promise<AdminBadge & { awards: AdminBadgeAward[] }> {
  assertCan(viewer, 'badges.manage')
  const byId = z.uuid().safeParse(idOrSlug).success
  const all = await listBadgesForAdmin(db, viewer)
  const found = all.find((b) => (byId ? b.id === idOrSlug : b.slug === idOrSlug))
  if (!found) throw new NotFoundError('Fant ikke merket.')
  const awardedBy = alias(person, 'awarded_by')
  const awards = await db
    .select({
      personId: person.id,
      fullName: person.fullName,
      status: membership.status,
      userId: person.userId,
      source: badgeAward.source,
      achievedOn: badgeAward.achievedOn,
      citation: badgeAward.citation,
      hidden: badgeAward.hidden,
      awardedBy: awardedBy.fullName,
      createdAt: badgeAward.createdAt,
    })
    .from(badgeAward)
    .innerJoin(person, eq(person.id, badgeAward.personId))
    .leftJoin(membership, eq(membership.personId, person.id))
    .leftJoin(awardedBy, eq(awardedBy.id, badgeAward.awardedByPersonId))
    .where(eq(badgeAward.badgeId, found.id))
    .orderBy(sql`${badgeAward.achievedOn} asc nulls last`, asc(person.fullName))
  return {
    ...found,
    awards: awards.map(({ userId, ...a }) => ({ ...a, claimed: userId !== null })),
  }
}

export type BadgePreview = {
  ruleText: string
  /** Alle som ville fått merket, uansett medlemskap. */
  total: number
  /** Av dem, aktive medlemmer: de som får varsel og vises. */
  activeMembers: number
  /** De første, eldste først. */
  sample: { personId: string; fullName: string; status: string | null; achievedOn: string | null }[]
}

/** Hvem som ville fått et merke med denne regelen, uten å lagre noe. */
export async function previewBadgeRule(
  db: Db,
  viewer: Viewer,
  input: unknown,
  options: { sample?: number } = {},
): Promise<BadgePreview> {
  assertCan(viewer, 'badges.manage')
  const rule = await validRule(db, input)
  const names = await loadRuleNames(db, [rule])
  if (isManualRule(rule)) {
    return { ruleText: describeBadgeRule(rule, names), total: 0, activeMembers: 0, sample: [] }
  }
  const facts = await loadBadgeFacts(db, null)
  const hits = [...facts]
    .map(([personId, f]) => ({ personId, ...evaluateBadgeRule(rule, f) }))
    .filter((r) => r.earned)
  const people = hits.length
    ? await db
        .select({ id: person.id, fullName: person.fullName, status: membership.status })
        .from(person)
        .leftJoin(membership, eq(membership.personId, person.id))
        .where(
          inArray(
            person.id,
            hits.map((h) => h.personId),
          ),
        )
    : []
  const byId = new Map(people.map((p) => [p.id, p]))
  const rows = hits
    .map((h) => ({
      personId: h.personId,
      fullName: byId.get(h.personId)?.fullName ?? '',
      status: byId.get(h.personId)?.status ?? null,
      achievedOn: h.achievedOn,
    }))
    .sort(
      (a, b) =>
        (a.achievedOn ?? '9999').localeCompare(b.achievedOn ?? '9999') ||
        a.fullName.localeCompare(b.fullName, 'nb'),
    )
  return {
    ruleText: describeBadgeRule(rule, names),
    total: rows.length,
    activeMembers: rows.filter((r) => r.status === 'active').length,
    sample: rows.slice(0, options.sample ?? 25),
  }
}

/** Det skjemaet og MCP trenger for å bygge regler: typene, arrangementene, ikonene og fargene. */
export async function badgeOptions(db: Db, viewer: Viewer) {
  assertCan(viewer, 'badges.manage')
  const [types, events, programmes] = await Promise.all([
    db
      .select({ id: eventType.id, slug: eventType.slug, name: eventType.name })
      .from(eventType)
      .orderBy(asc(eventType.sortOrder), asc(eventType.name)),
    db
      .select({
        id: event.id,
        name: event.name,
        startDate: event.startDate,
        typeId: event.typeId,
      })
      .from(event)
      // Alle, så arrangementer en regel viser til, alltid kan velges bort i skjemaet.
      .orderBy(desc(event.startDate)),
    // Selskapene som er programmer: minst ett selskap har vært med der.
    db
      .selectDistinct({ id: company.id, slug: company.slug, name: company.name })
      .from(company)
      .innerJoin(companyEvent, eq(companyEvent.programmeCompanyId, company.id))
      .orderBy(asc(company.name)),
  ])
  return {
    eventTypes: types,
    events,
    programmes,
    programmeKinds: programmeKinds.map((kind) => ({ kind, name: programmeKindLabels[kind] })),
    icons: badgeIcons,
    colors: badgeColors,
    ruleKinds: badgeRuleKinds,
    eventRoles: badgeEventRoles,
    profileFields: badgeProfileFields.map((field) => ({
      field,
      name: badgeProfileFieldNames[field],
    })),
    boardRoles: boardRoles.map((role) => ({ role, name: boardRoleNames[role] })),
  }
}

/** Låser merket for resten av transaksjonen. */
async function lockBadge(tx: Tx, badgeId: string) {
  if (!z.uuid().safeParse(badgeId).success) throw new NotFoundError('Fant ikke merket.')
  const [row] = await tx.select().from(badge).where(eq(badge.id, badgeId)).for('update')
  if (!row) throw new NotFoundError('Fant ikke merket.')
  return { ...row, rule: storedRule(row.rule) }
}

const awardCount = async (tx: Tx, badgeId: string) =>
  (
    await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(badgeAward)
      .where(eq(badgeAward.badgeId, badgeId))
  )[0]!.n

/**
 * Lager et merke. Som utkast, med mindre `publish` er satt; da deles det ut med
 * en gang. Adressen lages fra navnet og får et tall bak hvis den er tatt.
 */
export async function createBadge(
  db: Db,
  viewer: Viewer,
  input: BadgeInput,
  options: { publish?: boolean } = {},
): Promise<{ id: string; slug: string; status: BadgeStatus }> {
  assertCan(viewer, 'badges.manage')
  const values = parse(badgeInput, input)
  const created = await db.transaction(async (tx) => {
    const rule = await validRule(tx, values.rule)
    const base = badgeSlug(values.name)
    const taken = new Set(
      (
        await tx
          .select({ slug: badge.slug })
          .from(badge)
          .where(sql`${badge.slug} = ${base} or ${badge.slug} like ${`${base}-%`}`)
      ).map((r) => r.slug),
    )
    let slug = base
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`
    const status: BadgeStatus = options.publish ? 'published' : 'draft'
    const [row] = await tx
      .insert(badge)
      .values({ ...values, rule, slug, status, publishedAt: options.publish ? new Date() : null })
      .returning({ id: badge.id, slug: badge.slug, status: badge.status })
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'badge.create',
      details: { badgeId: row!.id, slug, name: values.name, kind: rule.kind, status },
    })
    return row!
  })
  if (created.status === 'published') await syncBadges(db, { badgeIds: [created.id] })
  return created
}

/**
 * Retter et merke. Felter som ikke er med, beholdes. Et merke med regel kan
 * ikke bli et merke som deles ut for hånd, eller omvendt, når noen har det.
 * Er merket publisert, deles det ut på nytt etter den nye regelen.
 */
export async function updateBadge(
  db: Db,
  viewer: Viewer,
  badgeId: string,
  patch: Partial<BadgeInput>,
): Promise<void> {
  assertCan(viewer, 'badges.manage')
  const published = await db.transaction(async (tx) => {
    await lockBadgeWork(tx)
    const current = await lockBadge(tx, badgeId)
    // Arrangementer som er slettet siden, tas ut, så merket kan rettes.
    const [stored] = (await withLiveEvents(tx, [current.rule])) as [BadgeRule]
    const values = parse(badgeInput, {
      name: current.name,
      description: current.description,
      icon: current.icon,
      color: current.color,
      rule: stored,
      series: current.series,
      sortOrder: current.sortOrder,
      ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    })
    const rule = await validRule(tx, values.rule)
    if (isManualRule(rule) !== isManualRule(current.rule) && (await awardCount(tx, badgeId)) > 0) {
      throw new DomainError(
        isManualRule(rule)
          ? 'Merket er delt ut etter regelen og kan ikke gjøres om til et merke som deles ut for hånd. Lag et nytt merke.'
          : 'Merket er delt ut for hånd og kan ikke få en regel. Lag et nytt merke.',
      )
    }
    const changed = (Object.keys(values) as (keyof BadgeValues)[]).filter(
      (key) =>
        JSON.stringify(key === 'rule' ? rule : values[key]) !==
        JSON.stringify((current as Record<string, unknown>)[key]),
    )
    if (!changed.length) return false
    await tx
      .update(badge)
      .set({ ...values, rule, updatedAt: new Date() })
      .where(eq(badge.id, badgeId))
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'badge.edit',
      details: { badgeId, slug: current.slug, name: values.name, fields: changed },
    })
    return current.status === 'published' && changed.includes('rule')
  })
  if (published) await syncBadges(db, { badgeIds: [badgeId] })
}

/**
 * Publiserer eller arkiverer et merke. Et publisert merke deles ut med en gang
 * (merker med regel) og gir varsel til dem som har det. Et merke kan ikke bli
 * utkast igjen.
 */
export async function setBadgeStatus(
  db: Db,
  viewer: Viewer,
  badgeId: string,
  status: 'published' | 'archived',
): Promise<void> {
  assertCan(viewer, 'badges.manage')
  if (status !== 'published' && status !== 'archived') throw new DomainError('Ugyldig status.')
  const result = await db.transaction(async (tx) => {
    await lockBadgeWork(tx)
    const current = await lockBadge(tx, badgeId)
    if (current.status === status) return null
    await tx
      .update(badge)
      .set({
        status,
        updatedAt: new Date(),
        ...(status === 'published' && !current.publishedAt ? { publishedAt: new Date() } : {}),
      })
      .where(eq(badge.id, badgeId))
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: status === 'published' ? 'badge.publish' : 'badge.archive',
      details: { badgeId, slug: current.slug, name: current.name },
    })
    return status === 'published' && !isManualRule(current.rule)
  })
  if (result) await syncBadges(db, { badgeIds: [badgeId] })
}

/** Sletter et merke for godt, med alle som har det og bildet. Arkivering beholder historikken. */
export async function deleteBadge(
  db: Db,
  storage: ObjectStorage,
  viewer: Viewer,
  badgeId: string,
): Promise<void> {
  assertCan(viewer, 'badges.manage')
  const imageKey = await db.transaction(async (tx) => {
    await lockBadgeWork(tx)
    const current = await lockBadge(tx, badgeId)
    const holders = await awardCount(tx, badgeId)
    await tx.delete(badge).where(eq(badge.id, badgeId))
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'badge.delete',
      details: { slug: current.slug, name: current.name, holders },
    })
    return current.imageKey
  })
  if (imageKey) await deleteBadgeImageFiles(storage, imageKey)
}

const awardInput = z.object({
  personIds: z
    .array(z.uuid('Ugyldig person.'))
    .min(1, 'Velg minst én person.')
    .max(200, 'Høyst 200 om gangen.'),
  citation: optionalText(200).default(null),
})

/** Merket må deles ut for hånd og ikke være arkivert. */
function assertManual(current: { rule: BadgeRule; status: BadgeStatus }) {
  if (!isManualRule(current.rule)) {
    throw new DomainError(
      'Dette merket deles ut etter regelen. Rett dataene (arrangementer, styret, selskaper) i stedet.',
    )
  }
  if (current.status === 'archived') throw new DomainError('Merket er arkivert.')
}

/**
 * Deler ut et merke for hånd til personene, med en begrunnelse som vises. Har
 * noen det allerede, får de den nye begrunnelsen; uten begrunnelse beholdes
 * den gamle. Varsel når merket er publisert.
 */
export async function awardBadge(
  db: Db,
  viewer: Viewer,
  badgeId: string,
  input: { personIds: string[]; citation?: string | null },
): Promise<{ awarded: number; updated: number }> {
  assertCan(viewer, 'badges.manage')
  const values = parse(awardInput, input)
  return db.transaction(async (tx) => {
    await lockBadgeWork(tx)
    const current = await lockBadge(tx, badgeId)
    assertManual(current)
    const ids = [...new Set(values.personIds)]
    const people = await tx
      .select({ id: person.id, fullName: person.fullName })
      .from(person)
      .where(inArray(person.id, ids))
    if (people.length !== ids.length) throw new NotFoundError('Fant ikke alle personene.')
    const before = new Map(
      (
        await tx
          .select({ personId: badgeAward.personId, citation: badgeAward.citation })
          .from(badgeAward)
          .where(and(eq(badgeAward.badgeId, badgeId), inArray(badgeAward.personId, ids)))
      ).map((r) => [r.personId, r.citation]),
    )
    const fresh = ids.filter((id) => !before.has(id))
    // Har noen merket fra før, endres begrunnelsen bare når det er skrevet en ny.
    const recited =
      values.citation === null
        ? []
        : ids.filter((id) => before.has(id) && before.get(id) !== values.citation)
    if (fresh.length) {
      await tx.insert(badgeAward).values(
        fresh.map((personId) => ({
          badgeId,
          personId,
          source: 'manual' as const,
          citation: values.citation,
          awardedByPersonId: viewer.personId,
        })),
      )
    }
    if (recited.length) {
      await tx
        .update(badgeAward)
        .set({ citation: values.citation })
        .where(and(eq(badgeAward.badgeId, badgeId), inArray(badgeAward.personId, recited)))
    }
    const changed = [
      ...fresh.map((id) => [id, 'badge.award'] as const),
      ...recited.map((id) => [id, 'badge.citation'] as const),
    ]
    if (changed.length) {
      await tx.insert(auditEvent).values(
        changed.map(([personId, action]) => ({
          actorPersonId: viewer.personId,
          subjectPersonId: personId,
          action,
          details: { badgeId, slug: current.slug, name: current.name, citation: values.citation },
        })),
      )
    }
    return { awarded: fresh.length, updated: recited.length }
  })
}

/** Tar tilbake et merke som ble delt ut for hånd. */
export async function revokeBadge(
  db: Db,
  viewer: Viewer,
  badgeId: string,
  input: { personIds: string[] },
): Promise<{ revoked: number }> {
  assertCan(viewer, 'badges.manage')
  const { personIds } = parse(awardInput.pick({ personIds: true }), input)
  return db.transaction(async (tx) => {
    await lockBadgeWork(tx)
    const current = await lockBadge(tx, badgeId)
    if (!isManualRule(current.rule)) {
      throw new DomainError(
        'Dette merket deles ut etter regelen. Rett dataene (arrangementer, styret, selskaper) i stedet.',
      )
    }
    const gone = await tx
      .delete(badgeAward)
      .where(and(eq(badgeAward.badgeId, badgeId), inArray(badgeAward.personId, personIds)))
      .returning({ personId: badgeAward.personId })
    if (gone.length) {
      await tx.insert(auditEvent).values(
        gone.map((g) => ({
          actorPersonId: viewer.personId,
          subjectPersonId: g.personId,
          action: 'badge.revoke',
          details: { badgeId, slug: current.slug, name: current.name },
        })),
      )
    }
    return { revoked: gone.length }
  })
}

/** Alle merkene til en person, også skjulte og fra utkast og arkiverte merker, til admins. */
export async function loadPersonBadgesForAdmin(db: Db, viewer: Viewer, personId: string) {
  assertCan(viewer, 'badges.manage')
  return db
    .select({
      badgeId: badge.id,
      slug: badge.slug,
      name: badge.name,
      status: badge.status,
      source: badgeAward.source,
      achievedOn: badgeAward.achievedOn,
      citation: badgeAward.citation,
      hidden: badgeAward.hidden,
    })
    .from(badgeAward)
    .innerJoin(badge, eq(badge.id, badgeAward.badgeId))
    .where(eq(badgeAward.personId, personId))
    .orderBy(asc(badge.sortOrder), asc(badge.name))
}

/** Personer å dele ut et merke til, på navn. */
export async function findBadgeCandidates(
  db: Db,
  viewer: Viewer,
  query: string,
): Promise<{ personId: string; fullName: string; status: string | null; cohortYears: number[] }[]> {
  assertCan(viewer, 'badges.manage')
  const q = query.trim()
  if (q.length < 2) return []
  const rows = await db
    .select({
      personId: person.id,
      fullName: person.fullName,
      status: membership.status,
      cohortYears: sql<
        number[]
      >`coalesce((select array_agg(${cohort.graduationYear} order by ${cohort.graduationYear}) from ${personCohort} inner join ${cohort} on ${cohort.id} = ${personCohort.cohortId} where ${personCohort.personId} = ${person.id}), '{}')`,
    })
    .from(person)
    .leftJoin(membership, eq(membership.personId, person.id))
    .where(ilike(person.fullName, `%${q.replace(/[%_\\]/g, '\\$&')}%`))
    .orderBy(sql`${membership.status} is distinct from 'active'`, asc(person.fullName))
    .limit(20)
  return rows
}

/**
 * Flytter merkene når to personer slås sammen. Alle flyttes, også etter regel,
 * så merker på arkiverte merker blir stående og ingen får varsel om et merke
 * duplikatet allerede hadde. Merker med regel regnes ut på nytt etterpå.
 */
export async function moveBadgeAwards(tx: Tx, from: string, into: string): Promise<number> {
  const moved = await tx.execute(sql`
    insert into ${badgeAward} (badge_id, person_id, source, achieved_on, citation, awarded_by_person_id, hidden, created_at)
    select badge_id, ${into}, source, achieved_on, citation, awarded_by_person_id, hidden, created_at
    from ${badgeAward} where person_id = ${from}
    on conflict do nothing`)
  await tx.delete(badgeAward).where(eq(badgeAward.personId, from))
  return moved.rowCount ?? 0
}
