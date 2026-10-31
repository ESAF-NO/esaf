import {
  AccessDeniedError,
  assertMayApproveMcpClient,
  disconnectMcpClient,
  getMcpClient,
  listMcpConnections,
  MCP_SCOPE_READ,
  MCP_SCOPE_WRITE,
} from '@esaf/core'
import { createServerFn } from '@tanstack/react-start'
import { getRequest, getRequestHeaders } from '@tanstack/react-start/server'
import { z } from 'zod'
import { withViewer as run } from '#/server/access.server.ts'
import { auth } from '#/server/auth.server.ts'
import { db } from '#/server/db.server.ts'
import { decodeOAuthQuery, oauthQueryValid } from '#/server/oauth-query.ts'
import { getRequestViewer } from '#/server/viewer.server.ts'

/**
 * Godkjenningen når en MCP-klient kobler til med OAuth, og tilkoblingene på
 * adminsiden «MCP». Reglene står i `mcp-oauth.ts` i @esaf/core; OAuth-flyten
 * selv i Better Auth (`auth-config.server.ts`). Godkjenningssiden får
 * forespørselen signert av serveren (`q`, se `oauth-query.ts`), og
 * signaturen sjekkes før noe vises eller lagres.
 */

/** Den signerte forespørselen, som base64url. */
const encodedQuery = z.string().min(1).max(12000)

const validQuery = async (query: string) => oauthQueryValid(query, (await auth.$context).secret)

export type McpConsentRequest =
  | { state: 'expired' }
  | { state: 'unknown_client' }
  | {
      state: 'ready' | 'strong_auth_required' | 'forbidden'
      client: { name: string | null; uri: string | null; redirectHosts: string[] }
      /** Klienten ba om å kunne endre, ikke bare lese. */
      wantsWrite: boolean
    }

/** Det godkjenningssiden trenger: klienten, rettighetene og om den innloggede kan godkjenne. */
export const describeMcpConsent = createServerFn({ method: 'POST' })
  .validator(z.object({ q: encodedQuery }))
  .handler(async ({ data }): Promise<McpConsentRequest> => {
    const query = decodeOAuthQuery(data.q)
    if (!(await validQuery(query))) return { state: 'expired' }
    const params = new URLSearchParams(query)
    const client = await getMcpClient(db, params.get('client_id') ?? '')
    if (!client || client.disabled) return { state: 'unknown_client' }
    const scopes = (params.get('scope') ?? '').split(' ')
    const viewer = await getRequestViewer()
    let state: 'ready' | 'strong_auth_required' | 'forbidden' = 'ready'
    try {
      assertMayApproveMcpClient(viewer)
    } catch (error) {
      if (!(error instanceof AccessDeniedError)) throw error
      // En admin uten sterk økt kan ordne det på siden; andre kan bare avvise.
      state = error.reason === 'strong_auth_required' ? 'strong_auth_required' : 'forbidden'
    }
    return {
      state,
      client: { name: client.name, uri: client.uri, redirectHosts: client.redirectHosts },
      wantsWrite: scopes.includes(MCP_SCOPE_WRITE),
    }
  })

/**
 * Godkjenner eller avviser klienten. Gir adressen nettleseren skal videre til:
 * tilbake til klienten, med en kode eller med `access_denied`.
 */
export const decideMcpConsent = createServerFn({ method: 'POST' })
  .validator(z.object({ q: encodedQuery, accept: z.boolean(), readOnly: z.boolean() }))
  .handler(async ({ data }): Promise<{ url: string } | { error: string }> => {
    const query = decodeOAuthQuery(data.q)
    if (!(await validQuery(query))) {
      return { error: 'Forespørselen er utløpt. Start tilkoblingen på nytt fra klienten.' }
    }
    const params = new URLSearchParams(query)
    const requested = (params.get('scope') ?? '').split(' ').filter(Boolean)
    const scopes = data.readOnly ? requested.filter((s) => s !== MCP_SCOPE_WRITE) : requested
    const viewer = await getRequestViewer()
    if (data.accept) {
      try {
        assertMayApproveMcpClient(viewer)
      } catch {
        return { error: 'Bare admins som er logget inn med passkey eller tofaktor, kan godkjenne.' }
      }
      if (!scopes.includes(MCP_SCOPE_READ) && !scopes.includes(MCP_SCOPE_WRITE)) {
        return {
          error: data.readOnly
            ? 'Klienten ba bare om å endre, så den kan ikke få bare lesetilgang.'
            : 'Klienten ba ikke om tilgang til adminverktøyene.',
        }
      }
    }
    // Som om nettleseren sendte svaret selv: Better Auth trenger forespørselen.
    const response = await auth.api.oauth2Consent({
      request: getRequest(),
      headers: getRequestHeaders(),
      body: {
        accept: data.accept,
        scope: data.accept ? scopes.join(' ') : undefined,
        oauth_query: query,
      },
      asResponse: true,
    })
    const result = (await response.json().catch(() => null)) as { url?: string } | null
    if (!response.ok || !result?.url) {
      return { error: 'Godkjenningen gikk ikke gjennom. Start tilkoblingen på nytt fra klienten.' }
    }
    // Godkjenningen logges i `auth-config.server.ts`, uansett hvor den kom fra.
    return { url: result.url }
  })

export const fetchMcpConnections = createServerFn({ method: 'GET' }).handler(() =>
  run((viewer) => listMcpConnections(db, viewer)),
)

export const removeMcpConnection = createServerFn({ method: 'POST' })
  .validator(z.object({ clientId: z.string().min(1).max(200) }))
  .handler(({ data }) => run((viewer) => disconnectMcpClient(db, viewer, data.clientId)))
