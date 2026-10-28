/**
 * Alt innhold som må bekreftes av styret før lansering, samlet ett sted.
 * Felt som er `null` vises ikke på siden.
 */
export const siteConfig = {
  name: 'ESAF',
  fullName: 'Entreprenørskolens Alumniforening',
  url: 'https://esaf.no',
  /**
   * Offentlig kontaktadresse. Adresse i Cloudflare Email Routing for esaf.no som videresender til styret,
   * slik at foreningens interne adresse ikke publiseres. Adressen må være satt opp før lansering.
   */
  contactEmail: 'styret@esaf.no' as string | null,
  /** Lenke til ESAFs Facebook-gruppe eller -side. Ikke bekreftet ennå. */
  facebookUrl: null as string | null,
  /** NTNUs offisielle side om studieprogrammet. */
  schoolUrl: 'https://www.ntnu.no/studier/entreprenoerskap',
  /** Entreprenørskolens egen nettside. */
  schoolSiteUrl: 'https://www.entreprenorskolen.no/',
}
