import { schema, type Db } from '@esaf/db'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { assertMember, type Viewer } from './access.ts'
import { photoUrls, type ProfilePhoto } from './photos.ts'

const { cohort, membership, person, personCohort } = schema

export type CohortPerson = {
  personId: string
  fullName: string
  photo: ProfilePhoto | null
  claimed: boolean
}

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
      photoKey: person.photoKey,
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
        photo: photoUrls(row.photoKey),
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
