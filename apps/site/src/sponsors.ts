/**
 * Sponsorer som vises på /sponsorer. Tomme lister skjules på siden.
 *
 * Det interne sponsorarket er en arbeidsliste, ikke en godkjent liste for nettsiden. Legg bare inn
 * en sponsor når styret har bekreftet navn, avtaletype, periode, lenke og beskrivelse, og sponsoren
 * har sagt ja til å bli nevnt. Siden viser ikke logoer ennå.
 */
export interface Sponsor {
  /** Navnet slik sponsoren selv skriver det. */
  name: string
  /** Avtaletypen, for eksempel «Helårspartner», «Eventpartner» eller «ESAF-helg-partner». */
  partnership?: string
  /** For eksempel «2026» eller «2024–2025». */
  period?: string
  /** Lenke til sponsorens nettside. */
  url?: string
  /** Kort beskrivelse av bedriften, godkjent av sponsoren. Inngår i helårspartnerpakken. */
  description?: string
}

export const currentSponsors: Sponsor[] = []

export const previousSponsors: Sponsor[] = []
