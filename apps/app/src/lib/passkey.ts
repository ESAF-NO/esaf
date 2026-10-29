import { useSyncExternalStore } from 'react'
import { authClient } from './auth-client.ts'

/** Feil fra Better Auth eller nettleseren, slik passkey-klienten gir dem. */
type AuthError = { code?: string; status?: number; message?: string } | null

/**
 * Feilkoder fra nettleseren når personen avbryter, lar dialogen gå ut på tid
 * eller en ny innlogging avbryter den forrige. Da viser vi ingen feil.
 */
const cancelled = new Set([
  'AUTH_CANCELLED',
  'REGISTRATION_CANCELLED',
  'ERROR_CEREMONY_ABORTED',
  'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY',
])

/** Om nettleseren kan bruke passkeys i det hele tatt. */
export const passkeysSupported = () =>
  typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function'

const unchanging = () => () => {}

/**
 * Om nettleseren støtter passkeys, som hook. `null` på serveren og under
 * hydrering, så serveren og nettleseren viser det samme først.
 */
export const usePasskeySupport = (): boolean | null =>
  useSyncExternalStore(unchanging, passkeysSupported, () => null)

/** Om nettleseren kan foreslå passkeys i e-postfeltet (betinget innlogging). */
export async function passkeyAutofillSupported() {
  if (!passkeysSupported()) return false
  const check = window.PublicKeyCredential.isConditionalMediationAvailable
  return typeof check === 'function' && (await check.call(window.PublicKeyCredential))
}

/**
 * Feilmelding på norsk for innlogging med passkey, eller `null` når personen
 * selv avbrøt. Sier aldri om en konto finnes.
 */
export function passkeySignInError(error: AuthError): string | null {
  if (!error) return null
  if (error.code && cancelled.has(error.code)) return null
  if (error.status === 429) return 'For mange forsøk. Vent litt og prøv igjen.'
  if (error.code === 'EMAIL_NOT_VERIFIED') {
    return 'Du må bekrefte e-postadressen din før du kan logge inn. Sjekk innboksen.'
  }
  if (error.code === 'USER_VERIFICATION_REQUIRED') {
    return 'Passkeyen må bekreftes med ansikt, fingeravtrykk eller PIN. Prøv igjen.'
  }
  return 'Passkeyen kunne ikke brukes her. Prøv igjen, eller logg inn med passord.'
}

/** Feilmelding på norsk for å legge til eller endre passkeys, eller `null` når personen avbrøt. */
export function passkeyManageError(error: AuthError, fallback: string): string | null {
  if (!error) return null
  if (error.code && cancelled.has(error.code)) return null
  if (error.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') {
    return 'Denne passkeyen er allerede lagt til.'
  }
  if (error.code === 'STRONG_AUTH_REQUIRED') {
    return 'Logg inn med en av passkeyene dine først. Det beskytter kontoen mot noen som bare kan passordet.'
  }
  if (error.code === 'SESSION_NOT_FRESH') {
    return 'Det er en stund siden du logget inn. Logg ut og inn igjen før du legger til en passkey.'
  }
  if (error.code === 'USER_VERIFICATION_REQUIRED') {
    return 'Passkeyen må kunne bekreftes med ansikt, fingeravtrykk eller PIN.'
  }
  return fallback
}

/**
 * Logger inn med passkey. Er man allerede innlogget, erstattes økten med en
 * passkey-økt, som er sterk nok til adminverktøyene.
 */
export async function signInWithPasskey(options: { autoFill?: boolean } = {}) {
  const { error } = await authClient.signIn.passkey({ autoFill: options.autoFill })
  return error
}
