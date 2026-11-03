import {
  acceptAllReview,
  addFieldSources,
  bulkReviewKinds,
  clearImportedField,
  companySourceFields,
  decideCompanyLink,
  decideSuggestion,
  dismissDuplicate,
  listAccessRequests,
  listAdminCompanies,
  listAuditEvents,
  listEventTypes,
  listInvitations,
  listPeopleIndex,
  listReview,
  markSourcesReviewed,
  normalizePersonName,
  profileSourceFields,
  REVIEW_PAGE_SIZE,
  reviewCounts,
  reviewKinds,
  searchCompanies,
  viewerCard,
} from '@esaf/core'
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { defineTool, id, links, sourceInput, type ToolContext } from '../context.ts'

export function registerAdminTools(server: McpServer, ctx: ToolContext) {
  defineTool(server, ctx, {
    name: 'overview',
    title: 'Overview',
    description:
      'Start here. Who you are acting as, and the state of ESAF: people and profiles, companies, events, ' +
      'what is waiting in review, open access requests and pending invitations.',
    input: z.object({}),
    effect: 'read',
    run: async (_args, ctx) => {
      const { db, viewer } = ctx
      const [card, people, companies, review, requests, invitations, events] = await Promise.all([
        viewerCard(db, viewer),
        listPeopleIndex(db, viewer),
        listAdminCompanies(db, viewer),
        reviewCounts(db, viewer),
        listAccessRequests(db, viewer, 'open').catch(() => null),
        listInvitations(db, viewer, { limit: 200 }).catch(() => null),
        listEventTypes(db, viewer),
      ])
      return {
        actingAs: {
          personId: viewer.personId,
          fullName: card?.fullName ?? null,
          role: viewer.membership?.role ?? null,
          readOnly: viewer.mcp?.readOnly ?? false,
        },
        appUrl: ctx.appUrl,
        people: {
          total: people.length,
          withAccount: people.filter((p) => p.claimed).length,
          unclaimedProfiles: people.filter((p) => !p.claimed).length,
          active: people.filter((p) => p.status === 'active').length,
          pending: people.filter((p) => p.status === 'pending').length,
          inactive: people.filter((p) => p.status === 'inactive').length,
          withoutPhoto: people.filter((p) => !p.has.photo).length,
          withoutBio: people.filter((p) => !p.has.bio).length,
          withoutCohort: people.filter((p) => !p.cohorts.length).length,
        },
        companies: {
          total: companies.length,
          withoutLogo: companies.filter((c) => !c.logo).length,
          withoutDescription: companies.filter((c) => !c.hasDescription).length,
          unknownStatus: companies.filter((c) => c.status === 'unknown').length,
          nobodyLinked: companies.filter((c) => c.people === 0).length,
        },
        events: events.types.map((t) => ({
          type: t.name,
          slug: t.slug,
          events: t.events,
          people: t.people,
        })),
        review,
        openAccessRequests: requests?.length ?? null,
        pendingInvitations: invitations?.filter((i) => i.status === 'pending').length ?? null,
      }
    },
  })

  defineTool(server, ctx, {
    name: 'search',
    title: 'Search people and companies',
    description:
      'Find people (all, including unclaimed and inactive) and companies by name. Use before creating anything, to avoid duplicates.',
    input: z.object({ q: z.string().min(2).max(100) }),
    effect: 'read',
    run: async ({ q }, ctx) => {
      const wanted = normalizePersonName(q)
      const [people, companies] = await Promise.all([
        listPeopleIndex(ctx.db, ctx.viewer),
        searchCompanies(ctx.db, ctx.viewer, q, 10),
      ])
      return {
        people: people
          .filter((p) => normalizePersonName(p.fullName).includes(wanted))
          .slice(0, 15)
          .map((p) => ({
            personId: p.personId,
            fullName: p.fullName,
            claimed: p.claimed,
            status: p.status,
            cohorts: p.cohortYears,
            currentCompany: p.currentCompany,
            link: links.person(ctx, p.personId),
          })),
        companies: companies.map((c) => ({
          companyId: c.id,
          slug: c.slug,
          name: c.name,
          tagline: c.tagline,
          members: c.people,
          sameName: c.exact,
          link: links.company(ctx, c.slug),
        })),
      }
    },
  })

  // -------------------------------------------------------------------------
  // Gjennomgang
  // -------------------------------------------------------------------------

  defineTool(server, ctx, {
    name: 'list_review',
    title: 'Review queue',
    description:
      `Everything uncertain, ${REVIEW_PAGE_SIZE} per page: events (low-confidence company history), quotes (uncertain speaker), ` +
      'sources (imported/researched fields nobody has confirmed or reviewed), companyDuplicates, personDuplicates, ' +
      'suggestions (from members) and links (people said to be in a company, on unclaimed profiles).',
    input: z.object({
      kind: z.enum(reviewKinds),
      page: z.number().int().min(1).default(1),
    }),
    effect: 'read',
    run: ({ kind, page }, ctx) => listReview(ctx.db, ctx.viewer, kind, page),
  })

  defineTool(server, ctx, {
    name: 'mark_sources_reviewed',
    title: 'Mark fields reviewed',
    description:
      'Mark imported/researched fields as looked over (all fields of the person/company, or some). Removes them from review; ' +
      'the profile still shows "ikke bekreftet" until the person confirms.',
    input: z.object({
      entityType: z.enum(['person', 'company']),
      entityId: id('The person or company'),
      fields: z.array(z.string()).optional(),
    }),
    effect: 'write',
    idempotent: true,
    run: async (args, ctx) => ({ reviewed: await markSourcesReviewed(ctx.db, ctx.viewer, args) }),
  })

  defineTool(server, ctx, {
    name: 'accept_all_review',
    title: 'Accept everything of one kind in review',
    description:
      'Bulk accept in review: "events" first merges similar uncertain events (same company, date and type) into ' +
      'one with all their sources, then shows the rest to members; "quotes" shows all uncertain quotes; ' +
      '"sources" marks all imported fields as looked over. Duplicates and member suggestions are never bulk ' +
      'accepted. Ask the admin first.',
    input: z.object({ kind: z.enum(bulkReviewKinds) }),
    effect: 'write',
    idempotent: true,
    run: ({ kind }, ctx) => acceptAllReview(ctx.db, ctx.viewer, kind),
  })

  defineTool(server, ctx, {
    name: 'clear_imported_field',
    title: 'Clear a wrong imported field',
    description:
      'Empty a field that is wrong, and its sources. Photo, logo, name and experience are changed with their own tools.',
    input: z.object({
      entityType: z.enum(['person', 'company']),
      entityId: id('The person or company'),
      field: z.string(),
    }),
    effect: 'destructive',
    run: async (args, ctx) => {
      await clearImportedField(ctx.db, ctx.viewer, args)
      return { cleared: args.field }
    },
  })

  defineTool(server, ctx, {
    name: 'dismiss_duplicate',
    title: 'Not a duplicate',
    description:
      'Say that two people or companies suggested as duplicates are not the same, so they are not suggested again.',
    input: z.object({
      kind: z.enum(['person', 'company']),
      firstId: z.uuid(),
      secondId: z.uuid(),
    }),
    effect: 'write',
    idempotent: true,
    run: async ({ kind, firstId, secondId }, ctx) => {
      await dismissDuplicate(ctx.db, ctx.viewer, {
        kind: kind === 'person' ? 'person_duplicate' : 'company_duplicate',
        firstId,
        secondId,
      })
      return { dismissed: true }
    },
  })

  defineTool(server, ctx, {
    name: 'decide_suggestion',
    title: 'Accept or reject a suggestion',
    description:
      "Accept or reject a member's suggestion for a company (info change, history event or article). " +
      'An accepted suggestion is saved as if you made the change.',
    input: z.object({ suggestionId: id('The suggestion'), decision: z.enum(['accept', 'reject']) }),
    effect: 'write',
    run: async ({ suggestionId, decision }, ctx) => {
      const { slug } = await decideSuggestion(ctx.db, ctx.viewer, suggestionId, decision)
      return { suggestionId, decision, company: links.company(ctx, slug) }
    },
  })

  defineTool(server, ctx, {
    name: 'decide_company_link',
    title: 'Confirm or reject a company link',
    description:
      'Confirm (for unclaimed profiles) or reject that a person was part of a company, as reported by a member. ' +
      'Confirmed links become experience or ES company on the profile.',
    input: z.object({ requestId: id('The link request'), decision: z.enum(['accept', 'reject']) }),
    effect: 'write',
    run: async ({ requestId, decision }, ctx) => {
      await decideCompanyLink(ctx.db, ctx.viewer, requestId, decision)
      return { requestId, decision }
    },
  })

  defineTool(server, ctx, {
    name: 'add_field_sources',
    title: 'Add sources to fields',
    description:
      'Record where information on a profile or company came from, without changing the value. Members see ' +
      '"Fra <source> · ikke bekreftet" until the person (or someone in the company) confirms. ' +
      `Person fields: ${profileSourceFields.join(', ')}. Company fields: ${companySourceFields.join(', ')}. ` +
      'Contact details never have sources. reviewed=true keeps the fields out of the review queue.',
    input: z.object({
      entityType: z.enum(['person', 'company']),
      entityId: id('The person or company'),
      sources: z.array(sourceInput).min(1).max(30),
      reviewed: z.boolean().default(false),
    }),
    effect: 'write',
    idempotent: true,
    run: (args, ctx) => addFieldSources(ctx.db, ctx.viewer, args),
  })

  // -------------------------------------------------------------------------
  // Revisjonsloggen
  // -------------------------------------------------------------------------

  defineTool(server, ctx, {
    name: 'list_audit_log',
    title: 'Audit log',
    description:
      'Who did what, newest first. Filter by person (actor or subject), action prefix (e.g. "company.", "profile.create") ' +
      'or viaMcp=true for changes made from MCP clients (keys or OAuth connections). Page back with beforeId=<id of the last entry>; ' +
      'before=<datetime> starts from a point in time.',
    input: z.object({
      personId: z.uuid().optional(),
      actionPrefix: z.string().max(60).optional(),
      viaMcp: z.boolean().optional(),
      beforeId: z.uuid().optional().describe('Id of the last entry on the previous page.'),
      before: z.iso.datetime().optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }),
    effect: 'read',
    run: async (args, ctx) =>
      (
        await listAuditEvents(ctx.db, ctx.viewer, {
          ...args,
          before: args.before ? new Date(args.before) : undefined,
        })
      ).map((e) => ({
        id: e.id,
        action: e.action,
        createdAt: e.createdAt,
        actor: e.actor?.fullName ?? (e.viaMcp ? null : 'operator (CLI)'),
        actorPersonId: e.actor?.personId ?? null,
        subject: e.subject?.fullName ?? null,
        subjectPersonId: e.subject?.personId ?? null,
        viaMcp: e.viaMcp?.name ?? null,
        details: e.details,
      })),
  })
}
