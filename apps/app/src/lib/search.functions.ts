import { companySlug, listCompanies, listPosts, searchPeople } from '@esaf/core'
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
      const slug = companySlug(q)
      const [people, companies, posts] = await Promise.all([
        searchPeople(db, viewer, q, 6),
        listCompanies(db, viewer),
        listPosts(db, viewer, { q, limit: 5 }),
      ])
      return {
        people,
        companies: companies
          .filter((c) => c.slug.includes(slug))
          .slice(0, 4)
          .map((c) => ({ slug: c.slug, name: c.name, people: c.people.length })),
        posts: posts.map((p) => ({ id: p.id, title: p.title, channel: p.channel })),
      }
    } catch (error) {
      return rethrowForClient(error)
    }
  })
