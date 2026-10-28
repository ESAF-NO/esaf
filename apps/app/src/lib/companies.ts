import type { CompanyDetails, CompanyPerson } from '@esaf/core'

export type CompanyStatus = CompanyDetails['status']

export const statusLabels: Record<CompanyStatus, string> = {
  active: 'Aktiv',
  acquired: 'Oppkjøpt',
  closed: 'Nedlagt',
}

export const statusOrder: CompanyStatus[] = ['active', 'acquired', 'closed']

/** Hva personen er eller var i selskapet, kort nok til å stå ved navnet. */
export function roleText({ role, title }: Pick<CompanyPerson, 'role' | 'title'>) {
  if (role === 'founder') return 'Gründer'
  if (role === 'es') return 'ES-team'
  if (role === 'current') return title ?? 'Jobber der'
  return title ? `Tidl. ${title}` : 'Har jobbet der'
}
