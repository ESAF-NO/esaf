import {
  accessLevel,
  activeRole,
  can,
  countUnreadNotifications,
  listActiveMembers,
  mayChangeSignInMethods,
  permissions,
  roleAtLeast,
  searchPeopleByTopic,
  searchUnclaimedProfiles,
  strongAuth,
  strongAuthRequired,
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
  const strong = viewer ? strongAuth(viewer) : false
  return {
    level,
    /** Rollen til et aktivt medlem. */
    role,
    /** Rettighetene den innloggede kan bruke nå. Bare for visning; serveren sjekker selv. */
    permissions: (Object.keys(permissions) as Permission[]).filter((p) => can(viewer, p)),
    /** Har adminrolle (selv om økten kanskje ikke er sterk nok), så adminområdet vises. */
    adminArea: role !== null && roleAtLeast(role, 'admin'),
    twoFactorEnabled: viewer?.twoFactorEnabled ?? false,
    hasPasskey: viewer?.hasPasskey ?? false,
    /** Denne økten er startet med passkey. */
    passkeySession: viewer?.passkeySession ?? false,
    /** Rollen krever sterk innlogging, og denne økten er ikke det. */
    strongAuthMissing: role !== null && strongAuthRequired(role) && !strong,
    /** Om økten kan legge til og fjerne passkeys og slå på tofaktor. */
    mayChangeSignInMethods: viewer ? mayChangeSignInMethods(viewer) : false,
    fullName: card?.fullName ?? null,
    photo: card?.photo ?? null,
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

/**
 * Personsøket på hva folk kan: ord i profilen og likhet i mening (se
 * `people-search.ts` i @esaf/core). Gir personene i rekkefølge, med grunnen.
 */
export const findPeopleByTopic = createServerFn({ method: 'GET' })
  .validator(z.object({ q: z.string().max(200) }))
  .handler(async ({ data }) => {
    try {
      const { embedder } = await import('#/server/search.server.ts')
      const hits = await searchPeopleByTopic(db, await getRequestViewer(), data.q, {
        embedder,
        limit: 60,
      })
      return hits.map(({ personId, reason, matchedBy }) => ({ personId, reason, matchedBy }))
    } catch (error) {
      return rethrowForClient(error)
    }
  })
