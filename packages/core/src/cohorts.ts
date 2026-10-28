import { schema, type Db } from '@esaf/db'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { assertMember, type Viewer } from './access.ts'
import { companySlug } from './companies.ts'
import { NotFoundError } from './errors.ts'
import { listPosts, type PostSummary } from './feed.ts'
import { listActiveMembers, type MemberListItem } from './members.ts'

const { cohort, membership, person, personCohort } = schema

export type CohortPerson = { personId: string; fullName: string; claimed: boolean }

export type CohortSummary = {
  graduationYear: number
  members: number
  claimed: number
  /** Noen å vise som ansikter, verifiserte først. */
  preview: CohortPerson[]
}

const PREVIEW = 6

/** Alle kull med aktive medlemmer, nyeste først. */
export async function listCohorts(db: Db, viewer: Viewer): Promise<CohortSummary[]> {
  assertMember(viewer)
  const rows = await db
    .select({
      year: cohort.graduationYear,
      personId: person.id,
      fullName: person.fullName,
      userId: person.userId,
    })
    .from(cohort)
    .innerJoin(personCohort, eq(personCohort.cohortId, cohort.id))
    .innerJoin(person, eq(person.id, personCohort.personId))
    .innerJoin(membership, and(eq(membership.personId, person.id), eq(membership.status, 'active')))
    .orderBy(desc(cohort.graduationYear), sql`${person.userId} is null`, asc(person.fullName))

  const byYear = new Map<number, CohortSummary>()
  for (const row of rows) {
    const summary = byYear.get(row.year) ?? {
      graduationYear: row.year,
      members: 0,
      claimed: 0,
      preview: [],
    }
    summary.members++
    if (row.userId) summary.claimed++
    if (summary.preview.length < PREVIEW) {
      summary.preview.push({
        personId: row.personId,
        fullName: row.fullName,
        claimed: row.userId !== null,
      })
    }
    byYear.set(row.year, summary)
  }
  return [...byYear.values()]
}

export type CommunityOverview = {
  members: number
  claimed: number
  cohorts: CohortSummary[]
  /** Kullene den innloggede selv gikk i. */
  ownYears: number[]
}

/** Alle kull, totaltall og den innloggedes egne kull, til forsiden og kulloversikten. */
export async function communityOverview(db: Db, viewer: Viewer): Promise<CommunityOverview> {
  assertMember(viewer)
  const [cohorts, [totals], own] = await Promise.all([
    listCohorts(db, viewer),
    db
      .select({
        members: sql<number>`count(*)::int`,
        claimed: sql<number>`count(${person.userId})::int`,
      })
      .from(membership)
      .innerJoin(person, eq(person.id, membership.personId))
      .where(eq(membership.status, 'active')),
    db
      .select({ year: cohort.graduationYear })
      .from(personCohort)
      .innerJoin(cohort, eq(cohort.id, personCohort.cohortId))
      .where(eq(personCohort.personId, viewer.personId)),
  ])
  return {
    members: totals?.members ?? 0,
    claimed: totals?.claimed ?? 0,
    cohorts,
    ownYears: own.map((o) => o.year).sort(),
  }
}

export type CohortCompany = {
  /** Samme nøkkel som i selskapskatalogen. */
  slug: string
  name: string
  /** Noen i kullet hadde det som selskapet sitt på Entreprenørskolen. */
  esCompany: boolean
  /** Gründerne og ES-teamet fra kullet, gründerne først. */
  people: (CohortPerson & { role: 'founder' | 'es' })[]
}

export type CohortPage = {
  graduationYear: number
  /** Kallenavnet kullet selv bruker, hvis det har et. */
  name: string | null
  members: number
  claimed: number
  /** Den innloggede går selv i kullet. */
  isOwn: boolean
  /** Alle i kullet med aktivt medlemskap, i samme form som katalogen. */
  people: MemberListItem[]
  /** Selskaper folk i kullet har grunnlagt eller hadde på Entreprenørskolen. */
  companies: CohortCompany[]
  /** De nyeste innleggene fra folk i kullet. */
  posts: PostSummary[]
}

const RECENT_POSTS = 5

/** Siden for ett kull: folkene, selskapene de har startet, og hva de har skrevet. */
export async function getCohortPage(
  db: Db,
  viewer: Viewer,
  graduationYear: number,
): Promise<CohortPage> {
  assertMember(viewer)
  if (!Number.isInteger(graduationYear)) throw new NotFoundError('Fant ikke kullet.')
  const [row] = await db
    .select({ name: cohort.name })
    .from(cohort)
    .where(eq(cohort.graduationYear, graduationYear))
  if (!row) throw new NotFoundError('Fant ikke kullet.')

  const [people, posts] = await Promise.all([
    listActiveMembers(db, viewer, { cohortYear: graduationYear }),
    listPosts(db, viewer, { cohortYear: graduationYear, sort: 'new', limit: RECENT_POSTS }),
  ])
  return {
    graduationYear,
    name: row.name,
    members: people.length,
    claimed: people.filter((p) => p.claimed).length,
    isOwn: people.some((p) => p.personId === viewer.personId),
    people,
    companies: companiesStartedBy(people),
    posts,
  }
}

/**
 * Selskaper fra profilenes «ES-selskap» og erfaring der personen er gründer.
 * Samme selskap samles uavhengig av skrivemåte, som i selskapskatalogen.
 */
function companiesStartedBy(people: MemberListItem[]): CohortCompany[] {
  type Draft = CohortCompany & { names: Map<string, number> }
  const bySlug = new Map<string, Draft>()
  const add = (rawName: string, p: MemberListItem, role: 'founder' | 'es') => {
    const slug = companySlug(rawName)
    if (!slug) return
    const name = rawName.trim()
    const company: Draft = bySlug.get(slug) ?? {
      slug,
      name,
      esCompany: false,
      people: [],
      names: new Map(),
    }
    company.names.set(name, (company.names.get(name) ?? 0) + 1)
    company.esCompany ||= role === 'es'
    const existing = company.people.find((x) => x.personId === p.personId)
    if (!existing) {
      company.people.push({ personId: p.personId, fullName: p.fullName, claimed: p.claimed, role })
    } else if (role === 'founder') {
      existing.role = 'founder'
    }
    bySlug.set(slug, company)
  }
  for (const p of people) {
    if (p.esCompany) add(p.esCompany, p, 'es')
    for (const e of p.experience) if (e.founder) add(e.company, p, 'founder')
  }

  return [...bySlug.values()]
    .map(({ names, ...company }) => ({
      ...company,
      // Den vanligste skrivemåten vinner.
      name: [...names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? company.name,
      people: company.people.sort(
        (a, b) =>
          Number(b.role === 'founder') - Number(a.role === 'founder') ||
          a.fullName.localeCompare(b.fullName, 'nb'),
      ),
    }))
    .sort((a, b) => b.people.length - a.people.length || a.name.localeCompare(b.name, 'nb'))
}
