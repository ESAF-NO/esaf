import {
  addCohortRepresentative,
  endCohortRepresentative,
  listRepresentativeCandidates,
  listRepresentativeOverview,
  removeCohortRepresentative,
  updateCohortRepresentative,
} from '@esaf/core'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withViewer as run } from '#/server/access.server.ts'
import { db } from '#/server/db.server.ts'

// Kullrepresentanter (Admin, krever members.manage). Rettigheter og full validering i @esaf/core.

const year = z.number().int().nullable()

export const fetchRepresentativeOverview = createServerFn({ method: 'GET' }).handler(() =>
  run((viewer) => listRepresentativeOverview(db, viewer)),
)

export const fetchRepresentativeCandidates = createServerFn({ method: 'GET' })
  .validator(z.object({ graduationYear: z.number().int(), query: z.string().max(100).optional() }))
  .handler(({ data }) => run((viewer) => listRepresentativeCandidates(db, viewer, data)))

export const addRepresentative = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      graduationYear: z.number().int(),
      personId: z.uuid(),
      startYear: year,
      note: z.string().max(1000),
      otherCohort: z.boolean(),
    }),
  )
  .handler(({ data }) => run((viewer) => addCohortRepresentative(db, viewer, data)))

export const editRepresentative = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.uuid(), startYear: year, endYear: year, note: z.string().max(1000) }))
  .handler(({ data: { id, ...values } }) =>
    run((viewer) => updateCohortRepresentative(db, viewer, id, values)),
  )

export const endRepresentative = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.uuid(), endYear: z.number().int() }))
  .handler(({ data }) =>
    run((viewer) => endCohortRepresentative(db, viewer, data.id, { endYear: data.endYear })),
  )

export const removeRepresentative = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.uuid() }))
  .handler(({ data }) => run((viewer) => removeCohortRepresentative(db, viewer, data.id)))
