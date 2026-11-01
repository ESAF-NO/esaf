import {
  addEventCohort,
  addEventParticipants,
  createEvent,
  createEventHistory,
  createEventType,
  deleteEvent,
  deleteEventType,
  findEventType,
  getEvent,
  getEventTypeOverview,
  listEventTypeOptions,
  listEventTypes,
  matchEventParticipants,
  previewEventHistory,
  removeEventParticipant,
  refreshOwnBadges,
  setOwnParticipation,
  updateEvent,
  updateEventParticipant,
  updateEventType,
} from '@esaf/core'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withViewer as run } from '#/server/access.server.ts'
import { db } from '#/server/db.server.ts'
import { storage } from '#/server/photos.server.ts'

// Arrangementer. Medlemmer leser og melder seg selv på; resten krever
// profiles.edit. Rettigheter og full validering i @esaf/core.

const eventFields = z.object({
  typeId: z.string().max(100),
  name: z.string().max(500),
  startDate: z.string().max(20),
  endDate: z.string().max(20).nullable(),
  datePrecision: z.enum(['day', 'semester', 'year']),
  location: z.string().max(500),
  description: z.string().max(5000),
})

export type EventFormValues = z.infer<typeof eventFields>

const typeFields = z.object({
  name: z.string().max(500),
  plural: z.string().max(500),
  description: z.string().max(5000),
  sortOrder: z.number().int(),
})

export type EventTypeFormValues = z.infer<typeof typeFields>

const role = z.enum(['attended', 'organizer', 'speaker', 'volunteer']).nullable()
const ev = { eventId: z.uuid() }

export const fetchEventTypes = createServerFn({ method: 'GET' }).handler(() =>
  run((viewer) => listEventTypes(db, viewer)),
)

export const fetchEventTypeOverview = createServerFn({ method: 'GET' })
  .validator(z.object({ slug: z.string().max(100) }))
  .handler(({ data }) => run((viewer) => getEventTypeOverview(db, viewer, data.slug)))

export const fetchEvent = createServerFn({ method: 'GET' })
  .validator(z.object(ev))
  .handler(({ data }) => run((viewer) => getEvent(db, viewer, data.eventId)))

/** Typen et arrangement hører til, for gamle lenker (/esaf-helgen/:id). */
export const fetchEventTypeOf = createServerFn({ method: 'GET' })
  .validator(z.object({ eventId: z.string().max(100) }))
  .handler(({ data }) =>
    run(async (viewer) =>
      z.uuid().safeParse(data.eventId).success ? findEventType(db, viewer, data.eventId) : null,
    ),
  )

/** «Jeg var der», eller fjerne seg selv. */
export const setParticipated = createServerFn({ method: 'POST' })
  .validator(z.object({ ...ev, participated: z.boolean() }))
  .handler(({ data }) =>
    run(async (viewer) => {
      await setOwnParticipation(db, viewer, data.eventId, data.participated)
      // Merkene oppdateres med en gang, så den som var der, ser dem nå.
      return { badges: await refreshOwnBadges(db, viewer) }
    }),
  )

// Typer (admin)

export const fetchEventTypeOptions = createServerFn({ method: 'GET' }).handler(() =>
  run((viewer) => listEventTypeOptions(db, viewer)),
)

export const newEventType = createServerFn({ method: 'POST' })
  .validator(typeFields)
  .handler(({ data }) => run((viewer) => createEventType(db, viewer, data)))

export const saveEventType = createServerFn({ method: 'POST' })
  .validator(z.object({ typeId: z.uuid(), values: typeFields }))
  .handler(({ data }) => run((viewer) => updateEventType(db, viewer, data.typeId, data.values)))

export const removeEventType = createServerFn({ method: 'POST' })
  .validator(z.object({ typeId: z.uuid() }))
  .handler(({ data }) => run((viewer) => deleteEventType(db, viewer, data.typeId)))

// Arrangementer (admin)

export const newEvent = createServerFn({ method: 'POST' })
  .validator(eventFields)
  .handler(({ data }) => run((viewer) => createEvent(db, viewer, data)))

export const saveEvent = createServerFn({ method: 'POST' })
  .validator(z.object({ ...ev, values: eventFields }))
  .handler(({ data }) => run((viewer) => updateEvent(db, viewer, data.eventId, data.values)))

export const removeEvent = createServerFn({ method: 'POST' })
  .validator(z.object(ev))
  .handler(({ data }) => run((viewer) => deleteEvent(db, viewer, data.eventId, storage)))

// Historikk (admin): mange gamle arrangementer på én gang

const historyRange = z.object({
  typeId: z.string().max(100),
  fromYear: z.number().int(),
  toYear: z.number().int(),
  frequency: z.enum(['year', 'autumn', 'spring', 'both']),
})

export type HistoryFormValues = z.infer<typeof historyRange>

/** Forhåndsvisningen: hva som lages, og hva som finnes fra før. Lagrer ingenting. */
export const previewHistory = createServerFn({ method: 'POST' })
  .validator(historyRange)
  .handler(({ data }) => run((viewer) => previewEventHistory(db, viewer, data)))

export const createHistory = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      typeId: z.string().max(100),
      items: z
        .array(z.object({ year: z.number().int(), period: z.enum(['year', 'spring', 'autumn']) }))
        .max(200),
      location: z.string().max(500),
    }),
  )
  .handler(({ data }) => run((viewer) => createEventHistory(db, viewer, data)))

// Deltakere (admin)

export const addParticipants = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      ...ev,
      personIds: z.array(z.uuid()).max(1000),
      source: z.enum(['admin', 'import']),
      role: role.optional(),
    }),
  )
  .handler(({ data: { eventId, ...input } }) =>
    run((viewer) => addEventParticipants(db, viewer, eventId, input)),
  )

export const addCohortParticipants = createServerFn({ method: 'POST' })
  .validator(z.object({ ...ev, graduationYear: z.number().int() }))
  .handler(({ data }) =>
    run((viewer) => addEventCohort(db, viewer, data.eventId, data.graduationYear)),
  )

export const saveParticipant = createServerFn({ method: 'POST' })
  .validator(z.object({ ...ev, personId: z.uuid(), role, note: z.string().max(1000).nullable() }))
  .handler(({ data: { eventId, personId, ...values } }) =>
    run((viewer) => updateEventParticipant(db, viewer, eventId, personId, values)),
  )

export const removeParticipant = createServerFn({ method: 'POST' })
  .validator(z.object({ ...ev, personId: z.uuid() }))
  .handler(({ data }) =>
    run((viewer) => removeEventParticipant(db, viewer, data.eventId, data.personId)),
  )

/** Forhåndsvisning av en innlimt liste. Lagrer ingenting. */
export const matchParticipants = createServerFn({ method: 'POST' })
  .validator(z.object({ ...ev, text: z.string().max(100_000) }))
  .handler(({ data }) =>
    run((viewer) => matchEventParticipants(db, viewer, data.eventId, data.text)),
  )
