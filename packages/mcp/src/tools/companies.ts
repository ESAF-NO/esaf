import {
  addCompanyArticle,
  addCompanyEvent,
  addFieldSources,
  companyEventTypes,
  programmeKinds,
  companySourceFields,
  COMPANY_INDUSTRY_MAX,
  companyStatuses,
  confirmCompanyEvent,
  createCompany,
  deleteCompany,
  deleteCompanyArticle,
  deleteCompanyEvent,
  DomainError,
  getCompany,
  getEditableCompany,
  companySlugById,
  listAdminCompanies,
  mergeCompanies,
  NotFoundError,
  removeCompanyLogo,
  setCompanyFormerNames,
  setCompanyLogo,
  updateCompany,
  updateCompanyArticle,
  updateCompanyEvent,
  type CompanyInput,
} from '@esaf/core'
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import {
  defineTool,
  id,
  imageInput,
  links,
  page,
  paginate,
  readImage,
  reason,
  sourceInput,
  type ToolContext,
} from '../context.ts'
import { decodeBase64Image } from '../images.ts'

const sourcesField = z
  .array(sourceInput)
  .max(30)
  .optional()
  .describe(
    `Where the information came from, per field (${companySourceFields.join(', ')}). ` +
      'Shown on the company page until someone connected to the company confirms. Always include for researched data.',
  )

const companyFields = {
  tagline: z
    .string()
    .max(140)
    .nullable()
    .optional()
    .describe('One line about what the company does (Norwegian).'),
  description: z
    .string()
    .max(3000)
    .nullable()
    .optional()
    .describe('"Om selskapet": a few paragraphs (Norwegian).'),
  website: z.string().max(300).nullable().optional(),
  foundedYear: z.number().int().nullable().optional(),
  location: z.string().max(80).nullable().optional().describe('City, e.g. "Trondheim".'),
  industries: z.array(z.string().max(COMPANY_INDUSTRY_MAX)).max(10).optional(),
  status: z
    .enum(companyStatuses)
    .optional()
    .describe('active, acquired, closed or unknown (nobody has said whether it is alive).'),
}

const eventFields = {
  year: z.number().int(),
  month: z.number().int().min(1).max(12).nullable().default(null).describe('Omit if unknown.'),
  day: z.number().int().min(1).max(31).nullable().default(null).describe('Needs month.'),
  type: z.enum(companyEventTypes),
  text: z
    .string()
    .max(500)
    .default('')
    .describe(
      'What happened, one sentence in Norwegian. Optional for type "programme" (the programme is shown).',
    ),
  sourceUrl: z.string().max(500).nullable().default(null),
  sourceLabel: z.string().max(80).nullable().default(null),
  programme: z
    .object({
      companyId: z
        .uuid()
        .nullable()
        .default(null)
        .describe('The programme as an ESAF company (search first, e.g. "6am Accelerator").'),
      name: z
        .string()
        .max(120)
        .default('')
        .describe(
          'Programme name, used when companyId is null: an existing company with the same slug is used, otherwise one is created.',
        ),
      kind: z.enum(programmeKinds).describe('accelerator, incubator, pre_incubator or other.'),
      batch: z
        .string()
        .max(40)
        .nullable()
        .default(null)
        .describe('The batch as the programme names it, e.g. "W22", "Kull 3".'),
    })
    .nullable()
    .default(null)
    .describe('Required for type "programme", ignored otherwise. Date = when they started.'),
}

const articleFields = {
  url: z.string().max(1000),
  title: z.string().max(300),
  publisher: z
    .string()
    .max(120)
    .nullable()
    .default(null)
    .describe('E.g. "Adresseavisen". Defaults to the domain.'),
  year: z.number().int().nullable().default(null),
  month: z.number().int().min(1).max(12).nullable().default(null),
  day: z.number().int().min(1).max(31).nullable().default(null),
  paywall: z.boolean().default(false),
  mentionsEs: z.boolean().default(false).describe('The article mentions Entreprenørskolen.'),
}

