import {
  awardBadge,
  badgeColors,
  badgeCompanyLinks,
  badgeEventRoles,
  badgeIcons,
  badgeOptions,
  badgeProfileFields,
  boardRoles,
  createBadge,
  programmeKinds,
  DomainError,
  deleteBadge,
  getBadgeForAdmin,
  listBadgesForAdmin,
  loadBadgeStats,
  previewBadgeRule,
  removeBadgeImage,
  revokeBadge,
  setBadgeImage,
  setBadgeStatus,
  syncBadges,
  updateBadge,
  type AdminBadge,
  type BadgeStats,
} from '@esaf/core'
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { defineTool, id, imageInput, links, readImage, type ToolContext } from '../context.ts'
import { decodeBase64Image } from '../images.ts'

// Merker (achievements). Reglene og valideringen står i @esaf/core (badges.ts);
// her er formen og forklaringene for modellen.

const eventTypeId = z
  .uuid()
  .nullable()
  .default(null)
  .describe(
    'Event type id from badge_options.eventTypes (e.g. ESAF-helgen). null = all event types.',
  )

/** Regelen for et merke, som modellen ser den. Samme typer som `badgeRule` i @esaf/core. */
export const badgeRuleInput = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('event_count'),
        eventTypeId,
        roles: z
          .array(z.enum(badgeEventRoles))
          .max(4)
          .default([])
          .describe(
            'Only count participations in these roles. participant = attended without a special role. Empty = any role.',
          ),
        count: z.number().int().min(1).max(200).describe('Minimum number of events.'),
      })
      .describe('Attended events (of a type) at least `count` times, optionally in a role.'),
    z
      .object({
        kind: z.literal('event_streak'),
        eventTypeId,
        years: z.number().int().min(2).max(50).describe('Consecutive calendar years.'),
      })
      .describe('Attended events (of a type) in `years` consecutive calendar years.'),
    z
      .object({
        kind: z.literal('event_attended'),
        eventIds: z
          .array(z.uuid())
          .min(1)
          .max(100)
          .describe('Event ids from badge_options.events.'),
        match: z
          .enum(['any', 'all'])
          .default('any')
          .describe('any = one of them, all = every one.'),
      })
      .describe('Attended specific events, e.g. the first ever ESAF-helgen.'),
    z
      .object({
        kind: z.literal('cohort'),
        relations: z
          .array(z.enum(['student', 'staff', 'mentor']))
          .min(1)
          .default(['student'])
          .describe('student (default), staff or mentor at ES.'),
        fromYear: z
          .number()
          .int()
          .nullable()
          .default(null)
          .describe('First cohort (graduation year).'),
        toYear: z
          .number()
          .int()
          .nullable()
          .default(null)
          .describe('Last cohort (graduation year).'),
      })
      .describe(
        'Was student/staff/mentor at ES, optionally in a range of cohorts ("pioneers 2000–2005").',
      ),
    z
      .object({
        kind: z.literal('cohort_complete'),
        place: z
          .number()
          .int()
          .min(1)
          .max(50)
          .nullable()
          .default(null)
          .describe(
            '1 = only the first cohort where everyone claimed their profile; n = one of the first n; null = every cohort that got there.',
          ),
      })
      .describe(
        'Is in a cohort where every active member has claimed their profile (the cohort race on /kull). ' +
          'The first time a cohort reaches 100 % is recorded and kept, so the order never changes.',
      ),
    z
      .object({
        kind: z.literal('board'),
        roles: z.array(z.enum(boardRoles)).max(4).default([]).describe('Empty = any board role.'),
        current: z.boolean().default(false).describe('Only people on the board now.'),
      })
      .describe('Served on the ESAF board, optionally in a role or currently.'),
    z
      .object({
        kind: z.literal('cohort_representative'),
        current: z.boolean().default(false),
      })
      .describe('Has been (or is now) a cohort representative.'),
    z
      .object({
        kind: z.literal('company'),
        link: z
          .enum(badgeCompanyLinks)
          .default('founder')
          .describe(
            'es_company = the company they started at ES; founder = founded (experience with founder=true); founder_or_es = either of those ("helped start it", usually right for programme badges); any = also companies they only worked at.',
          ),
        statuses: z
          .array(z.enum(['active', 'acquired', 'closed', 'unknown']))
          .max(4)
          .default([])
          .describe(
            'Only companies with these statuses, e.g. ["acquired"] for an exit badge. Empty = any.',
          ),
        count: z.number().int().min(1).max(20).default(1).describe('Minimum number of companies.'),
      })
      .describe(
        'Started or worked at companies; e.g. "Started a company at ES", "Exit", "Serial founder".',
      ),
    z
      .object({
        kind: z.literal('programme'),
        link: z
          .enum(badgeCompanyLinks)
          .default('founder')
          .describe('Which of their companies count, as for kind "company".'),
        programmeIds: z
          .array(z.uuid())
          .max(20)
          .default([])
          .describe(
            'The programmes (ESAF company ids, see badge_options.programmes), e.g. Y Combinator. Empty = any programme.',
          ),
        programmeKinds: z
          .array(z.enum(programmeKinds))
          .max(4)
          .default([])
          .describe('accelerator, incubator, pre_incubator, other. Empty = any.'),
        first: z
          .boolean()
          .default(false)
          .describe(
            'Only the first ESAF company in that programme (earliest programme event; ties all count). For "first from ESAF in Y Combinator".',
          ),
        duringEs: z
          .boolean()
          .default(false)
          .describe(
            'Only when the programme year was while the person studied at ES (ES 2024 ran 2022–2024).',
          ),
      })
      .describe(
        'A company of theirs went through an accelerator/incubator (company history events of type "programme"), e.g. "YC founder", "First from ESAF in Y Combinator", "Accelerator during ES".',
      ),
    z
      .object({
        kind: z.literal('profile'),
        fields: z
          .array(z.enum(badgeProfileFields))
          .min(1)
          .describe('Profile fields that must be filled in.'),
      })
      .describe('Filled in their profile. Good for nudging people to complete it.'),
    z
      .object({
        kind: z.literal('community'),
        metric: z.enum(['posts', 'comments']),
        count: z.number().int().min(1).max(1000),
      })
      .describe('Wrote at least `count` posts or comments in the feed.'),
    z
      .object({ kind: z.literal('manual') })
      .describe(
        'Awarded by hand with award_badge, with a citation. For anything the data cannot express.',
      ),
  ])
  .describe(
    'Who gets the badge. Automatic rules read data already in the app and are kept up to date by the server; ' +
      'manual badges are awarded with award_badge.',
  )

