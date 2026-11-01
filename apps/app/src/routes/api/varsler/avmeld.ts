import { unsubscribe } from '@esaf/core'
import { createFileRoute } from '@tanstack/react-router'
import { db } from '#/server/db.server.ts'
import { env } from '#/server/env.server.ts'

/**
 * Avmelding med ett klikk fra e-postprogrammet (RFC 8058): `List-Unsubscribe`
 * peker hit, og programmet sender en POST uten innlogging. Lenken i selve
 * e-posten går til siden `/avmeld`, der man trykker på en knapp, så lenkesjekkere
 * som åpner lenker (GET) ikke melder noen av.
 */
export const Route = createFileRoute('/api/varsler/avmeld')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const token = new URL(request.url).searchParams.get('t') ?? ''
        try {
          await unsubscribe(db, env.BETTER_AUTH_SECRET, token)
          return new Response(null, { status: 204 })
        } catch {
          return new Response('Lenken er ikke gyldig.', { status: 400 })
        }
      },
      GET: ({ request }) => {
        const token = new URL(request.url).searchParams.get('t') ?? ''
        return Response.redirect(
          new URL(`/avmeld?t=${encodeURIComponent(token)}`, request.url),
          303,
        )
      },
    },
  },
})