async function companyDetails(ctx: ToolContext, ref: { companyId?: string; slug?: string }) {
  let slug =
    ref.slug ?? (ref.companyId ? await companySlugById(ctx.db, ctx.viewer, ref.companyId) : null)
  if (!slug) throw new DomainError('Oppgi companyId eller slug.')
  let details = await getCompany(ctx.db, ctx.viewer, slug)
  if ('movedTo' in details) {
    slug = details.movedTo
    details = await getCompany(ctx.db, ctx.viewer, slug)
    if ('movedTo' in details) throw new NotFoundError('Fant ikke selskapet.')
  }
  return {
    companyId: details.id,
    slug: details.slug,
    link: links.company(ctx, details.slug),
    name: details.name,
    formerNames: details.formerNames,
    status: details.status,
    tagline: details.tagline,
    description: details.description,
    website: details.website,
    foundedYear: details.foundedYear,
    location: details.location,
    industries: details.industries,
    lastSeenOnEsSite: details.lastSeenOnEsSite,
    logo: links.asset(ctx, details.logo?.large),
    startedByAlumni: details.startedByAlumni,
    esCompany: details.esCompany,
    people: details.people.map((p) => ({
      personId: p.personId,
      fullName: p.fullName,
      role: p.role,
      esTeam: p.esTeam,
      title: p.title,
      startYear: p.startYear,
      endYear: p.endYear,
      cohorts: p.cohortYears,
    })),
    events: details.events.map((e) => ({
      companyEventId: e.id,
      date: e.date,
      precision: e.datePrecision,
      type: e.type,
      text: e.text,
      ...(e.programme
        ? {
            programme: {
              companyId: e.programme.company?.id ?? null,
              slug: e.programme.company?.slug ?? null,
              name: e.programme.company?.name ?? null,
              kind: e.programme.kind,
              batch: e.programme.batch,
            },
          }
        : {}),
      source: e.source,
      needsReview: e.review,
    })),
    programmeCompanies: details.programmeCompanies.map((p) => ({
      companyId: p.company.id,
      slug: p.company.slug,
      name: p.company.name,
      date: p.date,
      precision: p.datePrecision,
      kind: p.kind,
      batch: p.batch,
      companyEventId: p.eventId,
    })),
    articles: details.articles.map((a) => ({
      articleId: a.id,
      url: a.url,
      title: a.title,
      publisher: a.publisherLabel,
      publishedAt: a.publishedAt,
      precision: a.publishedPrecision,
      paywall: a.paywall,
      mentionsEs: a.mentionsEs,
    })),
    quotes: details.quotes.map((q) => ({
      quoteId: q.id,
      text: q.text,
      speaker: q.speaker.name,
      speakerPersonId: q.speaker.personId,
      confidence: q.confidence,
    })),
    sources: details.sources.map((s) => ({
      field: s.field,
      label: s.label,
      url: s.url,
      confirmed: s.confirmed,
      confidence: s.confidence,
    })),
    openSuggestions: details.suggestions.length,
  }
}

async function addSources(
  ctx: ToolContext,
  companyId: string,
  sources?: z.output<typeof sourceInput>[],
) {
  if (!sources?.length) return
  await addFieldSources(ctx.db, ctx.viewer, { entityType: 'company', entityId: companyId, sources })
}

