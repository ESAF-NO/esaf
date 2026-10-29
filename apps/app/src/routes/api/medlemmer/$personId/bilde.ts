import { assertCanChangePhoto, removeProfilePhoto, setProfilePhoto } from '@esaf/core'
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { db } from '#/server/db.server.ts'
import {
  assertSameOrigin,
  photoErrorResponse,
  readUpload,
  storage,
} from '#/server/photos.server.ts'
import { getRequestViewer } from '#/server/viewer.server.ts'

const noStore = { 'cache-control': 'no-store' }
const notFound = () =>
  Response.json({ error: 'Fant ikke profilen.' }, { status: 404, headers: noStore })

/**
 * Last opp eller bytt (PUT, med bildet som body) og fjern (DELETE) profilbildet.
 * Egen rute og ikke en serverfunksjon, så størrelsen kan sjekkes før fila leses
 * inn, og nettleseren kan vise fremdrift. Reglene ligger i @esaf/core.
 */
export const Route = createFileRoute('/api/medlemmer/$personId/bilde')({
  server: {
    handlers: {
      PUT: async ({ request, params }) => {
        if (!z.uuid().safeParse(params.personId).success) return notFound()
        try {
          assertSameOrigin(request)
          const viewer = await getRequestViewer()
          // Før fila leses, så ingen sender 10 MB for å få nei.
          assertCanChangePhoto(viewer, params.personId)
          const file = await readUpload(request)
          const photo = await setProfilePhoto(db, storage, viewer, params.personId, file)
          return Response.json({ photo }, { headers: noStore })
        } catch (error) {
          return photoErrorResponse(error)
        }
      },
      DELETE: async ({ request, params }) => {
        if (!z.uuid().safeParse(params.personId).success) return notFound()
        try {
          assertSameOrigin(request)
          await removeProfilePhoto(db, storage, await getRequestViewer(), params.personId)
          return new Response(null, { status: 204, headers: noStore })
        } catch (error) {
          return photoErrorResponse(error)
        }
      },
    },
  },
})
