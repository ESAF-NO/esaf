import type { MemberListItem } from '@esaf/core'

export const fold = (s: string) => s.toLocaleLowerCase('nb').normalize('NFD').replace(/[̀-ͯ]/g, '')

/**
 * Tekst et medlem kan finnes på: navn, nåværende og tidligere selskaper og
 * stillinger, by, studieretning, ES-selskap, ekspertise og bransjer.
 */
function haystack(m: MemberListItem) {
  return fold(
    [
      m.fullName,
      ...m.experience.flatMap((e) => [e.company, e.title]),
      m.city,
      m.studyBackground,
      m.esCompany,
      ...m.expertise,
      ...m.industries,
    ]
      .filter(Boolean)
      .join(' '),
  )
}

/** Alle ord i søket må finnes et sted i profilen. */
export function filterMembers(
  members: MemberListItem[],
  { q, kull }: { q?: string; kull?: number },
) {
  const words = fold(q ?? '')
    .split(/\s+/)
    .filter(Boolean)
  return members.filter(
    (m) =>
      (kull === undefined || m.cohorts.some((c) => c.graduationYear === kull)) &&
      words.every((w) => haystack(m).includes(w)),
  )
}
