import { getCohortPage } from '@esaf/core'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withViewer as run } from '#/server/access.server.ts'
import { db } from '#/server/db.server.ts'

/** Ett kull, med folk, selskaper og innlegg. Ukjente årstall gir 404. */
export const fetchCohort = createServerFn({ method: 'GET' })
  .validator(z.object({ year: z.number().int() }))
  .handler(({ data }) => run((viewer) => getCohortPage(db, viewer, data.year)))
