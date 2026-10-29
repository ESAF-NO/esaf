import type { CompanyDetails, CompanyEvent, CompanyPerson } from '@esaf/core'

export type CompanyStatus = CompanyDetails['status']

export const statusLabels: Record<CompanyStatus, string> = {
  active: 'Aktiv',
  acquired: 'Oppkjøpt',
  closed: 'Nedlagt',
  unknown: 'Ukjent status',
}

export const statusOrder: CompanyStatus[] = ['active', 'acquired', 'closed', 'unknown']

export type CompanyEventType = CompanyEvent['type']

export const eventTypeLabels: Record<CompanyEventType, string> = {
  founded: 'Grunnlagt',
  funding: 'Kapital',
  award: 'Pris',
  launch: 'Lansering',
  acquired: 'Oppkjøpt',
  bankrupt: 'Konkurs',
  dissolved: 'Oppløst',
  closed: 'Lagt ned',
  other: 'Annet',
}

export const eventTypeOrder: CompanyEventType[] = [
  'founded',
  'funding',
  'award',
  'launch',
  'acquired',
  'bankrupt',
  'dissolved',
  'closed',
  'other',
]

/** Hva personen er eller var i selskapet, kort nok til å stå ved navnet. */
export function roleText({ role, title }: Pick<CompanyPerson, 'role' | 'title'>) {
  if (role === 'founder') return 'Gründer'
  if (role === 'es') return 'ES-team'
  if (role === 'current') return title ?? 'Jobber der'
  return title ? `Tidl. ${title}` : 'Har jobbet der'
}
