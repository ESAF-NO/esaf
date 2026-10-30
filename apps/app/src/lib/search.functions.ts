import { listPosts, searchCompanies, searchPeople, searchPeopleByTopic } from '@esaf/core'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { rethrowForClient } from '#/server/access.server.ts'
import { db } from '#/server/db.server.ts'
import { getRequestViewer } from '#/server/viewer.server.ts'

/** Søk for ⌘K-paletten: personer, selskaper og innlegg. */
export const quickSearch = createServerFn({ method: 'GET' })
  .validator(z.object({ q: z.string().max(100) }))
  .handler(async ({ data }) => {
    try {
      const viewer = await getRequestViewer()
      const q = data.q.trim()
      if (q.length < 2) return { people: [], companies: [], posts: [] }
      const { embedder } = await import('#/server/search.server.ts')
      const [byName, byTopic, companies, posts] = await Promise.all([
        searchPeople(db, viewer, q, 6),
        searchPeopleByTopic(db, viewer, q, { embedder, limit: 6 }),
        searchCompanies(db, viewer, q, 4),
        listPosts(db, viewer, { q, limit: 5 }),
      ])
      // Treff på navn og selskap først, så folk som kan noe om det (med grunnen).
      const seen = new Set(byName.map((p) => p.personId))
      const people = [
        ...byName.map((p) => ({ ...p, reason: null as string | null })),
        ...byTopic
          .filter((h) => !seen.has(h.personId) && h.matchedBy !== 'name')
          .map((h) => ({
            personId: h.personId,
            fullName: h.fullName,
            photo: h.photo,
            claimed: h.claimed,
            jobTitle: null,
            currentCompany: null,
            representativeOf: [] as number[],
            // Treff på tema har ikke vervene med; merket vises bare ved treff på navn.
            boardRole: null,
            reason: h.reason,
          })),
      ].slice(0, 6)
      return {
        people,
        companies: companies.map(({ slug, name, logo, tagline, people }) => ({
          slug,
          name,
          logo,
          tagline,
          people,
        })),
        posts: posts.map((p) => ({ id: p.id, title: p.title, channel: p.channel })),
      }
    } catch (error) {
      return rethrowForClient(error)
    }
  })
