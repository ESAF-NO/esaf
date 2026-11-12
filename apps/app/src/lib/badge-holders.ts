import type { AdminBadgeAward } from '@esaf/core'

/** Over så mange vises et søkefelt i lista over hvem som har merket. */
export const HOLDER_SEARCH_FROM = 10

type Holder = Pick<AdminBadgeAward, 'fullName' | 'achievedOn'>

/** Nyest først, de uten dato sist, så på navn. */
export function sortHolders<T extends Holder>(holders: readonly T[]): T[] {
  return [...holders].sort((a, b) => {
    if (a.achievedOn !== b.achievedOn) {
      if (!a.achievedOn) return 1
      if (!b.achievedOn) return -1
      return a.achievedOn < b.achievedOn ? 1 : -1
    }
    return a.fullName.localeCompare(b.fullName, 'nb')
  })
}

// Aksenter fjernes (é → e), men ikke ringen i å, som er en egen bokstav på norsk.
const normalize = (s: string) =>
  s
    .toLocaleLowerCase('nb')
    .normalize('NFD')
    .replace(/(?!\u030A)\p{M}/gu, '')
    .normalize('NFC')

/** Alle ordene i søket må finnes i navnet, uten hensyn til store bokstaver og aksenter. */
export function filterHolders<T extends Holder>(holders: readonly T[], query: string): T[] {
  const words = normalize(query).split(/\s+/).filter(Boolean)
  if (!words.length) return [...holders]
  return holders.filter((h) => {
    const name = normalize(h.fullName)
    return words.every((w) => name.includes(w))
  })
}

/** Et lite merke for medlemskap som ikke er aktivt, ellers null. */
export function holderStatusLabel(status: string | null): string | null {
  if (status === 'active') return null
  if (status === 'pending') return 'Venter'
  if (status === 'inactive') return 'Deaktivert'
  return 'Uten medlemskap'
}

/** «Etter regelen» eller «Delt ut for hånd». */
export function holderSourceLabel(source: AdminBadgeAward['source']): string {
  return source === 'manual' ? 'Delt ut for hånd' : 'Etter regelen'
}