const badgeFields = {
  name: z
    .string()
    .max(40)
    .describe('Short Norwegian name shown on the badge, e.g. "ESAF-helgen ×5", "Ildsjel".'),
  description: z
    .string()
    .max(200)
    .describe(
      'One Norwegian sentence on how to earn it, shown to members: "Vært på fem ESAF-helger."',
    ),
  icon: z
    .enum(badgeIcons)
    .describe(
      'Lucide icon name (see badge_options.icons). Shown unless the badge has its own image (set_badge_image).',
    ),
  color: z
    .enum(badgeColors)
    .describe('brand = ESAF red. Use one colour per family (all ESAF-helgen tiers alike).'),
  series: z
    .string()
    .max(40)
    .nullable()
    .optional()
    .describe(
      'Tiers of the same ladder share a series (e.g. "ESAF-helgen"); profiles show only the highest tier earned.',
    ),
  sortOrder: z
    .number()
    .int()
    .min(0)
    .max(10000)
    .optional()
    .describe(
      'Lower first (default 100). Within a series, the higher tier must have the higher sortOrder.',
    ),
}

function summary(ctx: ToolContext, b: AdminBadge, stats?: BadgeStats) {
  return {
    badgeId: b.id,
    slug: b.slug,
    name: b.name,
    description: b.description,
    icon: b.icon,
    color: b.color,
    // Eget bilde, som vises i stedet for ikonet. Adressen krever innlogging.
    image: links.asset(ctx, b.image?.large),
    status: b.status,
    series: b.series,
    sortOrder: b.sortOrder,
    ruleText: b.ruleText,
    rule: b.rule,
    manual: b.manual,
    holders: { total: b.awarded, activeMembers: b.visible },
    // Sjeldenheten (andelen aktive medlemmer som har merket) og XP-en den gir. Bare publiserte.
    ...(stats && b.status === 'published' ? { rarity: stats.rarity(b.id) } : {}),
  }
}

