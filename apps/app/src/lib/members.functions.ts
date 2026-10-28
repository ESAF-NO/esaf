import {
  accessLevel,
  decideMembership,
  linkAccountToProfile,
  listActiveMembers,
  listPendingMemberships,
  searchUnclaimedProfiles,
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
  return {
    level: accessLevel(viewer),
    emailVerified: viewer?.emailVerified ?? false,
    status: viewer?.membership?.status ?? null,
  }
})

export const getMembers = createServerFn({ method: 'GET' }).handler(async () => {
  try {
    return await listActiveMembers(db, await getRequestViewer())
  } catch (error) {
    return rethrowForClient(error)
  }
})

export const getPendingMemberships = createServerFn({ method: 'GET' }).handler(async () => {
  try {
    const pending = await listPendingMemberships(db, await getRequestViewer())
    return pending.map((p) => ({ ...p, requestedAt: p.requestedAt.toISOString() }))
  } catch (error) {
    return rethrowForClient(error)
  }
})

export const decidePendingMembership = createServerFn({ method: 'POST' })
  .validator(z.object({ personId: z.uuid(), decision: z.enum(['approve', 'reject']) }))
  .handler(async ({ data }) => {
    try {
      await decideMembership(db, await getRequestViewer(), data)
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

export const linkPendingToProfile = createServerFn({ method: 'POST' })
  .validator(z.object({ pendingPersonId: z.uuid(), profilePersonId: z.uuid() }))
  .handler(async ({ data }) => {
    try {
      await linkAccountToProfile(db, await getRequestViewer(), data)
    } catch (error) {
      return rethrowForClient(error)
    }
  })
