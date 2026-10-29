import { createFileRoute } from '@tanstack/react-router'
import { handleMcpRequest } from '#/server/mcp.server.ts'

/**
 * MCP-serveren for adminverktøyene (Streamable HTTP). Nøkkel, tilgang og grenser
 * sjekkes i `handleMcpRequest`; GET og DELETE (økter i eldre versjoner av
 * protokollen) får 405, siden serveren er uten økter.
 */
export const Route = createFileRoute('/api/mcp')({
  server: {
    handlers: {
      POST: ({ request }) => handleMcpRequest(request),
      GET: ({ request }) => handleMcpRequest(request),
      DELETE: ({ request }) => handleMcpRequest(request),
    },
  },
})
