import { schema, type Db } from '@esaf/db'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { assertMember, type Viewer } from './access.ts'

const { cohort, experience, membership, person, personCohort } = schema

/** Sterkeste tilknytning først: grunnla, ES-selskap, jobber der, har jobbet der. */
export type CompanyRole = 'founder' | 'es' | 'current' | 'past'
const rank: Record<CompanyRole, number> = { founder: 0, es: 1, current: 2, past: 3 }

export type CompanyPerson = {
  personId: string
  fullName: string
  claimed: boolean
  role: CompanyRole
  title: string | null
}

export type Company = {
  /** Stabil nøkkel avledet av navnet, brukt i URL. */
  slug: string
  name: string
  /** Grunnlagt av en ES-alumn eller startet på Entreprenørskolen. */
  startedByAlumni: boolean
  /** Noen har oppgitt det som selskapet sitt på Entreprenørskolen. */
  esCompany: boolean
  people: CompanyPerson[]
  /** Kullene til gründerne og ES-teamet. */
  cohortYears: number[]
}

export const companySlug = (name: string) =>
  name
    .trim()
    .toLocaleLowerCase('nb')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ø/g, 'o')
    .replace(/æ/g, 'ae')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

/**
 * Selskaper ES-alumni har startet eller jobbet i, avledet av profilenes
 * «ES-selskap» og erfaring. Samme selskap samles uavhengig av skrivemåte.
 */
export async function listCompanies(db: Db, viewer: Viewer): Promise<Company[]> {
  assertMember(viewer)
  const active = and(eq(membership.personId, person.id), eq(membership.status, 'active'))
  const [esRows, roleRows] = await Promise.all([
    db
      .select({
        personId: person.id,
        fullName: person.fullName,
        userId: person.userId,
        company: person.esCompany,
      })
      .from(person)
      .innerJoin(membership, active)
      .where(isNotNull(person.esCompany)),
    db
      .select({
        personId: person.id,
        fullName: person.fullName,
        userId: person.userId,
        company: experience.company,
        title: experience.title,
        endYear: experience.endYear,
        founder: experience.founder,
      })
      .from(experience)
      .innerJoin(person, eq(person.id, experience.personId))
      .innerJoin(membership, active),
  ])

  const links = [
    ...esRows.map((r) => ({ ...r, company: r.company!, title: null, role: 'es' as CompanyRole })),
    ...roleRows.map((r) => ({
      ...r,
      role: (r.founder ? 'founder' : r.endYear === null ? 'current' : 'past') as CompanyRole,
    })),
  ]

  type Draft = Company & { names: Map<string, number> }
  const bySlug = new Map<string, Draft>()
  for (const link of links) {
    const slug = companySlug(link.company)
    if (!slug) continue
    const company: Draft = bySlug.get(slug) ?? {
      slug,
      name: link.company.trim(),
      startedByAlumni: false,
      esCompany: false,
      people: [],
      cohortYears: [],
      names: new Map(),
    }
    const name = link.company.trim()
    company.names.set(name, (company.names.get(name) ?? 0) + 1)
    company.startedByAlumni ||= link.role === 'founder' || link.role === 'es'
    company.esCompany ||= link.role === 'es'
    const existing = company.people.find((p) => p.personId === link.personId)
    if (!existing) {
      company.people.push({
        personId: link.personId,
        fullName: link.fullName,
        claimed: link.userId !== null,
        role: link.role,
        title: link.title,
      })
    } else if (rank[link.role] < rank[existing.role]) {
      existing.role = link.role
      existing.title = link.title ?? existing.title
    }
    bySlug.set(slug, company)
  }

  const teamIds = [...bySlug.values()].flatMap((c) =>
    c.people.filter((p) => p.role === 'founder' || p.role === 'es').map((p) => p.personId),
  )
  const years = teamIds.length
    ? await db
        .select({ personId: personCohort.personId, year: cohort.graduationYear })
        .from(personCohort)
        .innerJoin(cohort, eq(cohort.id, personCohort.cohortId))
        .where(inArray(personCohort.personId, [...new Set(teamIds)]))
    : []

  return [...bySlug.values()]
    .map(({ names, ...company }) => {
      const team = new Set(
        company.people
          .filter((p) => p.role === 'founder' || p.role === 'es')
          .map((p) => p.personId),
      )
      return {
        ...company,
        // Den vanligste skrivemåten vinner.
        name: [...names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? company.name,
        cohortYears: [
          ...new Set(years.filter((y) => team.has(y.personId)).map((y) => y.year)),
        ].sort(),
        people: company.people.sort(
          (a, b) => rank[a.role] - rank[b.role] || a.fullName.localeCompare(b.fullName, 'nb'),
        ),
      }
    })
    .sort(
      (a, b) =>
        Number(b.startedByAlumni) - Number(a.startedByAlumni) ||
        b.people.length - a.people.length ||
        a.name.localeCompare(b.name, 'nb'),
    )
}
