import { createAdminMcpHttpHandler } from '@esaf/mcp'
import { db } from './db.server.ts'
import { env } from './env.server.ts'
import { storage } from './photos.server.ts'
import { embedder, searchAi } from './search.server.ts'

/**
 * Adminverktøyene som MCP-server på `/api/mcp`, for MCP-klienter som Claude med
 * en MCP-nøkkel fra «Konto og sikkerhet». Reglene står i @esaf/mcp og
 * `api-tokens.ts` i @esaf/core.
 */
export const handleMcpRequest = createAdminMcpHttpHandler({
  db,
  storage,
  appUrl: env.BETTER_AUTH_URL,
  embedder,
  ai: searchAi,
  // Bak Coolify/Traefik: proxyen legger klientens adresse sist i X-Forwarded-For.
  // Det første leddet kan klienten skrive selv, så det brukes ikke.
  clientAddress: (request) =>
    request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() || null,
  onError: (error) => console.error('[esaf/mcp]', error),
})
