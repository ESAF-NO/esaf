import { createApiToken, listApiTokens, revokeApiToken } from '@esaf/core'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withViewer as run } from '#/server/access.server.ts'
import { db } from '#/server/db.server.ts'
import { env } from '#/server/env.server.ts'

// MCP-nøkler for admins, under «Konto og sikkerhet». Reglene står i
// `api-tokens.ts` i @esaf/core; her sjekkes bare formen.

/** Adressen MCP-klienter kobler til. */
const endpoint = () => new URL('/api/mcp', env.BETTER_AUTH_URL).href

export const fetchApiTokens = createServerFn({ method: 'GET' }).handler(() =>
  run(async (viewer) => ({ endpoint: endpoint(), tokens: await listApiTokens(db, viewer) })),
)

/** Nøkkelen sendes tilbake én gang, i svaret på POST, og lagres bare som hash. */
export const newApiToken = createServerFn({ method: 'POST' })
  .validator(z.object({ name: z.string().max(80), days: z.number().int(), readOnly: z.boolean() }))
  .handler(({ data }) =>
    run(async (viewer) => {
      const { token, view } = await createApiToken(db, viewer, data)
      return { token, view, endpoint: endpoint() }
    }),
  )

export const removeApiToken = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.uuid() }))
  .handler(({ data }) => run((viewer) => revokeApiToken(db, viewer, data.id)))
