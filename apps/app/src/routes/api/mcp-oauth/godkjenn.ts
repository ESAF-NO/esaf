import { createFileRoute } from '@tanstack/react-router'
import { encodeOAuthQuery } from '#/server/oauth-query.ts'

/**
 * Godkjenningssiden for OAuth (`consentPage`). Sender videre til `/mcp/godkjenn`
 * med den signerte forespørselen som én verdi, så ruteren ikke skriver den om.
 */
export const Route = createFileRoute('/api/mcp-oauth/godkjenn')({
  server: {
    handlers: {
      GET: ({ request }) =>
        new Response(null, {
          status: 302,
          headers: {
            location: `/mcp/godkjenn?q=${encodeOAuthQuery(new URL(request.url).search.slice(1))}`,
            'cache-control': 'no-store',
          },
        }),
    },
  },
})
