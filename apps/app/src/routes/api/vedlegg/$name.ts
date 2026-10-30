import { assetHeaders, readAsset } from '@esaf/core'
import { createFileRoute } from '@tanstack/react-router'
import { db } from '#/server/db.server.ts'
import { photoErrorResponse, storage } from '#/server/photos.server.ts'
import { getRequestViewer } from '#/server/viewer.server.ts'

/**
 * Vedlegg, bare for aktive medlemmer (adressene kommer fra `AssetView` i
 * @esaf/core). Bilder (`<nøkkel>-400.webp`, `<nøkkel>-1600.webp`) vises i siden og
 * kan mellomlagres lenge. Dokumenter (`<nøkkel>`) lastes alltid ned, med
 * `nosniff` og en CSP med `sandbox`, så brukerinnhold aldri vises som en side i
 * appen. Se `assetHeaders`.
 */
export const Route = createFileRoute('/api/vedlegg/$name')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        try {
          const { body, ...file } = await readAsset(
            db,
            storage,
            await getRequestViewer(),
            params.name,
          )
          return new Response(body as Uint8Array<ArrayBuffer>, {
            headers: assetHeaders(file, body.byteLength),
          })
        } catch (error) {
          return photoErrorResponse(error)
        }
      },
    },
  },
})
