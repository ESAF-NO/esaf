import { assertCanChangeBadgeImage, removeBadgeImage, setBadgeImage } from '@esaf/core'
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
  Response.json({ error: 'Fant ikke merket.' }, { status: 404, headers: noStore })

/**
 * Last opp eller bytt (PUT, med bildet som body) og fjern (DELETE) bildet på et
 * merke. Som logoene: egen rute, så tilgang og størrelse sjekkes før fila leses
 * inn. Reglene ligger i @esaf/core (badge-images.ts).
 */
export const Route = createFileRoute('/api/merker/$badgeId/bilde')({
  server: {
    handlers: {
      PUT: async ({ request, params }) => {
        if (!z.uuid().safeParse(params.badgeId).success) return notFound()
        try {
          assertSameOrigin(request)
          const viewer = await getRequestViewer()
          // Før fila leses, så ingen sender 10 MB for å få nei.
          await assertCanChangeBadgeImage(db, viewer, params.badgeId)
          const file = await readUpload(request)
          const image = await setBadgeImage(db, storage, viewer, params.badgeId, file)
          return Response.json({ image }, { headers: noStore })
        } catch (error) {
          return photoErrorResponse(error)
        }
      },
      DELETE: async ({ request, params }) => {
        if (!z.uuid().safeParse(params.badgeId).success) return notFound()
        try {
          assertSameOrigin(request)
          await removeBadgeImage(db, storage, await getRequestViewer(), params.badgeId)
          return new Response(null, { status: 204, headers: noStore })
        } catch (error) {
          return photoErrorResponse(error)
        }
      },
    },
  },
})
