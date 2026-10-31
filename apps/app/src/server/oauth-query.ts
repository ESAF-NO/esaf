import { verifyOAuthQueryParams } from '@better-auth/oauth-provider'

/**
 * Den signerte forespørselen OAuth-serveren sender til innloggingen og
 * godkjenningen (se `routes/api/mcp-oauth/` og `/mcp/godkjenn`).
 *
 * OAuth-serveren sender nettleseren videre med forespørselen fra klienten i
 * adressen, signert (`sig`, gyldig i ti minutter). Signaturen gjelder akkurat de
 * parameterne, så søkestrengen sendes videre uendret: til godkjenningssiden som
 * én verdi (`q`, base64url), så ruteren ikke skriver den om.
 */

/** Parameterne serveren legger til når den signerer, og som ikke hører til selve forespørselen. */
const SIGNING_PARAMS = ['sig', 'exp', 'ba_iat', 'ba_pl', 'ba_param']

export const oauthQueryValid = (query: string, secret: string): Promise<boolean> =>
  verifyOAuthQueryParams(query, secret).catch(() => false)

/** Den signerte søkestrengen som én verdi i adressen til godkjenningssiden. */
export const encodeOAuthQuery = (query: string) => Buffer.from(query, 'utf8').toString('base64url')

export const decodeOAuthQuery = (value: string) => Buffer.from(value, 'base64url').toString('utf8')

/**
 * Adressen som starter forespørselen fra klienten på nytt etter innloggingen,
 * nå med økt. Uten `prompt=login` og `max_age`, ellers sender serveren personen
 * rett tilbake til innloggingen.
 */
export function resumeAuthorizationUrl(query: string): string {
  const params = new URLSearchParams(query)
  for (const name of SIGNING_PARAMS) params.delete(name)
  const prompt = (params.get('prompt') ?? '').split(' ').filter((p) => p && p !== 'login')
  if (prompt.length) params.set('prompt', prompt.join(' '))
  else params.delete('prompt')
  params.delete('max_age')
  return `/api/auth/oauth2/authorize?${params}`
}
