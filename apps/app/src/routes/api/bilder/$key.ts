import { PHOTO_CONTENT_TYPE, readProfilePhoto } from '@esaf/core'
import { createFileRoute } from '@tanstack/react-router'
import { db } from '#/server/db.server.ts'
import { photoErrorResponse, storage } from '#/server/photos.server.ts'
import { getRequestViewer } from '#/server/viewer.server.ts'

/**
 * Profilbilder, bare for aktive medlemmer (adressene kommer fra `photoUrls` i
 * @esaf/core). Hvert bilde har sin egen adresse og endres aldri, så nettleseren
 * kan beholde det lenge. `private` hindrer at delte mellomlagre (CDN, proxy)
 * tar vare på det.
 */
export const Route = createFileRoute('/api/bilder/$key')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        try {
          const body = await readProfilePhoto(db, storage, await getRequestViewer(), params.key)
          return new Response(body as Uint8Array<ArrayBuffer>, {
            headers: {
              'content-type': PHOTO_CONTENT_TYPE,
              'content-length': String(body.byteLength),
              'cache-control': 'private, max-age=31536000, immutable',
              'x-content-type-options': 'nosniff',
              // Kan ikke bygges inn på andre nettsteder, selv med innloggingscookien.
              'cross-origin-resource-policy': 'same-origin',
            },
          })
        } catch (error) {
          return photoErrorResponse(error)
        }
      },
    },
  },
})
