import {
  addSelfToCompany,
  companiesToFill,
  companyLinkRoles,
  companyStatuses,
  decideCompanyLink,
  decideSuggestion,
  listMyLinkRequests,
  removeSelfFromCompany,
  requestCompanyLink,
  searchPeople,
  startCompany,
  suggestCompanyInfo,
  withdrawCompanyLink,
  withdrawSuggestion,
} from '@esaf/core'
import { createServerFn } from '@tanstack/react-start'
import { getCookie, setCookie } from '@tanstack/react-start/server'
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

/** «Nytt selskap»: lager selskapet og knytter den innloggede til det. */
export const createOwnCompany = createServerFn({ method: 'POST' })
  .validator(z.object({ name: z.string().max(500), link }))
  .handler(({ data }) => run((viewer) => startCompany(db, viewer, data)))

/**
 * «Ikke nå» på påminnelsen om å fylle ut et selskap: skjules i 30 dager i denne
 * nettleseren. En informasjonskapsel, så Hjem ikke blinker når siden lastes.
 */
const SNOOZE_COOKIE = 'esaf_fyll_ut_senere'
const SNOOZE_DAYS = 30

const snoozed = () =>
  new Set(
    (getCookie(SNOOZE_COOKIE) ?? '').split('.').filter((id) => z.uuid().safeParse(id).success),
  )

/** Selskapene den innloggede har grunnlagt eller hadde på ES, og som mangler info. */
export const fetchCompaniesToFill = createServerFn({ method: 'GET' }).handler(() =>
  run(async (viewer) => {
    const hidden = snoozed()
    return (await companiesToFill(db, viewer)).filter((c) => !hidden.has(c.id))
  }),
)

export const snoozeCompanyToFill = createServerFn({ method: 'POST' })
  .validator(z.object({ companyId: z.uuid() }))
  .handler(({ data }) =>
    run(async () => {
      // Høyst 20, så kapselen holder seg liten.
      const ids = [...snoozed(), data.companyId].slice(-20)
      setCookie(SNOOZE_COOKIE, [...new Set(ids)].join('.'), {
        path: '/',
        maxAge: SNOOZE_DAYS * 24 * 60 * 60,
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
      })
    }),
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
