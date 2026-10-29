import {
  addSelfToCompany,
  companyEventTypes,
  companyLinkRoles,
  companyStatuses,
  decideCompanyLink,
  decideSuggestion,
  listMyLinkRequests,
  removeSelfFromCompany,
  requestCompanyLink,
  searchPeople,
  suggestCompanyArticle,
  suggestCompanyEvent,
  suggestCompanyInfo,
  withdrawCompanyLink,
  withdrawSuggestion,
} from '@esaf/core'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withViewer as run } from '#/server/access.server.ts'
import { db } from '#/server/db.server.ts'

// Bidrag fra medlemmer: seg selv i et selskap, forslag og andre personer. Tilgang,
// grenser og full validering skjer i @esaf/core (contributions.ts). Her sjekkes formen.

const link = z.object({
  role: z.enum(companyLinkRoles),
  title: z.string().max(500),
  startYear: z.number().int().nullable(),
  endYear: z.number().int().nullable(),
})

export type CompanyLinkFormValues = z.infer<typeof link>

export const joinCompany = createServerFn({ method: 'POST' })
  .validator(link.extend({ companyId: z.uuid() }))
  .handler(({ data: { companyId, ...values } }) =>
    run((viewer) => addSelfToCompany(db, viewer, companyId, values)),
  )

export const leaveCompany = createServerFn({ method: 'POST' })
  .validator(z.object({ companyId: z.uuid() }))
  .handler(({ data }) => run((viewer) => removeSelfFromCompany(db, viewer, data.companyId)))

const note = z.string().max(2000).optional()

export const proposeCompanyInfo = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      companyId: z.uuid(),
      note,
      values: z.object({
        name: z.string(),
        tagline: z.string(),
        description: z.string(),
        website: z.string(),
        foundedYear: z.number().int().nullable(),
        location: z.string(),
        industries: z.array(z.string()).max(50),
        status: z.enum(companyStatuses),
      }),
    }),
  )
  .handler(({ data }) =>
    run((viewer) => suggestCompanyInfo(db, viewer, data.companyId, data.values, data.note)),
  )

export const proposeCompanyEvent = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      companyId: z.uuid(),
      note,
      values: z.object({
        year: z.number().int(),
        month: z.number().int().nullable(),
        day: z.number().int().nullable(),
        type: z.enum(companyEventTypes),
        text: z.string().max(2000),
        sourceUrl: z.string().max(1000),
        sourceLabel: z.string().max(200),
      }),
    }),
  )
  .handler(({ data }) =>
    run((viewer) => suggestCompanyEvent(db, viewer, data.companyId, data.values, data.note)),
  )

export const proposeCompanyArticle = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      companyId: z.uuid(),
      note,
      values: z.object({
        url: z.string().max(2000),
        title: z.string().max(1000),
        publisher: z.string().max(500),
        year: z.number().int().nullable(),
        month: z.number().int().nullable(),
        day: z.number().int().nullable(),
        paywall: z.boolean(),
        mentionsEs: z.boolean(),
      }),
    }),
  )
  .handler(({ data }) =>
    run((viewer) => suggestCompanyArticle(db, viewer, data.companyId, data.values, data.note)),
  )

export const retractSuggestion = createServerFn({ method: 'POST' })
  .validator(z.object({ suggestionId: z.uuid() }))
  .handler(({ data }) => run((viewer) => withdrawSuggestion(db, viewer, data.suggestionId)))

export const answerSuggestion = createServerFn({ method: 'POST' })
  .validator(z.object({ suggestionId: z.uuid(), decision: z.enum(['accept', 'reject']) }))
  .handler(({ data }) =>
    run((viewer) => decideSuggestion(db, viewer, data.suggestionId, data.decision)),
  )

export const addPersonToCompany = createServerFn({ method: 'POST' })
  .validator(link.extend({ companyId: z.uuid(), personId: z.uuid() }))
  .handler(({ data: { companyId, ...values } }) =>
    run((viewer) => requestCompanyLink(db, viewer, companyId, values)),
  )

export const answerCompanyLink = createServerFn({ method: 'POST' })
  .validator(z.object({ requestId: z.uuid(), decision: z.enum(['accept', 'reject']) }))
  .handler(({ data }) =>
    run((viewer) => decideCompanyLink(db, viewer, data.requestId, data.decision)),
  )

export const retractCompanyLink = createServerFn({ method: 'POST' })
  .validator(z.object({ requestId: z.uuid() }))
  .handler(({ data }) => run((viewer) => withdrawCompanyLink(db, viewer, data.requestId)))

/** Forespørsler om at den innloggede var med i et selskap, som venter på svar. */
export const fetchMyLinkRequests = createServerFn({ method: 'GET' }).handler(() =>
  run((viewer) => listMyLinkRequests(db, viewer)),
)

/** Aktive medlemmer, til å velge hvem som var med i et selskap. */
export const findMembers = createServerFn({ method: 'GET' })
  .validator(z.object({ q: z.string().max(100) }))
  .handler(({ data }) => run((viewer) => searchPeople(db, viewer, data.q, 8)))
