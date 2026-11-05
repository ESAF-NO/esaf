import { findGifs, importGif, type GifPage } from '@esaf/core'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withViewer as run } from '#/server/access.server.ts'
import { db } from '#/server/db.server.ts'
import { requireGifs } from '#/server/gifs.server.ts'
import { storage } from '#/server/photos.server.ts'

export const searchGifs = createServerFn({ method: 'GET' })
  .validator(z.object({ q: z.string().max(100), offset: z.number().int().min(0).max(1000) }))
  .handler(({ data }): Promise<GifPage> =>
    run((viewer) => findGifs(db, viewer, requireGifs(), data.q, data.offset)),
  )

/** Lagrer GIF-en som et vedlegg og gir det slik `/api/vedlegg` gjør. */
export const importGifAttachment = createServerFn({ method: 'POST' })
  .validator(z.object({ gifId: z.string().max(80), til: z.enum(['innlegg', 'kommentar']) }))
  .handler(({ data }) =>
    run((viewer) => {
      const purpose = data.til === 'innlegg' ? 'post' : 'comment'
      return importGif(db, storage, viewer, requireGifs(), data.gifId, purpose)
    }),
  )
