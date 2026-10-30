import { removeAsset } from '@esaf/core'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withViewer as run } from '#/server/access.server.ts'
import { db } from '#/server/db.server.ts'
import { storage } from '#/server/photos.server.ts'

/**
 * Sletter et vedlegg: den som lastet det opp, eller en som kan fjerne det
 * (moderatorer, admins, arrangører for dokumentene på et arrangement, de som
 * kan redigere et selskap). Reglene og loggingen ligger i @esaf/core (assets.ts).
 */
export const deleteAsset = createServerFn({ method: 'POST' })
  .validator(z.object({ assetId: z.uuid() }))
  .handler(({ data }) => run((viewer) => removeAsset(db, storage, viewer, data.assetId)))
