import {
  addWeekendAttendees,
  addWeekendCohort,
  createWeekend,
  deleteWeekend,
  getWeekend,
  listWeekends,
  matchWeekendAttendees,
  removeWeekendAttendee,
  setOwnAttendance,
  updateWeekend,
} from '@esaf/core'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withViewer as run } from '#/server/access.server.ts'
import { db } from '#/server/db.server.ts'

// ESAF-helgen. Medlemmer leser og melder seg selv på; resten krever profiles.edit.
// Rettigheter og full validering i @esaf/core.

const weekendFields = z.object({
  name: z.string().max(500),
  startDate: z.string().max(20),
  endDate: z.string().max(20).nullable(),
  location: z.string().max(500),
  description: z.string().max(5000),
})

export type WeekendFormValues = z.infer<typeof weekendFields>

const weekend = { weekendId: z.uuid() }

export const fetchWeekends = createServerFn({ method: 'GET' }).handler(() =>
  run((viewer) => listWeekends(db, viewer)),
)

export const fetchWeekend = createServerFn({ method: 'GET' })
  .validator(z.object(weekend))
  .handler(({ data }) => run((viewer) => getWeekend(db, viewer, data.weekendId)))

/** «Jeg var der», eller fjerne seg selv. */
export const setAttended = createServerFn({ method: 'POST' })
  .validator(z.object({ ...weekend, attended: z.boolean() }))
  .handler(({ data }) =>
    run((viewer) => setOwnAttendance(db, viewer, data.weekendId, data.attended)),
  )

export const newWeekend = createServerFn({ method: 'POST' })
  .validator(weekendFields)
  .handler(({ data }) => run((viewer) => createWeekend(db, viewer, data)))

export const saveWeekend = createServerFn({ method: 'POST' })
  .validator(z.object({ ...weekend, values: weekendFields }))
  .handler(({ data }) => run((viewer) => updateWeekend(db, viewer, data.weekendId, data.values)))

export const removeWeekend = createServerFn({ method: 'POST' })
  .validator(z.object(weekend))
  .handler(({ data }) => run((viewer) => deleteWeekend(db, viewer, data.weekendId)))

export const addAttendees = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      ...weekend,
      personIds: z.array(z.uuid()).max(1000),
      source: z.enum(['admin', 'import']),
    }),
  )
  .handler(({ data: { weekendId, ...input } }) =>
    run((viewer) => addWeekendAttendees(db, viewer, weekendId, input)),
  )

export const addCohortAttendees = createServerFn({ method: 'POST' })
  .validator(z.object({ ...weekend, graduationYear: z.number().int() }))
  .handler(({ data }) =>
    run((viewer) => addWeekendCohort(db, viewer, data.weekendId, data.graduationYear)),
  )

export const removeAttendee = createServerFn({ method: 'POST' })
  .validator(z.object({ ...weekend, personId: z.uuid() }))
  .handler(({ data }) =>
    run((viewer) => removeWeekendAttendee(db, viewer, data.weekendId, data.personId)),
  )

/** Forhåndsvisning av en innlimt liste. Lagrer ingenting. */
export const matchAttendees = createServerFn({ method: 'POST' })
  .validator(z.object({ ...weekend, text: z.string().max(100_000) }))
  .handler(({ data }) =>
    run((viewer) => matchWeekendAttendees(db, viewer, data.weekendId, data.text)),
  )
