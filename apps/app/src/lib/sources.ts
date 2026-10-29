import type { CompanySourceField, FieldSource, ProfileSourceField } from '@esaf/core'

export const confidenceLabels: Record<NonNullable<FieldSource['confidence']>, string> = {
  high: 'høy sikkerhet',
  medium: 'middels sikkerhet',
  low: 'lav sikkerhet',
}

export const companyFieldLabels: Record<CompanySourceField, string> = {
  name: 'Navn',
  logo: 'Logo',
  tagline: 'Kort beskrivelse',
  description: 'Om selskapet',
  status: 'Status',
  lastSeenOnEsSite: 'Sist nevnt på ES-siden',
  foundedYear: 'Grunnlagt',
  location: 'Sted',
  website: 'Nettside',
  industries: 'Bransjer',
}

export const profileFieldLabels: Record<ProfileSourceField, string> = {
  photo: 'Bilde',
  bio: 'Om',
  experience: 'Erfaring',
  expertise: 'Kan hjelpe med',
  industries: 'Bransjer',
  esCompany: 'Selskap på ES',
  studyBackground: 'Studieretning før ES',
  city: 'Bor i',
  linkedinUrl: 'LinkedIn',
}

/** Feltene i samme rekkefølge som på profilsiden. */
export const profileFields = Object.keys(profileFieldLabels) as ProfileSourceField[]

/** Kildene for ett felt, eller `[]`. */
export const sourcesFor = <F extends string>(sources: FieldSource<F>[], field: F) =>
  sources.filter((s) => s.field === field)

/** Feltet er importert og ingen har bekreftet det ennå. */
export const unconfirmed = (sources: FieldSource[]) =>
  sources.length > 0 && !sources.some((s) => s.confirmed)
