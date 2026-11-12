import {
  addOwnParticipations,
  awardBadge,
  badgeColors,
  badgeIcons,
  badgeRarities,
  badgeOptions,
  createBadge,
  deleteBadge,
  findBadgeCandidates,
  getBadgeForAdmin,
  listBadgesForAdmin,
  listMissedEvents,
  previewBadgeRule,
  revokeBadge,
  setBadgeStatus,
  setOwnBadgeHidden,
  updateBadge,
  type BadgeRuleInput,
} from '@esaf/core'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withViewer as run } from '#/server/access.server.ts'
import { db } from '#/server/db.server.ts'
import { storage } from '#/server/photos.server.ts'

// Merker. Egne merker og «Var du der?» er for alle medlemmer (merkene
// vises på profilene); resten er Admin og krever badges.manage. Rettigheter og full
// validering i @esaf/core.

export const hideOwnBadge = createServerFn({ method: 'POST' })
  .validator(z.object({ badgeId: z.uuid(), hidden: z.boolean() }))
  .handler(({ data }) => run((viewer) => setOwnBadgeHidden(db, viewer, data.badgeId, data.hidden)))

export const fetchMissedEvents = createServerFn({ method: 'GET' }).handler(() =>
  run((viewer) => listMissedEvents(db, viewer)),
)

export const addMyParticipations = createServerFn({ method: 'POST' })
  .validator(z.object({ eventIds: z.array(z.uuid()).min(1).max(200) }))
  .handler(({ data }) => run((viewer) => addOwnParticipations(db, viewer, data)))

// Admin

/** Regelen valideres i @esaf/core (`badgeRule`); her bare formen. */
const rule = z
  .object({ kind: z.string().max(40) })
  .loose()
  .transform((r) => r as BadgeRuleInput)

const badgeFields = z.object({
  name: z.string().max(200),
  description: z.string().max(1000),
  icon: z.enum(badgeIcons),
  color: z.enum(badgeColors),
  rule,
  series: z.string().max(200).nullable(),
  sortOrder: z.number().int(),
  rarity: z.enum(badgeRarities).nullable(),
})

export const fetchAdminBadges = createServerFn({ method: 'GET' }).handler(() =>
  run((viewer) => listBadgesForAdmin(db, viewer)),
)

export const fetchAdminBadge = createServerFn({ method: 'GET' })
  .validator(z.object({ badgeId: z.uuid() }))
  .handler(({ data }) => run((viewer) => getBadgeForAdmin(db, viewer, data.badgeId)))

export const fetchBadgeOptions = createServerFn({ method: 'GET' }).handler(() =>
  run((viewer) => badgeOptions(db, viewer)),
)

export const previewBadge = createServerFn({ method: 'POST' })
  .validator(z.object({ rule }))
  .handler(({ data }) => run((viewer) => previewBadgeRule(db, viewer, data.rule, { sample: 12 })))

export const newBadge = createServerFn({ method: 'POST' })
  .validator(badgeFields.extend({ publish: z.boolean() }))
  .handler(({ data: { publish, ...values } }) =>
    run((viewer) => createBadge(db, viewer, values, { publish })),
  )

export const saveBadge = createServerFn({ method: 'POST' })
  .validator(badgeFields.extend({ badgeId: z.uuid() }))
  .handler(({ data: { badgeId, ...values } }) =>
    run((viewer) => updateBadge(db, viewer, badgeId, values)),
  )

export const changeBadgeStatus = createServerFn({ method: 'POST' })
  .validator(z.object({ badgeId: z.uuid(), status: z.enum(['published', 'archived']) }))
  .handler(({ data }) => run((viewer) => setBadgeStatus(db, viewer, data.badgeId, data.status)))

export const removeBadge = createServerFn({ method: 'POST' })
  .validator(z.object({ badgeId: z.uuid() }))
  .handler(({ data }) => run((viewer) => deleteBadge(db, storage, viewer, data.badgeId)))

export const giveBadge = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      badgeId: z.uuid(),
      personIds: z.array(z.uuid()).min(1).max(200),
      citation: z.string().max(1000).nullable(),
    }),
  )
  .handler(({ data: { badgeId, ...input } }) =>
    run((viewer) => awardBadge(db, viewer, badgeId, input)),
  )

export const takeBadge = createServerFn({ method: 'POST' })
  .validator(z.object({ badgeId: z.uuid(), personIds: z.array(z.uuid()).min(1).max(200) }))
  .handler(({ data: { badgeId, personIds } }) =>
    run((viewer) => revokeBadge(db, viewer, badgeId, { personIds })),
  )

export const fetchAwardCandidates = createServerFn({ method: 'GET' })
  .validator(z.object({ query: z.string().max(100) }))
  .handler(({ data }) => run((viewer) => findBadgeCandidates(db, viewer, data.query)))
