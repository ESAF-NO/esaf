import {
  acceptAllReview,
  bulkReviewKinds,
  clearImportedField,
  confirmCompanyEvent,
  confirmQuote,
  dismissDuplicate,
  listReview,
  markSourcesReviewed,
  removeFieldSource,
  reviewCounts,
  reviewKinds,
} from '@esaf/core'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withViewer as run } from '#/server/access.server.ts'
import { db } from '#/server/db.server.ts'

// Gjennomgang (Admin). Rettighetene sjekkes i @esaf/core for hvert kall.

export const fetchReviewCounts = createServerFn({ method: 'GET' }).handler(() =>
  run((viewer) => reviewCounts(db, viewer)),
)

export const fetchReview = createServerFn({ method: 'GET' })
  .validator(z.object({ kind: z.enum(reviewKinds), page: z.number().int().min(1).max(10_000) }))
  .handler(({ data }) => run((viewer) => listReview(db, viewer, data.kind, data.page)))

export const approveEvent = createServerFn({ method: 'POST' })
  .validator(z.object({ eventId: z.uuid() }))
  .handler(({ data }) => run((viewer) => confirmCompanyEvent(db, viewer, data.eventId)))

export const approveQuote = createServerFn({ method: 'POST' })
  .validator(z.object({ quoteId: z.uuid() }))
  .handler(({ data }) => run((viewer) => confirmQuote(db, viewer, data.quoteId)))

const entity = { entityType: z.enum(['person', 'company']), entityId: z.uuid() }

export const approveSources = createServerFn({ method: 'POST' })
  .validator(z.object({ ...entity, fields: z.array(z.string().max(40)).max(20).optional() }))
  .handler(({ data }) => run((viewer) => markSourcesReviewed(db, viewer, data)))

export const clearField = createServerFn({ method: 'POST' })
  .validator(z.object({ ...entity, field: z.string().max(40) }))
  .handler(({ data }) => run((viewer) => clearImportedField(db, viewer, data)))

export const removeSource = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      ...entity,
      field: z.string().max(40),
      label: z.string().max(200),
      url: z.string().max(2000).nullable(),
    }),
  )
  .handler(({ data }) => run((viewer) => removeFieldSource(db, viewer, data)))

export const dismissPair = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      kind: z.enum(['company_duplicate', 'person_duplicate']),
      firstId: z.uuid(),
      secondId: z.uuid(),
    }),
  )
  .handler(({ data }) => run((viewer) => dismissDuplicate(db, viewer, data)))

/** «Godta alle» for importerte felt. */
export const acceptAll = createServerFn({ method: 'POST' })
  .validator(z.object({ kind: z.enum(bulkReviewKinds) }))
  .handler(({ data }) => run((viewer) => acceptAllReview(db, viewer, data.kind)))