async function details(ctx: ToolContext, badgeIdOrSlug: string, limit = 200) {
  const b = await getBadgeForAdmin(ctx.db, ctx.viewer, badgeIdOrSlug)
  return {
    ...summary(ctx, b),
    holderList: b.awards.slice(0, limit).map((a) => ({
      personId: a.personId,
      fullName: a.fullName,
      status: a.status,
      source: a.source,
      achievedOn: a.achievedOn,
      citation: a.citation,
      hiddenByPerson: a.hidden,
    })),
    moreHolders: Math.max(0, b.awards.length - limit),
  }
}

const badgeRef = z.string().max(80).describe('Badge id (UUID) or slug, from list_badges.')

async function resolveId(ctx: ToolContext, ref: string) {
  return (await getBadgeForAdmin(ctx.db, ctx.viewer, ref)).id
}

export function registerBadgeTools(server: McpServer, ctx: ToolContext) {
  defineTool(server, ctx, {
    name: 'badge_options',
    title: 'Badge options',
    description:
      'Everything needed to design badges: event types and recent events with ids (for rules), the allowed icons ' +
      'and colours, the rule kinds with what they mean, profile fields and board roles. Call this first. A badge ' +
      'can also have its own image instead of an icon: see set_badge_image.',
    input: z.object({}),
    effect: 'read',
    run: async (_args, ctx) => {
      const o = await badgeOptions(ctx.db, ctx.viewer)
      return {
        ...o,
        events: o.events.slice(0, 300),
        examples: [
          {
            name: 'ESAF-helgen ×5',
            rule: { kind: 'event_count', eventTypeId: '<ESAF-helgen id>', count: 5 },
            series: 'ESAF-helgen',
          },
          { name: 'Tre år på rad', rule: { kind: 'event_streak', eventTypeId: '<id>', years: 3 } },
          { name: 'Arrangør', rule: { kind: 'event_count', roles: ['organizer'], count: 1 } },
          { name: 'Startet selskap på ES', rule: { kind: 'company', link: 'es_company' } },
          { name: 'Exit', rule: { kind: 'company', link: 'founder', statuses: ['acquired'] } },
          { name: 'Mentor', rule: { kind: 'cohort', relations: ['mentor'] } },
          { name: 'Styremedlem', rule: { kind: 'board' } },
          { name: 'Først til 100 %', rule: { kind: 'cohort_complete', place: 1 } },
          { name: 'Fullt kull', rule: { kind: 'cohort_complete' } },
          {
            name: 'Komplett profil',
            rule: { kind: 'profile', fields: ['photo', 'bio', 'experience'] },
          },
          { name: 'Ildsjel', rule: { kind: 'manual' } },
        ],
      }
    },
  })

  defineTool(server, ctx, {
    name: 'list_badges',
    title: 'List badges',
    description:
      'All badges (published, drafts, archived) with the rule in words, the rule itself, how many have each, and for ' +
      'published ones the rarity (common/uncommon/rare/epic/legendary from the share of active members holding it) ' +
      'and the XP it gives. Members level up from XP; badges and the level are shown on profiles.',
    input: z.object({
      status: z
        .enum(['draft', 'published', 'archived'])
        .optional()
        .describe('Only badges with this status.'),
    }),
    effect: 'read',
    run: async ({ status }, ctx) => {
      const [badges, stats] = await Promise.all([
        listBadgesForAdmin(ctx.db, ctx.viewer),
        loadBadgeStats(ctx.db),
      ])
      return badges.filter((b) => !status || b.status === status).map((b) => summary(ctx, b, stats))
    },
  })

  defineTool(server, ctx, {
    name: 'get_badge',
    title: 'Get badge',
    description:
      'One badge with everyone who has it (any membership status), when they earned it, and for manual badges the ' +
      'citation and who awarded it.',
    input: z.object({
      badge: badgeRef,
      limit: z.number().int().min(1).max(1000).default(200).describe('Max holders to list.'),
    }),
    effect: 'read',
    run: ({ badge, limit }, ctx) => details(ctx, badge, limit),
  })

  defineTool(server, ctx, {
    name: 'preview_badge',
    title: 'Preview badge rule',
    description:
      'Who would get a badge with this rule, without saving anything: the rule in Norwegian, the total, how many are ' +
      'active members (shown on their profiles), and the first people with the date they qualified. Use it to ' +
      'tune thresholds before creating badges.',
    input: z.object({
      rule: badgeRuleInput,
      sample: z.number().int().min(0).max(100).default(25),
    }),
    effect: 'read',
    run: ({ rule, sample }, ctx) => previewBadgeRule(ctx.db, ctx.viewer, rule, { sample }),
  })

  defineTool(server, ctx, {
    name: 'create_badge',
    title: 'Create badge',
    description:
      'Create a badge. It is a draft (invisible to members, not awarded) unless publish=true. Show the admin the ' +
      'preview first, and publish when they agree: publishing awards it to everyone who qualifies, on their profiles. ' +
      'For a badge with its own image: create it as a draft, call set_badge_image, then publish with set_badge_status.',
    input: z.object({
      ...badgeFields,
      rule: badgeRuleInput,
      publish: z
        .boolean()
        .default(false)
        .describe('Publish and award right away. Default false (draft).'),
    }),
    effect: 'write',
    run: async ({ publish, series, ...values }, ctx) => {
      const { id } = await createBadge(
        ctx.db,
        ctx.viewer,
        { ...values, series: series ?? null },
        { publish },
      )
      return details(ctx, id, 25)
    },
  })

  defineTool(server, ctx, {
    name: 'create_badge_series',
    title: 'Create badge series (tiers)',
    description:
      'Create a ladder of tiers in one go, e.g. ESAF-helgen ×1, ×3, ×5, ×10. Each tier uses the same rule with its ' +
      'own threshold (count for event_count/company/community, years for event_streak). Tiers share the series, so ' +
      'profiles show only the highest earned; sortOrder follows the order given. Drafts unless publish=true.',
    input: z.object({
      series: z.string().max(40).describe('Series name, e.g. "ESAF-helgen".'),
      icon: badgeFields.icon,
      color: badgeFields.color,
      rule: badgeRuleInput.describe(
        'The rule shared by all tiers; the threshold is replaced per tier. Kind must be event_count, event_streak, company or community.',
      ),
      tiers: z
        .array(
          z.object({
            threshold: z.number().int().min(1).max(1000),
            name: badgeFields.name,
            description: badgeFields.description,
          }),
        )
        .min(2)
        .max(10)
        .describe('Lowest first.'),
      startSortOrder: z.number().int().min(0).max(9000).default(100),
      publish: z.boolean().default(false),
    }),
    effect: 'write',
    run: async ({ series, icon, color, rule, tiers, startSortOrder, publish }, ctx) => {
      const key =
        rule.kind === 'event_streak'
          ? 'years'
          : rule.kind === 'event_count' || rule.kind === 'company' || rule.kind === 'community'
            ? 'count'
            : null
      if (!key)
        throw new DomainError(
          'En serie må bruke event_count, event_streak, company eller community.',
        )
      const sorted = [...tiers].sort((a, b) => a.threshold - b.threshold)
      const created = []
      for (const [i, tier] of sorted.entries()) {
        const { id } = await createBadge(
          ctx.db,
          ctx.viewer,
          {
            name: tier.name,
            description: tier.description,
            icon,
            color,
            series,
            sortOrder: startSortOrder + i,
            rule: { ...rule, [key]: tier.threshold },
          },
          { publish },
        )
        const b = await getBadgeForAdmin(ctx.db, ctx.viewer, id)
        created.push(summary(ctx, b))
      }
      return created
    },
  })

  defineTool(server, ctx, {
    name: 'update_badge',
    title: 'Update badge',
    description:
      'Change a badge. Only the fields you send change; the address (slug) never changes. A new rule on a published ' +
      'badge re-awards it right away: people who no longer qualify lose it. An automatic badge cannot become manual ' +
      '(or the reverse) once someone has it; create a new one instead.',
    input: z.object({
      badge: badgeRef,
      name: badgeFields.name.optional(),
      description: badgeFields.description.optional(),
      icon: badgeFields.icon.optional(),
      color: badgeFields.color.optional(),
      series: badgeFields.series,
      sortOrder: badgeFields.sortOrder,
      rule: badgeRuleInput.optional(),
    }),
    effect: 'write',
    idempotent: true,
    run: async ({ badge, ...patch }, ctx) => {
      const badgeId = await resolveId(ctx, badge)
      await updateBadge(ctx.db, ctx.viewer, badgeId, patch)
      return details(ctx, badgeId, 25)
    },
  })

  defineTool(server, ctx, {
    name: 'set_badge_image',
    title: 'Set badge image',
    description:
      'Give a badge its own image, from a public image URL (JPEG, PNG or WebP; not SVG) or base64. It is shown instead ' +
      'of the icon, right away on a published badge. The image is cropped to a square from the centre and shown in a ' +
      'circle, so keep the subject in the middle. At least 96 × 96 pixels; 256 × 256 or more looks best. Transparent ' +
      'parts show the badge colour. Each tier of a series needs its own call. Only use artwork ESAF may use.',
    input: z.object({ badge: badgeRef, ...imageInput }),
    effect: 'write',
    run: async ({ badge, ...image }, ctx) => {
      const badgeId = await resolveId(ctx, badge)
      const file = await readImage(ctx, image, decodeBase64Image)
      await setBadgeImage(ctx.db, ctx.storage, ctx.viewer, badgeId, file)
      return details(ctx, badgeId, 25)
    },
  })

  defineTool(server, ctx, {
    name: 'remove_badge_image',
    title: 'Remove badge image',
    description: 'Remove the image from a badge, so it shows its icon again.',
    input: z.object({ badge: badgeRef }),
    effect: 'destructive',
    idempotent: true,
    run: async ({ badge }, ctx) => {
      const badgeId = await resolveId(ctx, badge)
      await removeBadgeImage(ctx.db, ctx.storage, ctx.viewer, badgeId)
      return details(ctx, badgeId, 25)
    },
  })

  defineTool(server, ctx, {
    name: 'set_badge_status',
    title: 'Publish or archive badge',
    description:
      'published: awarded and shown on profiles (automatic badges to everyone who qualifies; no notifications). ' +
      'archived: hidden from members, but who had it is kept and it can be published again. A badge never goes back ' +
      'to draft.',
    input: z.object({ badge: badgeRef, status: z.enum(['published', 'archived']) }),
    effect: 'write',
    idempotent: true,
    run: async ({ badge, status }, ctx) => {
      const badgeId = await resolveId(ctx, badge)
      await setBadgeStatus(ctx.db, ctx.viewer, badgeId, status)
      return details(ctx, badgeId, 25)
    },
  })

  defineTool(server, ctx, {
    name: 'delete_badge',
    title: 'Delete badge',
    description:
      'Delete a badge for good, with its image and everyone who has it. Prefer archiving. Confirm ' +
      'with the admin first.',
    input: z.object({ badge: badgeRef }),
    effect: 'destructive',
    run: async ({ badge }, ctx) => {
      await deleteBadge(ctx.db, ctx.storage, ctx.viewer, await resolveId(ctx, badge))
      return { deleted: true }
    },
  })

  defineTool(server, ctx, {
    name: 'award_badge',
    title: 'Award badge (manual)',
    description:
      'Award a manual badge (rule kind "manual") to people, with a short Norwegian citation members see ("For ' +
      'innsatsen med ESAF-helgen 2024"). People who already have it get the new citation (none given keeps ' +
      'theirs). It shows on their profile once the badge is published. Automatic badges cannot be awarded by hand: fix the data instead (events, board, companies).',
    input: z.object({
      badge: badgeRef,
      personIds: z.array(id('Person')).min(1).max(200),
      citation: z.string().max(200).nullable().default(null),
    }),
    effect: 'write',
    idempotent: true,
    run: async ({ badge, ...input }, ctx) =>
      awardBadge(ctx.db, ctx.viewer, await resolveId(ctx, badge), input),
  })

  defineTool(server, ctx, {
    name: 'revoke_badge',
    title: 'Revoke badge (manual)',
    description: 'Take a manual badge back from people. Logged.',
    input: z.object({ badge: badgeRef, personIds: z.array(id('Person')).min(1).max(200) }),
    effect: 'destructive',
    run: async ({ badge, personIds }, ctx) =>
      revokeBadge(ctx.db, ctx.viewer, await resolveId(ctx, badge), { personIds }),
  })

  defineTool(server, ctx, {
    name: 'sync_badges',
    title: 'Update automatic badges now',
    description:
      'Re-evaluate every published automatic badge for everyone now. The server does this every few minutes anyway; ' +
      'call it after bulk changes (event history, board, companies) to see the result right away.',
    input: z.object({}),
    effect: 'write',
    idempotent: true,
    run: async (_args, ctx) => {
      // Samme rettighet som resten av merkene; synkroniseringen selv har ingen.
      await listBadgesForAdmin(ctx.db, ctx.viewer)
      const result = await syncBadges(ctx.db)
      return { awarded: result.awarded.length, removed: result.removed, updated: result.updated }
    },
  })
}