export function registerCompanyTools(server: McpServer, ctx: ToolContext) {
  defineTool(server, ctx, {
    name: 'list_companies',
    title: 'List companies',
    description:
      'All companies, including those nobody is linked to, with filters for finding gaps (no logo, no description, ' +
      'no website, nobody linked, no history) and ES companies or cohorts. Returns compact rows; use get_company for details.',
    input: z.object({
      query: z
        .string()
        .max(100)
        .optional()
        .describe('Case-insensitive match on name, former names, slug or tagline.'),
      status: z.enum(companyStatuses).optional(),
      missing: z
        .array(z.enum(['logo', 'description', 'website', 'people', 'events']))
        .optional()
        .describe('Only companies missing ALL of these.'),
      esCompany: z.boolean().optional().describe('Someone had it as their company at ES.'),
      cohort: z.number().int().optional().describe('Founders or ES team from this cohort.'),
      sort: z.enum(['name', 'people', 'newest', 'edited']).default('name'),
      ...page,
    }),
    effect: 'read',
    run: async (args, ctx) => {
      const q = args.query?.trim().toLocaleLowerCase('nb')
      const missing = new Set(args.missing ?? [])
      const all = (await listAdminCompanies(ctx.db, ctx.viewer)).filter(
        (c) =>
          (!q ||
            [c.name, c.slug, c.tagline, ...c.formerNames].some((v) =>
              v?.toLocaleLowerCase('nb').includes(q),
            )) &&
          (!args.status || c.status === args.status) &&
          (args.esCompany === undefined || c.esCompany === args.esCompany) &&
          (args.cohort === undefined || c.cohortYears.includes(args.cohort)) &&
          (!missing.has('logo') || c.logo === null) &&
          (!missing.has('description') || !c.hasDescription) &&
          (!missing.has('website') || c.website === null) &&
          (!missing.has('people') || c.people === 0) &&
          (!missing.has('events') || c.events === 0),
      )
      const sorted = [...all].sort((a, b) =>
        args.sort === 'people'
          ? b.people - a.people || a.name.localeCompare(b.name, 'nb')
          : args.sort === 'newest'
            ? b.createdAt.getTime() - a.createdAt.getTime()
            : args.sort === 'edited'
              ? (b.editedAt?.getTime() ?? 0) - (a.editedAt?.getTime() ?? 0)
              : a.name.localeCompare(b.name, 'nb'),
      )
      const result = paginate(sorted, args)
      return {
        ...result,
        items: result.items.map((c) => ({
          companyId: c.id,
          slug: c.slug,
          name: c.name,
          status: c.status,
          tagline: c.tagline,
          website: c.website,
          hasLogo: c.logo !== null,
          hasDescription: c.hasDescription,
          people: c.people,
          founders: c.founders,
          esCompany: c.esCompany,
          cohorts: c.cohortYears,
          events: c.events,
          openSuggestions: c.suggestions,
          link: links.company(ctx, c.slug),
        })),
      }
    },
  })

  defineTool(server, ctx, {
    name: 'get_company',
    title: 'Get company',
    description:
      'Everything about one company: info, people from ES (founders, ES team, employees), history events ' +
      '(programme events link to the programme), articles ("I media"), quotes and field sources. ' +
      'For a programme (accelerator/incubator), programmeCompanies lists the companies that went through it. ' +
      'Give companyId or slug (old slugs redirect).',
    input: z.object({
      companyId: z.uuid().optional(),
      slug: z.string().max(200).optional(),
    }),
    effect: 'read',
    run: (args, ctx) => companyDetails(ctx, args),
  })

  defineTool(server, ctx, {
    name: 'create_company',
    title: 'Create company',
    description:
      'Create a company. Names that already exist (also as a former name or merged duplicate) are rejected; ' +
      'search with list_companies first. Link people with add_experience or update_person (esCompany).',
    input: z.object({
      name: z.string().max(120),
      ...companyFields,
      sources: sourcesField,
    }),
    effect: 'write',
    run: async ({ sources, ...fields }, ctx) => {
      const input: CompanyInput = {
        name: fields.name,
        tagline: fields.tagline ?? null,
        description: fields.description ?? null,
        website: fields.website ?? null,
        foundedYear: fields.foundedYear ?? null,
        location: fields.location ?? null,
        industries: fields.industries ?? [],
        status: fields.status ?? 'unknown',
      }
      const { id: companyId } = await createCompany(ctx.db, ctx.viewer, input)
      await addSources(ctx, companyId, sources)
      return companyDetails(ctx, { companyId })
    },
  })

  defineTool(server, ctx, {
    name: 'update_company',
    title: 'Update company',
    description:
      'Change company info. Only the fields you send change; null clears a field. A new name gives a new slug, ' +
      'the old one becomes an alias, and the old name is added to formerNames (unless it only differs in spelling ' +
      'or legal form). Add sources for researched data.',
    input: z.object({
      companyId: id('The company'),
      name: z.string().max(120).optional(),
      ...companyFields,
      sources: sourcesField,
    }),
    effect: 'write',
    idempotent: true,
    run: async ({ companyId, sources, ...changes }, ctx) => {
      const slug = await companySlugById(ctx.db, ctx.viewer, companyId)
      const current = await getEditableCompany(ctx.db, ctx.viewer, slug)
      if ('movedTo' in current) throw new NotFoundError('Fant ikke selskapet.')
      const set = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined))
      await updateCompany(ctx.db, ctx.viewer, companyId, {
        name: current.name,
        tagline: current.tagline,
        description: current.description,
        website: current.website,
        foundedYear: current.foundedYear,
        location: current.location,
        industries: current.industries,
        status: current.status,
        ...set,
      })
      await addSources(ctx, companyId, sources)
      return companyDetails(ctx, { companyId })
    },
  })

  defineTool(server, ctx, {
    name: 'delete_company',
    title: 'Delete company',
    description:
      'Delete a company. If people are linked to it, unlink=true is required and removes it from their profiles; ' +
      'then a reason is required too. History, articles, sources, suggestions and logo are deleted; quotes stay without company. ' +
      'Prefer merge_companies for duplicates. Cannot be undone.',
    input: z.object({
      companyId: id('The company'),
      unlink: z.boolean().default(false),
      reason: reason.optional(),
    }),
    effect: 'destructive',
    run: async (args, ctx) => {
      await deleteCompany(ctx.db, ctx.storage, ctx.viewer, {
        companyId: args.companyId,
        unlink: args.unlink,
        reason: args.reason ?? null,
      })
      return { deleted: args.companyId }
    },
  })

  defineTool(server, ctx, {
    name: 'merge_companies',
    title: 'Merge duplicate companies',
    description:
      'Merge a duplicate company (sourceId) into another (targetId): experience, ES team, history, articles, quotes, ' +
      'suggestions and requests move; empty fields are filled; the duplicate slug becomes an alias. Set formerName ' +
      'when the duplicate is the name the company had before a rebrand (e.g. Bølgepost → Fjordtek), not just another ' +
      'spelling; it is then shown as «Tidligere Bølgepost». Cannot be undone.',
    input: z.object({
      sourceId: id('The duplicate, which disappears'),
      targetId: id('The company to keep'),
      formerName: z
        .boolean()
        .default(false)
        .describe("The duplicate's name is a former name of the company, not another spelling."),
    }),
    effect: 'destructive',
    run: async (args, ctx) => {
      const { slug } = await mergeCompanies(ctx.db, ctx.storage, ctx.viewer, args)
      return { keptSlug: slug, link: links.company(ctx, slug) }
    },
  })

  defineTool(server, ctx, {
    name: 'set_company_former_names',
    title: 'Set former company names',
    description:
      'Replace the names the company had before, newest first (shown as «Tidligere …» and found by search). ' +
      'New names also become aliases, so experience written with the old name links here. A name another company ' +
      'has is rejected: merge them with merge_companies (formerName: true) instead. At most ten.',
    input: z.object({
      companyId: id('The company'),
      formerNames: z.array(z.string().max(120)).max(10),
    }),
    effect: 'write',
    idempotent: true,
    run: async ({ companyId, formerNames }, ctx) => {
      await setCompanyFormerNames(ctx.db, ctx.viewer, companyId, formerNames)
      return companyDetails(ctx, { companyId })
    },
  })

  defineTool(server, ctx, {
    name: 'set_company_logo',
    title: 'Set company logo',
    description:
      'Upload or replace a company logo from a public image URL (JPEG, PNG or WebP; not SVG) or base64. ' +
      'The logo is scaled into a square without cropping; transparency is kept. Prefer the logo from the company website.',
    input: z.object({
      companyId: id('The company'),
      ...imageInput,
      source: sourceInput.omit({ field: true }).optional().describe('Where the logo came from.'),
    }),
    effect: 'write',
    run: async ({ companyId, source, ...image }, ctx) => {
      const file = await readImage(ctx, image, decodeBase64Image)
      const logo = await setCompanyLogo(ctx.db, ctx.storage, ctx.viewer, companyId, file)
      if (source) await addSources(ctx, companyId, [{ ...source, field: 'logo' }])
      return { companyId, logo: links.asset(ctx, logo.large) }
    },
  })

  defineTool(server, ctx, {
    name: 'remove_company_logo',
    title: 'Remove company logo',
    description: 'Remove the logo; a letter tile is shown instead.',
    input: z.object({ companyId: id('The company') }),
    effect: 'destructive',
    idempotent: true,
    run: async ({ companyId }, ctx) => {
      await removeCompanyLogo(ctx.db, ctx.storage, ctx.viewer, companyId)
      return { companyId, logo: null }
    },
  })

  defineTool(server, ctx, {
    name: 'add_company_event',
    title: 'Add company history event',
    description:
      'Add an event to the company history: founded, funding, award, launch, acquired, bankrupt, dissolved, closed, other, ' +
      'or programme (went through an accelerator/incubator such as Y Combinator, StartupLab, 6am; set `programme`). ' +
      'The programme is itself an ESAF company, and its page lists every company that went through it. ' +
      'Include a source URL (the programme portfolio page is best). Shown to all members.',
    input: z.object({ companyId: id('The company'), ...eventFields }),
    effect: 'write',
    run: async ({ companyId, ...event }, ctx) => {
      const { id: companyEventId } = await addCompanyEvent(ctx.db, ctx.viewer, companyId, event)
      return { companyEventId }
    },
  })

  defineTool(server, ctx, {
    name: 'update_company_event',
    title: 'Update company history event',
    description:
      'Replace a history event (send all fields). Makes a low-confidence event visible to everyone.',
    input: z.object({ companyEventId: id('The history event'), ...eventFields }),
    effect: 'write',
    idempotent: true,
    run: async ({ companyEventId, ...event }, ctx) => {
      await updateCompanyEvent(ctx.db, ctx.viewer, companyEventId, event)
      return { companyEventId, updated: true }
    },
  })

  defineTool(server, ctx, {
    name: 'confirm_company_event',
    title: 'Confirm company history event',
    description:
      'Mark a low-confidence history event (from import) as correct, so all members see it.',
    input: z.object({ companyEventId: id('The history event') }),
    effect: 'write',
    idempotent: true,
    run: async ({ companyEventId }, ctx) => {
      await confirmCompanyEvent(ctx.db, ctx.viewer, companyEventId)
      return { companyEventId, confirmed: true }
    },
  })

  defineTool(server, ctx, {
    name: 'delete_company_event',
    title: 'Delete company history event',
    description:
      'Delete a history event that is wrong. To make a low-confidence event visible instead, use confirm_company_event.',
    input: z.object({ companyEventId: id('The history event') }),
    effect: 'destructive',
    run: async ({ companyEventId }, ctx) => {
      await deleteCompanyEvent(ctx.db, ctx.viewer, companyEventId)
      return { deleted: companyEventId }
    },
  })

  defineTool(server, ctx, {
    name: 'add_company_article',
    title: 'Add article ("I media")',
    description:
      'Add a news article or interview about the company. Only link, title, publisher, date and flags are stored, ' +
      'never the article text. The same article can only be added once per company (tracking parameters are ignored).',
    input: z.object({ companyId: id('The company'), ...articleFields }),
    effect: 'write',
    run: async ({ companyId, ...article }, ctx) => {
      const { id: articleId } = await addCompanyArticle(ctx.db, ctx.viewer, companyId, article)
      return { articleId }
    },
  })

  defineTool(server, ctx, {
    name: 'update_company_article',
    title: 'Update article',
    description: 'Replace an article (send all fields).',
    input: z.object({ articleId: id('The article'), ...articleFields }),
    effect: 'write',
    idempotent: true,
    run: async ({ articleId, ...article }, ctx) => {
      await updateCompanyArticle(ctx.db, ctx.viewer, articleId, article)
      return { articleId, updated: true }
    },
  })

  defineTool(server, ctx, {
    name: 'delete_company_article',
    title: 'Delete article',
    description: 'Remove an article from "I media".',
    input: z.object({ articleId: id('The article') }),
    effect: 'destructive',
    run: async ({ articleId }, ctx) => {
      await deleteCompanyArticle(ctx.db, ctx.viewer, articleId)
      return { deleted: articleId }
    },
  })
}
