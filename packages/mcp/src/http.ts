import {
  authenticateApiToken,
  can,
  hashApiToken,
  type Embedder,
  type ObjectStorage,
  type SearchAi,
  type Viewer,
} from '@esaf/core'
import type { Db } from '@esaf/db'
import { createMcpHandler } from '@modelcontextprotocol/server'
import type { ImageFetcher } from './images.ts'
import { createAdminMcpServer } from './server.ts'

/**
 * MCP over HTTP (Streamable HTTP, uten økter), med MCP-nøkler fra «Konto og
 * sikkerhet» som `Authorization: Bearer esaf_…`. Reglene:
 *
 * - Nøkkelen slås opp ved hver forespørsel (`authenticateApiToken`), og kontoen
 *   må være aktiv admin med `mcp.access` akkurat nå. Ukjente, utløpte og
 *   tilbaketrukne nøkler får 401; kontoer uten rettigheten får 403.
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
  fetchImage?: ImageFetcher
  embedder?: Embedder | null
  ai?: SearchAi | null
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

const unauthorized = (message: string) =>
  rpcError(401, message, {
    'www-authenticate': `Bearer realm="ESAF", error="invalid_token", error_description="${message}"`,
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
        ai: options.ai,
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
        unauthorized('Mangler MCP-nøkkel. Lag en under Konto og sikkerhet i ESAF-appen.'),
      )
    }
    const viewer = await authenticateApiToken(options.db, token)
    if (!viewer) {
      return reject(unauthorized('MCP-nøkkelen er ugyldig, utløpt eller trukket tilbake.'))
    }
    if (!can(viewer, 'mcp.access')) {
      return reject(
        rpcError(403, 'Kontoen bak nøkkelen har ikke lenger tilgang til adminverktøyene.'),
      )
    }
    if (!perToken.take(hashApiToken(token))) {
      return rpcError(429, 'For mange forespørsler med denne nøkkelen. Vent et minutt.', {
        'retry-after': '60',
      })
    }

    const response = await handler.fetch(request, {
      authInfo: {
        token: viewer.apiToken!.id,
        clientId: viewer.apiToken!.id,
        scopes: viewer.apiToken!.readOnly ? ['read'] : ['read', 'write'],
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
