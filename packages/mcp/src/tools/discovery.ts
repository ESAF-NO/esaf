import {
  getUniverse,
  listPeopleForTopics,
  reindexPeople,
  searchPeopleByTopic,
  setSearchTopics,
} from '@esaf/core'
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server'
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { defineTool, links, toolError, type ToolContext } from '../context.ts'
import { UNIVERSE_HTML } from '../views/universe.generated.ts'

export const UNIVERSE_URI = 'ui://esaf/universe.html'

/**
 * Å finne folk og se sammenhengene: personsøket på hva folk kan, søkeordene
 * som gjør det bedre, og «ES-universet» som en interaktiv visning (MCP App) i
 * klienter som støtter det. Andre klienter får et sammendrag som tekst.
 */
export function registerDiscoveryTools(server: McpServer, ctx: ToolContext) {
  defineTool(server, ctx, {
    name: 'find_people',
    title: 'Find people by topic',
    description:
      'Find people by what they know or have done, not just their name: "space", "fish farming", "fintech", ' +
      '"maskinlæring". Combines words in the profile (jobs with company descriptions, bio, search topics) with ' +
      'similarity in meaning (local embedding model, Norwegian and English). Each hit says why it matched. Search ' +
      'one topic at a time; for questions like "who in Oslo from ES 2015 knows health?", search "helse" and filter ' +
      'the hits yourself (get_person has city and cohorts).',
    input: z.object({
      query: z.string().min(2).max(200),
      limit: z.number().int().min(1).max(50).default(15),
    }),
    effect: 'read',
    run: async ({ query, limit }, ctx) => {
      const hits = await searchPeopleByTopic(ctx.db, ctx.viewer, query, {
        embedder: ctx.embedder,
        limit,
      })
      return {
        semantic: ctx.embedder !== null,
        hits: hits.map((h) => ({
          personId: h.personId,
          fullName: h.fullName,
          cohorts: h.cohortYears,
          matchedBy: h.matchedBy,
          reason: h.reason,
          link: links.person(ctx, h.personId),
        })),
      }
    },
  })

  defineTool(server, ctx, {
    name: 'list_people_for_tagging',
    title: 'People to tag with search topics',
    description:
      'What the profile says about each person (jobs with what the companies do, bio, study), to write search topics ' +
      'from, with their current topics. status per person: "missing" (never tagged), "outdated" (the profile ' +
      'changed after the topics were written), "done". Filter with status: "todo" (default: missing and outdated), ' +
      '"missing", "outdated", "done" or "all"; counts gives the totals. People with nothing to go on (only a name ' +
      'and study) are left out. Then call set_search_topics.',
    input: z.object({
      status: z.enum(['todo', 'missing', 'outdated', 'done', 'all']).default('todo'),
      cohort: z.number().int().optional(),
      limit: z.number().int().min(1).max(100).default(40),
      offset: z.number().int().min(0).default(0),
    }),
    effect: 'read',
    run: (args, ctx) => listPeopleForTopics(ctx.db, ctx.viewer, args),
  })

  defineTool(server, ctx, {
    name: 'set_search_topics',
    title: 'Set search topics',
    description:
      'Set search topics for people (replaces their current ones), so find_people and the member directory find ' +
      'them on what they know. Also marks them as tagged from the profile text as it is now; an empty list means ' +
      '"nothing to add". Write 5–15 short topics per person, in BOTH Norwegian and English, including broader concepts ' +
      'and synonyms the profile does not spell out: someone at NASA → "romfart, space, aerospace, satellitter, NASA". ' +
      'Only from what the profile and its companies actually say; never sensitive data (health, religion, politics, ' +
      'family). Topics are not shown on the profile, only as the reason for a search hit. Up to 200 people per call.',
    input: z.object({
      people: z
        .array(
          z.object({
            personId: z.uuid(),
            topics: z.array(z.string().min(2).max(40)).max(25),
          }),
        )
        .min(1)
        .max(200),
    }),
    effect: 'write',
    idempotent: true,
    run: async ({ people }, ctx) => {
      const { updated } = await setSearchTopics(ctx.db, ctx.viewer, people)
      // De endrede personene indekseres med en gang, så søket finner dem nå.
      const index = ctx.embedder
        ? await reindexPeople(ctx.db, ctx.embedder, { limit: Math.max(updated, 1) })
        : null
      return { updated, indexed: index?.indexed ?? 0 }
    },
  })

  // «ES-universet» som MCP App. Ressursen er HTML-en; verktøyet gir dataene.
  registerAppResource(
    server,
    'ES-universet',
    UNIVERSE_URI,
    {
      description: 'Interaktivt kart over alle fra ES og selskapene de har bygget, over tid.',
      mimeType: RESOURCE_MIME_TYPE,
      // Ingen eksterne kall eller ressurser: alt ligger i HTML-en.
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false } },
    },
    async () => ({
      contents: [{ uri: UNIVERSE_URI, mimeType: RESOURCE_MIME_TYPE, text: UNIVERSE_HTML }],
    }),
  )

  registerAppTool(
    server,
    'show_universe',
    {
      title: 'Show the ES universe',
      description:
        'Show an interactive map of everyone from ES and the companies they founded, were ES team in or worked at, ' +
        'over time (spiral by cohort, timeline with play button, company family trees and spinoffs). ' +
        'In clients without MCP Apps, returns a text summary.',
      inputSchema: z.object({}),
      annotations: { title: 'Show the ES universe', readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: UNIVERSE_URI } },
    },
    async () => {
      try {
        const universe = await getUniverse(ctx.db, ctx.viewer)
        const founders = new Set(
          universe.links.filter((l) => l.role !== 'employee').map((l) => l.companyId),
        )
        const summary = {
          people: universe.people.length,
          companies: universe.companies.length,
          foundedOrEsCompanies: founders.size,
          acquired: universe.companies.filter((c) => c.acquired !== null || c.status === 'acquired')
            .length,
          closed: universe.companies.filter((c) => c.closed !== null || c.status === 'closed')
            .length,
          years: `${universe.firstYear}–${universe.lastYear}`,
        }
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `ES-universet: ${summary.people} personer, ${summary.companies} selskaper ` +
                `(${summary.foundedOrEsCompanies} startet eller ES-selskap), ${summary.acquired} oppkjøpt, ` +
                `${summary.closed} nedlagt, ${summary.years}. Vises som et interaktivt kart i klienter med MCP Apps.`,
            },
          ],
          structuredContent: { ...universe, appUrl: ctx.appUrl },
        }
      } catch (error) {
        return toolError(error)
      }
    },
  )
}
