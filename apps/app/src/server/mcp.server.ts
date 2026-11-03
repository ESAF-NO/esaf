import { MCP_OAUTH_SCOPES } from '@esaf/core'
import { createAdminMcpHttpHandler } from '@esaf/mcp'
import { mcpResourceUrl } from './auth-config.server.ts'
import { auth } from './auth.server.ts'
import { db } from './db.server.ts'
import { mailer } from './email.server.ts'
import { env } from './env.server.ts'
import { storage } from './photos.server.ts'
import { embedder } from './search.server.ts'

/** Adressen til MCP-serveren, og til beskrivelsen av den for OAuth (RFC 9728). */
export const mcpResource = mcpResourceUrl(env.BETTER_AUTH_URL)
export const mcpResourceMetadataUrl = new URL(
  '/.well-known/oauth-protected-resource/api/mcp',
  env.BETTER_AUTH_URL,
).href

/**
 * Adminverktøyene som MCP-server på `/api/mcp`, for MCP-klienter som Claude.
 * Klienten logger inn med OAuth (se `auth-config.server.ts`) eller bruker en
 * MCP-nøkkel fra adminsiden «MCP». Reglene står i @esaf/mcp og i
 * `mcp-oauth.ts` og `api-tokens.ts` i @esaf/core.
 */
export const handleMcpRequest = createAdminMcpHttpHandler({
  db,
  storage,
  appUrl: env.BETTER_AUTH_URL,
  resource: mcpResource,
  resourceMetadataUrl: mcpResourceMetadataUrl,
  embedder,
  mailer,
  // Bak Coolify/Traefik: proxyen legger klientens adresse sist i X-Forwarded-For.
  // Det første leddet kan klienten skrive selv, så det brukes ikke.
  clientAddress: (request) =>
    request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() || null,
  onError: (error) => console.error('[esaf/mcp]', error),
})

/**
 * Beskrivelsen av MCP-serveren for OAuth (RFC 9728): hvilken OAuth-server som
 * utsteder nøkler for den (appen selv, under `/api/auth`), og rettighetene
 * klienten kan be om. `offline_access` er med, så klientene ber om
 * fornyelsesnøkkel og ikke må logge inn hver time.
 */
export async function protectedResourceMetadata() {
  const { baseURL } = await auth.$context
  return {
    resource: mcpResource,
    resource_name: 'ESAF admin',
    resource_documentation: new URL('/admin/mcp', env.BETTER_AUTH_URL).href,
    authorization_servers: [baseURL],
    bearer_methods_supported: ['header'],
    scopes_supported: [...MCP_OAUTH_SCOPES],
  }
}
