import {
  accessLevel,
  activeRole,
  can,
  countUnreadNotifications,
  listActiveMembers,
  permissions,
  roleAtLeast,
  searchUnclaimedProfiles,
  twoFactorRequired,
  viewerCard,
  type Permission,
} from '@esaf/core'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { rethrowForClient } from '#/server/access.server.ts'
import { db } from '#/server/db.server.ts'
import { getRequestViewer } from '#/server/viewer.server.ts'

/**
 * Alle private data hentes gjennom disse serverfunksjonene. Hver av dem slår
 * opp sesjonen og sjekker tilgang på serveren ved hvert kall, også når de
 * kalles etter klientnavigasjon. Rutevaktene i UI-et er bare for brukervennlighet.
 */

export const getViewerSummary = createServerFn({ method: 'GET' }).handler(async () => {
  const viewer = await getRequestViewer()
  const level = accessLevel(viewer)
  const [card, unreadNotifications] = await Promise.all([
    viewerCard(db, viewer),
    level === 'member' ? countUnreadNotifications(db, viewer) : 0,
  ])
  const role = activeRole(viewer)
  return {
    level,
    /** Rollen til et aktivt medlem. */
    role,
    /** Rettighetene den innloggede kan bruke nå. Bare for visning; serveren sjekker selv. */
    permissions: (Object.keys(permissions) as Permission[]).filter((p) => can(viewer, p)),
    /** Har adminrolle (selv om tofaktor kanskje mangler), så adminområdet vises. */
    adminArea: role !== null && roleAtLeast(role, 'admin'),
    twoFactorEnabled: viewer?.twoFactorEnabled ?? false,
    /** Rollen krever tofaktor, men det er ikke slått på. */
    twoFactorMissing: role !== null && twoFactorRequired(role) && !viewer?.twoFactorEnabled,
    fullName: card?.fullName ?? null,
    email: card?.email ?? null,
    jobTitle: card?.jobTitle ?? null,
    currentCompany: card?.currentCompany ?? null,
    personId: viewer?.personId ?? null,
    emailVerified: viewer?.emailVerified ?? false,
    status: viewer?.membership?.status ?? null,
    /** Om personen har vært gjennom velkomststegene etter godkjenning. */
    onboarded: card?.onboarded ?? false,
    /** Forespørselen om tilgang, for dem som ikke er medlem ennå. */
    requestStatus: card?.requestStatus ?? null,
    /** Uleste varsler. Hentes ved hver navigering, så klokka i toppen alltid er oppdatert. */
    unreadNotifications,
  }
})

export const getMembers = createServerFn({ method: 'GET' }).handler(async () => {
  try {
    return await listActiveMembers(db, await getRequestViewer())
  } catch (error) {
    return rethrowForClient(error)
  }
})

export const findUnclaimedProfiles = createServerFn({ method: 'GET' })
  .validator(z.object({ query: z.string().max(100) }))
  .handler(async ({ data }) => {
    try {
      return await searchUnclaimedProfiles(db, await getRequestViewer(), data.query)
    } catch (error) {
      return rethrowForClient(error)
    }
  })
