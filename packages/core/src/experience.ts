import { schema, type Db } from '@esaf/db'
import { asc, eq, inArray } from 'drizzle-orm'
import { logoUrls, type CompanyLogoUrls } from './logos.ts'

const { company, experience } = schema

export type Experience = {
  id: string
  companyId: string
  /** Navnet på selskapet, slik det står på selskapssiden. */
  company: string
  companySlug: string
  companyLogo: CompanyLogoUrls | null
  title: string | null
  startYear: number | null
  /** Null betyr at personen fortsatt er der. */
  endYear: number | null
  founder: boolean
}

type Dated = Pick<Experience, 'startYear' | 'endYear'>

/**
 * Nåværende først, deretter tidligere etter sluttår og startår, nyeste øverst.
 * Sorteringen er stabil, så ved likt årstall gjelder rekkefølgen personen valgte.
 */
export function sortExperience<T extends Dated>(list: T[]): T[] {
  return [...list].sort(
    (a, b) =>
      Number(b.endYear === null) - Number(a.endYear === null) ||
      (b.endYear ?? 0) - (a.endYear ?? 0) ||
      (b.startYear ?? 0) - (a.startYear ?? 0),
  )
}

/** Stillingen som vises under navnet: den øverste nåværende. */
export function currentRole(
  list: Pick<Experience, 'company' | 'title' | 'endYear' | 'founder'>[],
): { jobTitle: string | null; currentCompany: string | null } {
  const now = list.find((e) => e.endYear === null)
  if (!now) return { jobTitle: null, currentCompany: null }
  return { jobTitle: now.title ?? (now.founder ? 'Gründer' : null), currentCompany: now.company }
}

/** Erfaring for flere personer på én gang, sortert for visning. */
export async function loadExperience(
  db: Db,
  personIds: string[],
): Promise<Map<string, Experience[]>> {
  const ids = [...new Set(personIds)]
  const byPerson = new Map<string, Experience[]>()
  if (!ids.length) return byPerson
  const rows = await db
    .select({
      personId: experience.personId,
      id: experience.id,
      companyId: experience.companyId,
      company: company.name,
      companySlug: company.slug,
      logoKey: company.logoKey,
      title: experience.title,
      startYear: experience.startYear,
      endYear: experience.endYear,
      founder: experience.founder,
    })
    .from(experience)
    .innerJoin(company, eq(company.id, experience.companyId))
    .where(inArray(experience.personId, ids))
    .orderBy(asc(experience.position))
  for (const { personId, logoKey, ...row } of rows) {
    const entry = { ...row, companyLogo: logoUrls(logoKey) }
    byPerson.set(personId, [...(byPerson.get(personId) ?? []), entry])
  }
  for (const [personId, list] of byPerson) byPerson.set(personId, sortExperience(list))
  return byPerson
}
