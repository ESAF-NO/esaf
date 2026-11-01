import {
  countUnreadNotifications,
  describeUnsubscribe,
  getEmailPreferences,
  setEmailPreference,
  unsubscribe,
  listMentionable,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '@esaf/core'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withViewer as run } from '#/server/access.server.ts'
import { db } from '#/server/db.server.ts'
import { mailer } from '#/server/email.server.ts'
import { env } from '#/server/env.server.ts'

// Tilgang sjekkes i @esaf/core for hvert kall: alle ser og endrer bare sine egne varsler.

export const fetchNotifications = createServerFn({ method: 'GET' })
  .validator(
    z.object({ limit: z.number().int().min(1).max(50).optional(), before: z.uuid().optional() }),
  )
  .handler(({ data }) =>
    run(async (viewer) => {
      const [page, unread] = await Promise.all([
        listNotifications(db, viewer, data),
        countUnreadNotifications(db, viewer),
      ])
      return { ...page, unread }
    }),
  )

/** Til klokka, som spør jevnlig mens fanen er synlig. */
export const fetchUnreadNotifications = createServerFn({ method: 'GET' }).handler(() =>
  run((viewer) => countUnreadNotifications(db, viewer)),
)

/** Merker varselet (og andre varsler om samme innlegg) som lest, og gir nytt antall uleste. */
export const readNotification = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.uuid() }))
  .handler(({ data }) =>
    run(async (viewer) => {
      await markNotificationRead(db, viewer, data.id)
      return countUnreadNotifications(db, viewer)
    }),
  )

export const readAllNotifications = createServerFn({ method: 'POST' }).handler(() =>
  run((viewer) => markAllNotificationsRead(db, viewer)),
)

/** Alle som kan nevnes med @, til forslagene i skrivefeltene. */
export const fetchMentionable = createServerFn({ method: 'GET' }).handler(() =>
  run((viewer) => listMentionable(db, viewer)),
)

// Varsler på e-post. Valgene er den innloggedes egne; avmeldingen virker uten
// innlogging, med den signerte lenken fra e-posten (se `notification-email.ts`).

export const fetchEmailPreferences = createServerFn({ method: 'GET' }).handler(() =>
  run(async (viewer) => ({
    ...(await getEmailPreferences(db, viewer)),
    // Uten e-postleverandør sendes ingenting; siden sier det.
    sending: mailer !== null,
  })),
)

export const saveEmailPreference = createServerFn({ method: 'POST' })
  .validator(z.object({ category: z.string().max(40), frequency: z.string().max(20) }))
  .handler(({ data }) => run((viewer) => setEmailPreference(db, viewer, data)))

/** Hva avmeldingslenken slår av, uten å gjøre det (lenkesjekkere i e-post skal ikke melde av). */
export const fetchUnsubscribe = createServerFn({ method: 'GET' })
  .validator(z.object({ token: z.string().max(500) }))
  .handler(({ data }) => {
    try {
      return describeUnsubscribe(env.BETTER_AUTH_SECRET, data.token)
    } catch {
      return null
    }
  })

export const confirmUnsubscribe = createServerFn({ method: 'POST' })
  .validator(z.object({ token: z.string().max(500) }))
  .handler(async ({ data }) => {
    try {
      return await unsubscribe(db, env.BETTER_AUTH_SECRET, data.token)
    } catch {
      throw new Error('Lenken er ikke gyldig. Endre varslene under Konto og sikkerhet i stedet.')
    }
  })
