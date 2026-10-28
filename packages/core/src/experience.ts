import { schema, type Db } from '@esaf/db'
import { asc, inArray } from 'drizzle-orm'

const { experience } = schema

export type Experience = {
  id: string
  company: string
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
      company: experience.company,
      title: experience.title,
      startYear: experience.startYear,
      endYear: experience.endYear,
      founder: experience.founder,
    })
    .from(experience)
    .where(inArray(experience.personId, ids))
    .orderBy(asc(experience.position))
  for (const { personId, ...row } of rows) {
    byPerson.set(personId, [...(byPerson.get(personId) ?? []), row])
  }
  for (const [personId, list] of byPerson) byPerson.set(personId, sortExperience(list))
  return byPerson
}
