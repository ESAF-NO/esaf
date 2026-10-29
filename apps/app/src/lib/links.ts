/**
 * Felles for sidene med et hemmelig token i adressen (invitasjoner og lenker for
 * nytt passord). Adressen sendes aldri videre som referrer, og svaret caches ikke.
 */
export const noReferrer = {
  headers: { 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' },
  meta: { name: 'referrer', content: 'no-referrer' },
}

/** Feil fra endepunktene for lenkene, slik Better Auth-klienten gir dem. */
type LinkError = { code?: string; status?: number; message?: string }

/** Norsk tekst for en feil. Feilene om selve lenken kommer ferdig skrevet fra serveren. */
export function linkError(error: LinkError): string {
  if (error.status === 429) return 'For mange forsøk. Vent et minutt og prøv igjen.'
  if (error.code?.startsWith('INVITATION_') && error.message) return error.message
  if (error.code === 'PASSWORD_TOO_SHORT') return 'Passordet må ha minst 12 tegn.'
  if (error.code === 'PASSWORD_TOO_LONG') return 'Passordet er for langt.'
  return 'Noe gikk galt. Prøv igjen.'
}

/**
 * En intern adresse å sende den innloggede videre til, eller `undefined`.
 * Bare stier i appen godtas, så lenken ikke kan sende noen til et annet nettsted.
 */
export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return undefined
  return value
}
