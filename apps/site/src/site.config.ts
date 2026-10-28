/**
 * Alt innhold som må bekreftes av styret før lansering, samlet ett sted.
 * Felt som er `null` vises ikke på siden.
 */
export const siteConfig = {
  name: 'ESAF',
  fullName: 'NTNUs Entreprenørskoles Alumniforening',
  url: 'https://esaf.no',
  /** Foreningens generelle adresse, brukt i invitasjoner og styrekommunikasjon. */
  contactEmail: 'styret@esaf.no' as string | null,
  /** Lenke til ESAFs Facebook-gruppe eller -side. Ikke bekreftet ennå. */
  facebookUrl: null as string | null,
  /** NTNUs offisielle side om studieprogrammet. */
  schoolUrl: 'https://www.ntnu.no/studier/entreprenoerskap',
}
