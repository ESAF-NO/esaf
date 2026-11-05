import { BADGE_IMAGE_CONTENT_TYPE, readBadgeImage } from '@esaf/core'
import { createFileRoute } from '@tanstack/react-router'
import { db } from '#/server/db.server.ts'
import { imageHeaders, photoErrorResponse, storage } from '#/server/photos.server.ts'
import { getRequestViewer } from '#/server/viewer.server.ts'

/**
 * Bilder på merker, bare for aktive medlemmer (adressene kommer fra
 * `badgeImageUrls` i @esaf/core). Samme regler for mellomlagring som
 * profilbildene: hvert bilde har sin egen adresse og endres aldri.
 */
export const Route = createFileRoute('/api/merkebilder/$key')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        try {
          const body = await readBadgeImage(db, storage, await getRequestViewer(), params.key)
          return new Response(body as Uint8Array<ArrayBuffer>, {
            headers: imageHeaders(BADGE_IMAGE_CONTENT_TYPE, body),
          })
        } catch (error) {
          return photoErrorResponse(error)
        }
      },
    },
  },
})
