import {
  describeEmail,
  emailCatalog,
  emailKinds,
  emailOverview,
  emailStatuses,
  listEmailLog,
  sendTestEmail,
} from '@esaf/core'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withViewer as run } from '#/server/access.server.ts'
import { db } from '#/server/db.server.ts'
import { mailer } from '#/server/email.server.ts'
import { emailConfig, env } from '#/server/env.server.ts'

// Admin → E-post. Rettighetene (`audit.read`) sjekkes i @esaf/core for hvert kall.

/** E-postene per side i loggen. Kortere side enn dette betyr at det ikke finnes flere. */
export const emailLogPageSize = 50

const logFilter = z.object({
  kind: z.enum(emailKinds).optional(),
  status: z.enum(emailStatuses).optional(),
  q: z.string().max(200).optional(),
  beforeId: z.uuid().optional(),
})

/** Tallene, malene med eksempler, og hvordan e-post er satt opp (uten hemmeligheter). */
export const fetchEmailAdmin = createServerFn({ method: 'GET' }).handler(() =>
  run(async (viewer) => {
    const overview = await emailOverview(db, viewer)
    return {
      overview,
      templates: emailCatalog(env.BETTER_AUTH_URL),
      sending: mailer !== null,
      setup: describeEmail(emailConfig),
    }
  }),
)

export const fetchEmailLog = createServerFn({ method: 'GET' })
  .validator(logFilter)
  .handler(({ data }) =>
    run((viewer) => listEmailLog(db, viewer, { ...data, limit: emailLogPageSize })),
  )

/** Sender eksempelet til adressen admin logger inn med. */
export const sendEmailTest = createServerFn({ method: 'POST' })
  .validator(z.object({ kind: z.enum(emailKinds) }))
  .handler(({ data }) =>
    run((viewer) =>
      sendTestEmail(db, viewer, mailer, { kind: data.kind, appUrl: env.BETTER_AUTH_URL }),
    ),
  )
