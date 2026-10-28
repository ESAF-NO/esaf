import { listPosts, searchCompanies, searchPeople } from '@esaf/core'
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
      const [people, companies, posts] = await Promise.all([
        searchPeople(db, viewer, q, 6),
        searchCompanies(db, viewer, q, 4),
        listPosts(db, viewer, { q, limit: 5 }),
      ])
      return {
        people,
        companies: companies.map(({ slug, name, tagline, people }) => ({
          slug,
          name,
          tagline,
          people,
        })),
        posts: posts.map((p) => ({ id: p.id, title: p.title, channel: p.channel })),
      }
    } catch (error) {
      return rethrowForClient(error)
    }
  })
