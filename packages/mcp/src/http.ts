import {
  API_TOKEN_PREFIX,
  authenticateApiToken,
  authenticateOAuthAccessToken,
  can,
  hashApiToken,
  MCP_OAUTH_SCOPES,
  OAUTH_ACCESS_TOKEN_PREFIX,
  type Embedder,
  type Mailer,
  type ObjectStorage,
  type Viewer,
} from '@esaf/core'
import type { Db } from '@esaf/db'
import { createMcpHandler } from '@modelcontextprotocol/server'
import type { ImageFetcher } from './images.ts'
import { createAdminMcpServer } from './server.ts'

/**
 * MCP over HTTP (Streamable HTTP, uten økter). Klienten viser hvem den er med
 * `Authorization: Bearer …`: en OAuth-tilgangsnøkkel (`esaf_at_…`, fra
 * innlogging i nettleseren) eller en MCP-nøkkel fra adminsiden «MCP»
 * (`esaf_…`). Reglene:
 *
 * - Nøkkelen slås opp ved hver forespørsel (`authenticateOAuthAccessToken`,
 *   `authenticateApiToken`), og kontoen må være aktiv admin med `mcp.access`
 *   akkurat nå. Ukjente, utløpte og tilbaketrukne nøkler får 401; kontoer uten
 *   rettigheten får 403.
 * - 401-svar peker på beskrivelsen av ressursen (RFC 9728,
 *   `resource_metadata`), så klienten kan starte innloggingen selv.
 * - Forespørsler med `Origin` fra et annet nettsted avvises, så en nettside ikke
 *   kan bruke en nøkkel nettleseren tilfeldigvis har. Ekte MCP-klienter sender
 *   ikke `Origin`. Ingen CORS-hoder settes.
 * - Grenser i minnet: 120 forespørsler i minuttet per nøkkel og 20 avviste
 *   forsøk i minuttet per IP-adresse. Appen kjører i én prosess.
 * - Svarene mellomlagres aldri (`Cache-Control: no-store`).
 */

export type AdminMcpHttpOptions = {
  db: Db
  storage: ObjectStorage
  /** `BETTER_AUTH_URL`: appens adresse, for lenker og opprinnelsessjekken. */
  appUrl: string
  /** Adressen til MCP-serveren, som OAuth-nøklene må være utstedt for. */
  resource: string
  /** Adressen til beskrivelsen av ressursen (RFC 9728), som 401-svar peker på. */
  resourceMetadataUrl: string
  fetchImage?: ImageFetcher
  embedder?: Embedder | null
  /** E-posten appen sender med, til testsending fra MCP. Null uten leverandør. */
  mailer?: Mailer | null
  /** IP-adressen bak forespørselen, til grensen for avviste forsøk. */
  clientAddress?: (request: Request) => string | null
  onError?: (error: Error) => void
}

/** Største forespørsel: et bilde som base64 (10 MB blir ca. 13,4 MB) med litt til overs. */
const MAX_BODY_BYTES = 15 * 1024 * 1024

class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** `true` hvis forespørselen er innenfor grensen. */
  take(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key)
    if (!entry || entry.resetAt <= now) {
      // Rydd bort gamle nøkler av og til, så kartet ikke vokser for alltid.
      if (this.hits.size > 10_000) {
        for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k)
      }
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs })
      return true
    }
    entry.count++
    return entry.count <= this.limit
  }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', ...headers },
  })

/** En JSON-RPC-feil uten id, som MCP-klienter viser til brukeren. */
const rpcError = (status: number, message: string, headers: Record<string, string> = {}) =>
  json(status, { jsonrpc: '2.0', id: null, error: { code: -32001, message } }, headers)

/**
 * 401 med utfordringen klienten trenger for å logge inn (RFC 6750 og RFC 9728).
 * Uten nøkkel er det ingen `error` (RFC 6750 §3.1). Teksten i hodet må være ASCII.
 */
const unauthorized = (message: string, resourceMetadataUrl: string, invalid: boolean) =>
  rpcError(401, message, {
    'www-authenticate': [
      'Bearer realm="ESAF"',
      `resource_metadata="${resourceMetadataUrl}"`,
      `scope="${MCP_OAUTH_SCOPES.join(' ')}"`,
      ...(invalid ? ['error="invalid_token"'] : []),
    ].join(', '),
  })

/** Lager håndtereren for `/api/mcp`. Én per prosess. */
export function createAdminMcpHttpHandler(options: AdminMcpHttpOptions) {
  const appOrigin = new URL(options.appUrl).origin
  const perToken = new RateLimiter(120, 60_000)
  const failures = new RateLimiter(20, 60_000)

  const handler = createMcpHandler(
    ({ authInfo }) => {
      const viewer = authInfo?.extra?.viewer as NonNullable<Viewer> | undefined
      // Kan ikke skje: håndtereren under sender bare forespørsler med en sjekket nøkkel hit.
      if (!viewer) throw new Error('MCP-forespørsel uten innlogget admin.')
      return createAdminMcpServer({
        db: options.db,
        storage: options.storage,
        viewer,
        appUrl: options.appUrl,
        fetchImage: options.fetchImage,
        embedder: options.embedder,
        mailer: options.mailer,
      })
    },
    { maxRequestBodySize: MAX_BODY_BYTES, onerror: options.onError },
  )

  return async function handle(request: Request): Promise<Response> {
    const origin = request.headers.get('origin')
    if (origin !== null && origin !== appOrigin) {
      return rpcError(403, 'Forespørsler fra nettlesere på andre nettsteder godtas ikke.')
    }
    const address = options.clientAddress?.(request) ?? 'unknown'
    const header = request.headers.get('authorization') ?? ''
    const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1]

    const reject = (response: Response) =>
      failures.take(address) ? response : rpcError(429, 'For mange forsøk. Vent et minutt.')

    if (!token) {
      return reject(
        unauthorized(
          'Logg inn med ESAF-kontoen din for å bruke adminverktøyene.',
          options.resourceMetadataUrl,
          false,
        ),
      )
    }
    const oauth = token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)
    const viewer = oauth
      ? await authenticateOAuthAccessToken(options.db, token, options.resource)
      : token.startsWith(API_TOKEN_PREFIX)
        ? await authenticateApiToken(options.db, token)
        : null
    if (!viewer) {
      return reject(
        unauthorized(
          oauth
            ? 'Innloggingen er utløpt eller koblet fra. Logg inn på nytt.'
            : 'MCP-nøkkelen er ugyldig, utløpt eller trukket tilbake.',
          options.resourceMetadataUrl,
          true,
        ),
      )
    }
    if (!can(viewer, 'mcp.access')) {
      return reject(rpcError(403, 'Kontoen har ikke lenger tilgang til adminverktøyene.'))
    }
    if (!perToken.take(hashApiToken(token))) {
      return rpcError(429, 'For mange forespørsler med denne nøkkelen. Vent et minutt.', {
        'retry-after': '60',
      })
    }

    const access = viewer.mcp!
    const response = await handler.fetch(request, {
      authInfo: {
        token: access.apiTokenId ?? access.oauthClientId,
        clientId: access.apiTokenId ?? access.oauthClientId,
        scopes: access.readOnly ? ['mcp:read'] : ['mcp:read', 'mcp:write'],
        extra: { viewer },
      },
    })
    const headers = new Headers(response.headers)
    headers.set('cache-control', 'no-store')
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
}
