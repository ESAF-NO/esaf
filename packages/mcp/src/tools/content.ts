import {
  addQuote,
  confirmQuote,
  deleteComment,
  deletePost,
  deleteQuote,
  getEditableQuote,
  getPost,
  listPosts,
  postChannels,
  setPostPinned,
  setQuoteLinks,
  updateQuote,
} from '@esaf/core'
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { confidence, defineTool, id, type ToolContext } from '../context.ts'

const quoteFields = {
  text: z.string().max(2000).describe('The quote, exactly as the source has it.'),
  speakerName: z.string().max(120).describe('The name as the source writes it.'),
  speakerRole: z
    .string()
    .max(160)
    .nullable()
    .default(null)
    .describe('E.g. "Daglig leder i OptoScale".'),
  date: z.string().nullable().default(null).describe('YYYY-MM-DD, if the source has a date.'),
  sourceUrl: z.string().max(500).nullable().default(null),
  sourceLabel: z
    .string()
    .max(80)
    .nullable()
    .default(null)
    .describe('E.g. "Adresseavisen". Defaults to the domain.'),
  confidence: confidence.describe(
    'How sure it is that this person said it. low = hidden from members until confirmed in review.',
  ),
}

export function registerContentTools(server: McpServer, ctx: ToolContext) {
  // -------------------------------------------------------------------------
  // Sitater
  // -------------------------------------------------------------------------

  defineTool(server, ctx, {
    name: 'add_quote',
    title: 'Add quote',
    description:
      'Add a quote from an ES person, e.g. from an interview, linked to the person (personId) and/or company (companyId). ' +
      'Shown on the profile, the company page and as a random quote on the front page. Always give the source.',
    input: z.object({
      ...quoteFields,
      personId: z.uuid().nullable().default(null),
      companyId: z.uuid().nullable().default(null),
    }),
    effect: 'write',
    run: (args, ctx) => addQuote(ctx.db, ctx.viewer, args),
  })

  defineTool(server, ctx, {
    name: 'update_quote',
    title: 'Update quote',
    description:
      'Change a quote. Only the fields you send change; personId/companyId null removes the link.',
    input: z.object({
      quoteId: id('The quote'),
      text: z.string().max(2000).optional(),
      speakerName: z.string().max(120).optional(),
      speakerRole: z.string().max(160).nullable().optional(),
      date: z.string().nullable().optional(),
      sourceUrl: z.string().max(500).nullable().optional(),
      sourceLabel: z.string().max(80).nullable().optional(),
      confidence: confidence.optional(),
      personId: z.uuid().nullable().optional(),
      companyId: z.uuid().nullable().optional(),
    }),
    effect: 'write',
    idempotent: true,
    run: async ({ quoteId, personId, companyId, ...changes }, ctx) => {
      const { id: _id, ...current } = await getEditableQuote(ctx.db, ctx.viewer, quoteId)
      const set = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined))
      await updateQuote(ctx.db, ctx.viewer, quoteId, { ...current, ...set })
      if (personId !== undefined || companyId !== undefined) {
        await setQuoteLinks(ctx.db, ctx.viewer, quoteId, { personId, companyId })
      }
      return getEditableQuote(ctx.db, ctx.viewer, quoteId)
    },
  })

  defineTool(server, ctx, {
    name: 'confirm_quote',
    title: 'Confirm quote speaker',
    description: 'Confirm who said a low-confidence quote, so members see it.',
    input: z.object({ quoteId: id('The quote') }),
    effect: 'write',
    run: async ({ quoteId }, ctx) => {
      await confirmQuote(ctx.db, ctx.viewer, quoteId)
      return { quoteId, confirmed: true }
    },
  })

  defineTool(server, ctx, {
    name: 'delete_quote',
    title: 'Delete quote',
    description:
      'Delete a quote that is wrong or attributed to the wrong person (logged). To fix it instead, use update_quote.',
    input: z.object({ quoteId: id('The quote') }),
    effect: 'destructive',
    run: async ({ quoteId }, ctx) => {
      await deleteQuote(ctx.db, ctx.viewer, quoteId)
      return { deleted: quoteId }
    },
  })

  // -------------------------------------------------------------------------
  // Feeden (moderering)
  // -------------------------------------------------------------------------

  defineTool(server, ctx, {
    name: 'list_posts',
    title: 'List feed posts',
    description:
      'Posts in the member feed, newest or most popular first, optionally by channel, search, author or cohort.',
    input: z.object({
      channel: z.enum(postChannels).optional(),
      sort: z.enum(['new', 'top']).default('new'),
      q: z.string().max(100).optional(),
      authorPersonId: z.uuid().optional(),
      cohortYear: z.number().int().optional(),
      limit: z.number().int().min(1).max(100).default(30),
      offset: z.number().int().min(0).default(0),
    }),
    effect: 'read',
    run: async (args, ctx) =>
      (await listPosts(ctx.db, ctx.viewer, args)).map((p) => ({
        postId: p.id,
        channel: p.channel,
        title: p.title,
        url: p.url,
        excerpt: p.excerpt,
        createdAt: p.createdAt,
        author: { personId: p.author.personId, fullName: p.author.fullName },
        votes: p.votes,
        comments: p.comments,
        pinned: p.pinned,
      })),
  })

  defineTool(server, ctx, {
    name: 'get_post',
    title: 'Get feed post',
    description: 'A post with its full text (Markdown) and all comments (with commentId).',
    input: z.object({ postId: id('The post') }),
    effect: 'read',
    run: async ({ postId }, ctx) => {
      const p = await getPost(ctx.db, ctx.viewer, postId)
      return {
        postId: p.id,
        channel: p.channel,
        title: p.title,
        url: p.url,
        body: p.body,
        createdAt: p.createdAt,
        editedAt: p.editedAt,
        author: { personId: p.author.personId, fullName: p.author.fullName },
        votes: p.votes,
        pinned: p.pinned,
        comments: p.commentList.map((c) => ({
          commentId: c.id,
          body: c.body,
          createdAt: c.createdAt,
          author: { personId: c.author.personId, fullName: c.author.fullName },
        })),
      }
    },
  })

  defineTool(server, ctx, {
    name: 'remove_post',
    title: 'Remove feed post',
    description:
      "Hide someone else's post (moderation, logged). Nobody can edit others' posts, only remove them.",
    input: z.object({ postId: id('The post') }),
    effect: 'destructive',
    run: async ({ postId }, ctx) => {
      await deletePost(ctx.db, ctx.viewer, postId)
      return { removed: postId }
    },
  })

  defineTool(server, ctx, {
    name: 'remove_comment',
    title: 'Remove comment',
    description: "Hide someone else's comment (moderation, logged).",
    input: z.object({ commentId: id('The comment') }),
    effect: 'destructive',
    run: async ({ commentId }, ctx) => {
      await deleteComment(ctx.db, ctx.viewer, commentId)
      return { removed: commentId }
    },
  })

  defineTool(server, ctx, {
    name: 'set_post_pinned',
    title: 'Pin or unpin post',
    description: 'Pin a post to the top of the feed and its channel, or unpin it.',
    input: z.object({ postId: id('The post'), pinned: z.boolean() }),
    effect: 'write',
    idempotent: true,
    run: async ({ postId, pinned }, ctx) => {
      await setPostPinned(ctx.db, ctx.viewer, postId, pinned)
      return { postId, pinned }
    },
  })
}
