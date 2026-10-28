import {
  countUnreadNotifications,
  listMentionable,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '@esaf/core'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withViewer as run } from '#/server/access.server.ts'
import { db } from '#/server/db.server.ts'

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
