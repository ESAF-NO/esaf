import { createFileRoute } from '@tanstack/react-router'
import { auth } from '#/server/auth.server.ts'
import { protectedResourceMetadata } from '#/server/mcp.server.ts'

/**
 * Beskrivelsene MCP-klienter leser for å finne ut hvordan de logger inn:
 *
 * - `/.well-known/oauth-protected-resource/api/mcp` (RFC 9728): MCP-serveren,
 *   hvilken OAuth-server som utsteder nøkler for den, og rettighetene. 401-svar
 *   fra `/api/mcp` peker hit.
 * - `/.well-known/oauth-authorization-server/api/auth` (RFC 8414): OAuth-serveren,
 *   med adressene for registrering, innlogging og nøkler. Svaret lages av
 *   Better Auth.
 *
 * Begge er offentlige og like for alle, så hvem som helst kan lese dem (CORS).
 * Alt annet her gir 404.
 */
const cors = { 'access-control-allow-origin': '*' }

async function handle(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname.replace(/\/+$/, '')
  if (
    path === '/.well-known/oauth-protected-resource' ||
    path === '/.well-known/oauth-protected-resource/api/mcp'
  ) {
    return Response.json(await protectedResourceMetadata(), {
      headers: { ...cors, 'cache-control': 'public, max-age=300' },
    })
  }
  if (path.startsWith('/.well-known/oauth-authorization-server')) {
    const response = await auth.handler(request)
    if (response.ok) {
      const headers = new Headers(response.headers)
      headers.set('access-control-allow-origin', '*')
      return new Response(response.body, { status: response.status, headers })
    }
    return response
  }
  return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } })
}

export const Route = createFileRoute('/.well-known/$')({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
    },
  },
})
