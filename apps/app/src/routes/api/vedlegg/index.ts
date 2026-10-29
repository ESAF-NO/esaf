import {
  ASSET_MAX_BYTES,
  assertCanUpload,
  assertUploadQuota,
  uploadAsset,
  type AssetTarget,
} from '@esaf/core'
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { db } from '#/server/db.server.ts'
import {
  assertSameOrigin,
  photoErrorResponse,
  readBody,
  storage,
  UploadError,
} from '#/server/photos.server.ts'
import { getRequestViewer } from '#/server/viewer.server.ts'

const noStore = { 'cache-control': 'no-store' }

/** Hvor fila skal: `?til=innlegg`, `?til=album&id=<arrangement>` osv. */
const query = z.discriminatedUnion('til', [
  z.object({ til: z.enum(['innlegg', 'kommentar']), navn: z.string().max(1000) }),
  z.object({
    til: z.enum(['album', 'arrangement']),
    id: z.uuid(),
    navn: z.string().max(1000),
  }),
  z.object({ til: z.literal('selskap'), id: z.uuid(), navn: z.string().max(1000) }),
])

function targetOf(q: z.infer<typeof query>): AssetTarget {
  switch (q.til) {
    case 'innlegg':
      return { purpose: 'post' }
    case 'kommentar':
      return { purpose: 'comment' }
    case 'album':
      return { purpose: 'event_photo', eventId: q.id }
    case 'arrangement':
      return { purpose: 'event_document', eventId: q.id }
    case 'selskap':
      return { purpose: 'company_document', companyId: q.id }
  }
}

/**
 * Høyst så mange opplastinger leses inn samtidig i prosessen. Hver kan holde 25 MB
 * i minnet; bildebehandlingen går uansett én om gangen (se `oneImageAtATime`).
 */
const MAX_CONCURRENT = 4
let active = 0

/**
 * Last opp et vedlegg (POST, med fila som body og `application/octet-stream`).
 * Tilgang og grensen per døgn sjekkes før fila leses inn, og størrelsen mens den
 * leses. Hva fila er, avgjør @esaf/core ut fra innholdet (assets.ts). Sletting
 * går gjennom en serverfunksjon (assets.functions.ts).
 */
export const Route = createFileRoute('/api/vedlegg/')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url)
        const parsed = query.safeParse(Object.fromEntries(url.searchParams))
        if (!parsed.success) {
          return Response.json({ error: 'Ugyldig forespørsel.' }, { status: 400, headers: noStore })
        }
        if (active >= MAX_CONCURRENT) {
          return Response.json(
            { error: 'Mange laster opp akkurat nå. Prøv igjen om et øyeblikk.' },
            { status: 503, headers: { ...noStore, 'retry-after': '5' } },
          )
        }
        active++
        try {
          assertSameOrigin(request)
          // En type som krever CORS-klarering, så andre nettsteder ikke kan sende filer hit.
          const type = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
          if (type !== 'application/octet-stream') {
            throw new UploadError(415, 'Send fila som application/octet-stream.')
          }
          const viewer = await getRequestViewer()
          const target = targetOf(parsed.data)
          // Før fila leses, så ingen sender 25 MB for å få nei.
          await assertCanUpload(db, viewer, target)
          await assertUploadQuota(db, viewer, Number(request.headers.get('content-length')) || 0)
          const file = await readBody(
            request,
            ASSET_MAX_BYTES,
            `Fila er for stor. Maks ${ASSET_MAX_BYTES / 1024 / 1024} MB.`,
          )
          const asset = await uploadAsset(db, storage, viewer, target, file, parsed.data.navn)
          return Response.json({ asset }, { status: 201, headers: noStore })
        } catch (error) {
          return photoErrorResponse(error)
        } finally {
          active--
        }
      },
    },
  },
})
