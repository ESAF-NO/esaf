import { schema, type CompanyEventType, type CompanyStatus, type Db } from '@esaf/db'
import { and, asc, eq, isNotNull } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { assertMember, can, type Viewer } from './access.ts'
import { eventSummary } from './company-events.ts'

const { company, companyEvent, cohort, experience, membership, person, personCohort } = schema
const programme = alias(company, 'programme')

/**
 * «ES-universet»: alle aktive medlemmer og selskapene de har startet, vært
 * ES-team i eller jobbet i, over tid. Til visningen i MCP-klienter (og senere
 * appen). Bare det medlemmer ser ellers: aktive medlemmer, navn, kull og
 * tilknytninger, aldri kontaktinfo. Hendelser med lav sikkerhet (hentet
 * automatisk fra nyhetssaker) ser bare admins med `profiles.edit`, merket
 * `uncertain`, som på selskapssiden.
 *
 * Årstall: et selskap «finnes» fra `founded_year`, ellers første «grunnlagt»-
 * hendelse, ellers første startår i erfaringen, ellers året før ES-teamet ble
 * uteksaminert. Nedlagt og oppkjøpt fra hendelsene (konkurs, oppløst og lagt
 * ned regnes som nedlagt), ellers bare fra statusen nå.
 */

export type UniversePerson = {
  id: string
  name: string
  /** Studentkullet (uteksamineringsår), ellers et annet kull, ellers null. */
  cohort: number | null
  claimed: boolean
}

export type UniverseCompany = {
  id: string
  slug: string
  name: string
  status: CompanyStatus
  tagline: string | null
  founded: number | null
  closed: number | null
  acquired: number | null
  /** Nedlagt- eller oppkjøpt-året kommer fra en hendelse ingen har bekreftet. */
  endUncertain: boolean
  /** Kapital, priser og lanseringer, med år. */
  milestones: { year: number; type: CompanyEventType; text: string; uncertain: boolean }[]
}

export type UniverseLink = {
  personId: string
  companyId: string
  role: 'founder' | 'es' | 'employee'
  from: number | null
  to: number | null
}

export type Universe = {
  generatedAt: string
  firstYear: number
  lastYear: number
  people: UniversePerson[]
  companies: UniverseCompany[]
  links: UniverseLink[]
}

const CLOSING: CompanyEventType[] = ['closed', 'bankrupt', 'dissolved']
const MILESTONES: CompanyEventType[] = ['funding', 'award', 'launch']

export async function getUniverse(db: Db, viewer: Viewer): Promise<Universe> {
  assertMember(viewer)
  const admin = can(viewer, 'profiles.edit')
  const active = and(eq(membership.personId, person.id), eq(membership.status, 'active'))
  const [people, cohorts, jobs, esTeams, companies, events] = await Promise.all([
    db
      .select({ id: person.id, name: person.fullName, userId: person.userId })
      .from(person)
      .innerJoin(membership, active)
      .orderBy(asc(person.fullName)),
    db
      .select({
        personId: personCohort.personId,
        year: cohort.graduationYear,
        relation: personCohort.relation,
      })
      .from(personCohort)
      .innerJoin(cohort, eq(cohort.id, personCohort.cohortId)),
    db
      .select({
        personId: experience.personId,
        companyId: experience.companyId,
        founder: experience.founder,
        startYear: experience.startYear,
        endYear: experience.endYear,
      })
      .from(experience)
      .innerJoin(person, eq(person.id, experience.personId))
      .innerJoin(membership, active),
    db
      .select({ personId: person.id, companyId: person.esCompanyId })
      .from(person)
      .innerJoin(membership, active)
      .where(isNotNull(person.esCompanyId)),
    db
      .select({
        id: company.id,
        slug: company.slug,
        name: company.name,
        status: company.status,
        tagline: company.tagline,
        foundedYear: company.foundedYear,
      })
      .from(company),
    db
      .select({
        companyId: companyEvent.companyId,
        date: companyEvent.date,
        type: companyEvent.type,
        text: companyEvent.text,
        confidence: companyEvent.confidence,
        programmeName: programme.name,
        programmeBatch: companyEvent.programmeBatch,
      })
      .from(companyEvent)
      .leftJoin(programme, eq(programme.id, companyEvent.programmeCompanyId))
      .orderBy(asc(companyEvent.date)),
  ])

  const cohortOf = new Map<string, number>()
  for (const c of [...cohorts].sort(
    (a, b) =>
      Number(a.relation !== 'student') - Number(b.relation !== 'student') || a.year - b.year,
  )) {
    if (!cohortOf.has(c.personId)) cohortOf.set(c.personId, c.year)
  }

  const links: UniverseLink[] = [
    ...jobs.map((j) => ({
      personId: j.personId,
      companyId: j.companyId,
      role: (j.founder ? 'founder' : 'employee') as UniverseLink['role'],
      from: j.startYear,
      to: j.endYear,
    })),
    ...esTeams.map((e) => {
      const year = cohortOf.get(e.personId)
      return {
        personId: e.personId,
        companyId: e.companyId!,
        role: 'es' as const,
        from: year ? year - 1 : null,
        to: null,
      }
    }),
  ]
  const linked = new Set(links.map((l) => l.companyId))
  const eventsOf = new Map<string, typeof events>()
  for (const e of events) {
    if (e.confidence === 'low' && !admin) continue
    eventsOf.set(e.companyId, [...(eventsOf.get(e.companyId) ?? []), e])
  }
  const year = (d: string) => Number(d.slice(0, 4))

  const universeCompanies = companies
    .filter((c) => linked.has(c.id))
    .map((c): UniverseCompany => {
      const evs = eventsOf.get(c.id) ?? []
      const own = links.filter((l) => l.companyId === c.id)
      const starts = own.map((l) => l.from).filter((y): y is number => y !== null)
      const founded =
        c.foundedYear ??
        (evs.find((e) => e.type === 'founded')
          ? year(evs.find((e) => e.type === 'founded')!.date)
          : null) ??
        (starts.length ? Math.min(...starts) : null)
      const closing = evs.find((e) => CLOSING.includes(e.type))
      const acquiredEvent = evs.find((e) => e.type === 'acquired')
      return {
        id: c.id,
        slug: c.slug,
        name: c.name,
        status: c.status,
        tagline: c.tagline,
        founded,
        closed: closing ? year(closing.date) : null,
        acquired: acquiredEvent ? year(acquiredEvent.date) : null,
        endUncertain: (closing ?? acquiredEvent)?.confidence === 'low',
        milestones: evs
          .filter((e) => MILESTONES.includes(e.type))
          .map((e) => ({
            year: year(e.date),
            type: e.type,
            text: eventSummary(e),
            uncertain: e.confidence === 'low',
          })),
      }
    })

  // Tidslinjen begynner med det første kullet; eldre selskaper (arbeidsgivere
  // grunnlagt lenge før) finnes fra starten.
  const now = new Date().getFullYear()
  const cohortYears = [...cohortOf.values()]
  const founded = universeCompanies.map((c) => c.founded).filter((y): y is number => y !== null)
  const start = cohortYears.length
    ? Math.min(...cohortYears) - 2
    : founded.length
      ? Math.min(...founded)
      : now - 10
  return {
    generatedAt: new Date().toISOString(),
    firstYear: start,
    lastYear: Math.max(now, ...cohortYears),
    people: people.map((p) => ({
      id: p.id,
      name: p.name,
      cohort: cohortOf.get(p.id) ?? null,
      claimed: p.userId !== null,
    })),
    companies: universeCompanies,
    links,
  }
}
