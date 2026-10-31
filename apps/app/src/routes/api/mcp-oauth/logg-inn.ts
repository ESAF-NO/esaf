import { createFileRoute } from '@tanstack/react-router'
import { auth } from '#/server/auth.server.ts'
import { encodeOAuthQuery, oauthQueryValid, resumeAuthorizationUrl } from '#/server/oauth-query.ts'

/**
 * Innloggingssiden for OAuth (`loginPage`): hit sender OAuth-serveren en
 * MCP-klient som ikke har en innlogget økt. Uten økt går personen til vanlig
 * innlogging og kommer tilbake hit etterpå (`til`); med økt startes
 * forespørselen fra klienten på nytt, og serveren går videre til godkjenningen.
 */
const redirect = (location: string) =>
  new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } })

export const Route = createFileRoute('/api/mcp-oauth/logg-inn')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const query = new URL(request.url).search.slice(1)
        if (!(await oauthQueryValid(query, (await auth.$context).secret))) {
          // Godkjenningssiden forklarer at forespørselen er utløpt.
          return redirect(`/mcp/godkjenn?q=${encodeOAuthQuery(query)}`)
        }
        const session = await auth.api.getSession({ headers: request.headers })
        if (!session) {
          const back = `/api/mcp-oauth/logg-inn?${query}`
          return redirect(`/logg-inn?til=${encodeURIComponent(back)}`)
        }
        return redirect(resumeAuthorizationUrl(query))
      },
    },
  },
})
