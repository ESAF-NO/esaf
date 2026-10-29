import {
  addCompanyEvent,
  companyEventTypes,
  companyStatuses,
  deleteCompanyEvent,
  getCompany,
  getEditableCompany,
  listCompanies,
  mergeCompanies,
  searchCompanies,
  updateCompany,
  updateCompanyEvent,
} from '@esaf/core'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withViewer as run } from '#/server/access.server.ts'
import { db } from '#/server/db.server.ts'
import { storage } from '#/server/photos.server.ts'

// Tilgang og full validering skjer i @esaf/core (companyInput). Her sjekkes bare formen.
const companyFields = z.object({
  name: z.string(),
  tagline: z.string(),
  description: z.string(),
  website: z.string(),
  foundedYear: z.number().int().nullable(),
  location: z.string(),
  industries: z.array(z.string()).max(50),
  status: z.enum(companyStatuses),
})

export type CompanyFormValues = z.infer<typeof companyFields>

const slug = z.string().min(1).max(200)

export const fetchCompanies = createServerFn({ method: 'GET' }).handler(() =>
  run((viewer) => listCompanies(db, viewer)),
)

export const fetchCompany = createServerFn({ method: 'GET' })
  .validator(z.object({ slug }))
  .handler(({ data }) => run((viewer) => getCompany(db, viewer, data.slug)))

export const fetchEditableCompany = createServerFn({ method: 'GET' })
  .validator(z.object({ slug }))
  .handler(({ data }) => run((viewer) => getEditableCompany(db, viewer, data.slug)))

export const saveCompany = createServerFn({ method: 'POST' })
  .validator(z.object({ companyId: z.uuid(), values: companyFields }))
  .handler(({ data }) => run((viewer) => updateCompany(db, viewer, data.companyId, data.values)))

/** Forslag mens man skriver inn et selskap. */
export const findCompanies = createServerFn({ method: 'GET' })
  .validator(z.object({ q: z.string().max(120) }))
  .handler(({ data }) => run((viewer) => searchCompanies(db, viewer, data.q, 6)))

export const mergeCompany = createServerFn({ method: 'POST' })
  .validator(z.object({ sourceId: z.uuid(), targetId: z.uuid() }))
  .handler(({ data }) => run((viewer) => mergeCompanies(db, storage, viewer, data)))

// Full validering av hendelsen skjer i @esaf/core (companyEventInput). Her sjekkes bare formen.
const eventFields = z.object({
  year: z.number().int(),
  month: z.number().int().nullable(),
  day: z.number().int().nullable(),
  type: z.enum(companyEventTypes),
  text: z.string().max(2000),
  sourceUrl: z.string().max(1000),
  sourceLabel: z.string().max(200),
})

export type CompanyEventFormValues = z.infer<typeof eventFields>

/** Ny hendelse med `companyId`, eller rett en med `eventId`. */
export const saveCompanyEvent = createServerFn({ method: 'POST' })
  .validator(
    z.union([
      z.object({ companyId: z.uuid(), values: eventFields }),
      z.object({ eventId: z.uuid(), values: eventFields }),
    ]),
  )
  .handler(({ data }) =>
    run(async (viewer) => {
      if ('eventId' in data) await updateCompanyEvent(db, viewer, data.eventId, data.values)
      else await addCompanyEvent(db, viewer, data.companyId, data.values)
    }),
  )

export const removeCompanyEvent = createServerFn({ method: 'POST' })
  .validator(z.object({ eventId: z.uuid() }))
  .handler(({ data }) => run((viewer) => deleteCompanyEvent(db, viewer, data.eventId)))
