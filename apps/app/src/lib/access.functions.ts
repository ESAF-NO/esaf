import {
  decideAccessRequest,
  finishOnboarding,
  getAccessState,
  listAccessRequests,
  sendWelcomeEmail,
  submitAccessRequest,
} from '@esaf/core'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withViewer as run } from '#/server/access.server.ts'
import { db } from '#/server/db.server.ts'
import { mailer } from '#/server/email.server.ts'
import { env } from '#/server/env.server.ts'

/** Søkerens egen status og eventuelt profilen som har kontoens e-postadresse. */
export const fetchAccessState = createServerFn({ method: 'GET' }).handler(() =>
  run((viewer) => getAccessState(db, viewer)),
)

// Full validering skjer i @esaf/core (accessRequestInput). Her sjekkes bare formen.
export const sendAccessRequest = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      profilePersonId: z.uuid().nullable(),
      fullName: z.string(),
      graduationYear: z.number().int().nullable(),
      linkedinUrl: z.string(),
      note: z.string(),
    }),
  )
  .handler(({ data }) => run((viewer) => submitAccessRequest(db, viewer, data)))

export const fetchAccessRequests = createServerFn({ method: 'GET' })
  .validator(z.object({ status: z.enum(['open', 'approved', 'rejected']) }))
  .handler(({ data }) => run((viewer) => listAccessRequests(db, viewer, data.status)))

export const decideRequest = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      requestId: z.uuid(),
      decision: z.enum(['approve', 'reject']),
      profilePersonId: z.uuid().nullable().optional(),
    }),
  )
  .handler(({ data }) => run((viewer) => decideAccessRequest(db, viewer, data)))

export const completeOnboarding = createServerFn({ method: 'POST' }).handler(() =>
  run((viewer) => finishOnboarding(db, viewer)),
)

/** Sender velkomsten («Du er med i ESAF») for en godkjent forespørsel nå. */
export const resendWelcome = createServerFn({ method: 'POST' })
  .validator(z.object({ requestId: z.uuid() }))
  .handler(({ data }) =>
    run((viewer) =>
      sendWelcomeEmail(db, viewer, mailer, {
        requestId: data.requestId,
        appUrl: env.BETTER_AUTH_URL,
      }),
    ),
  )
