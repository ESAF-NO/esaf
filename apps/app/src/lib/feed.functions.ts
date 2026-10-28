import {
  addComment,
  communityOverview,
  createPost,
  deleteComment,
  deletePost,
  getPost,
  listCohorts,
  listCompanies,
  listPosts,
  toggleVote,
} from '@esaf/core'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { channelKeys } from '#/lib/channels.ts'
import { withViewer as run } from '#/server/access.server.ts'
import { db } from '#/server/db.server.ts'

export const fetchPosts = createServerFn({ method: 'GET' })
  .validator(
    z.object({
      channel: z.enum(channelKeys).optional(),
      sort: z.enum(['new', 'top']).optional(),
      q: z.string().max(100).optional(),
      authorPersonId: z.uuid().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
  )
  .handler(({ data }) => run((viewer) => listPosts(db, viewer, data)))

export const fetchPost = createServerFn({ method: 'GET' })
  .validator(z.object({ postId: z.uuid() }))
  .handler(({ data }) => run((viewer) => getPost(db, viewer, data.postId)))

export const submitPost = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      channel: z.enum(channelKeys),
      title: z.string(),
      body: z.string(),
      url: z.string(),
    }),
  )
  .handler(({ data }) => run((viewer) => createPost(db, viewer, data)))

export const removePost = createServerFn({ method: 'POST' })
  .validator(z.object({ postId: z.uuid() }))
  .handler(({ data }) => run((viewer) => deletePost(db, viewer, data.postId)))

export const submitComment = createServerFn({ method: 'POST' })
  .validator(z.object({ postId: z.uuid(), body: z.string() }))
  .handler(({ data }) => run((viewer) => addComment(db, viewer, data.postId, { body: data.body })))

export const removeComment = createServerFn({ method: 'POST' })
  .validator(z.object({ commentId: z.uuid() }))
  .handler(({ data }) => run((viewer) => deleteComment(db, viewer, data.commentId)))

export const vote = createServerFn({ method: 'POST' })
  .validator(z.object({ postId: z.uuid() }))
  .handler(({ data }) => run((viewer) => toggleVote(db, viewer, data.postId)))

export const fetchCompanies = createServerFn({ method: 'GET' }).handler(() =>
  run((viewer) => listCompanies(db, viewer)),
)

export const fetchCohorts = createServerFn({ method: 'GET' }).handler(() =>
  run((viewer) => listCohorts(db, viewer)),
)

export const fetchCommunity = createServerFn({ method: 'GET' }).handler(() =>
  run((viewer) => communityOverview(db, viewer)),
)
