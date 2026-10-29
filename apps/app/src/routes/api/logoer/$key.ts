import { LOGO_CONTENT_TYPE, readCompanyLogo } from '@esaf/core'
import { createFileRoute } from '@tanstack/react-router'
import { db } from '#/server/db.server.ts'
import { imageHeaders, photoErrorResponse, storage } from '#/server/photos.server.ts'
import { getRequestViewer } from '#/server/viewer.server.ts'

/**
 * Selskapslogoer, bare for aktive medlemmer (adressene kommer fra `logoUrls` i
 * @esaf/core). Samme regler for mellomlagring som profilbildene: hver logo har
 * sin egen adresse og endres aldri.
 */
export const Route = createFileRoute('/api/logoer/$key')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        try {
          const body = await readCompanyLogo(db, storage, await getRequestViewer(), params.key)
          return new Response(body as Uint8Array<ArrayBuffer>, {
            headers: imageHeaders(LOGO_CONTENT_TYPE, body),
          })
        } catch (error) {
          return photoErrorResponse(error)
        }
      },
    },
  },
})
