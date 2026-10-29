import { assertCanChangeLogo, removeCompanyLogo, setCompanyLogo } from '@esaf/core'
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
  Response.json({ error: 'Fant ikke selskapet.' }, { status: 404, headers: noStore })

/**
 * Last opp eller bytt (PUT, med bildet som body) og fjern (DELETE) logoen til
 * et selskap. Som profilbildene: egen rute, så tilgang og størrelse sjekkes før
 * fila leses inn. Reglene ligger i @esaf/core (logos.ts).
 */
export const Route = createFileRoute('/api/selskaper/$companyId/logo')({
  server: {
    handlers: {
      PUT: async ({ request, params }) => {
        if (!z.uuid().safeParse(params.companyId).success) return notFound()
        try {
          assertSameOrigin(request)
          const viewer = await getRequestViewer()
          // Før fila leses, så ingen sender 10 MB for å få nei.
          await assertCanChangeLogo(db, viewer, params.companyId)
          const file = await readUpload(request)
          const logo = await setCompanyLogo(db, storage, viewer, params.companyId, file)
          return Response.json({ logo }, { headers: noStore })
        } catch (error) {
          return photoErrorResponse(error)
        }
      },
      DELETE: async ({ request, params }) => {
        if (!z.uuid().safeParse(params.companyId).success) return notFound()
        try {
          assertSameOrigin(request)
          await removeCompanyLogo(db, storage, await getRequestViewer(), params.companyId)
          return new Response(null, { status: 204, headers: noStore })
        } catch (error) {
          return photoErrorResponse(error)
        }
      },
    },
  },
})
