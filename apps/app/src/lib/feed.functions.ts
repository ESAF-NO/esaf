import {
  addComment,
  communityOverview,
  createPost,
  deleteComment,
  deletePost,
  getEditablePost,
  getPost,
  listCohorts,
  listPosts,
  setPostPinned,
  toggleCommentReaction,
  toggleVote,
  updateComment,
  updatePost,
} from '@esaf/core'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { channelKeys } from '#/lib/channels.ts'
import { reactionKinds } from '#/lib/comments.ts'
import { withViewer as run } from '#/server/access.server.ts'
import { db } from '#/server/db.server.ts'
import { storage } from '#/server/photos.server.ts'

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

/** Vedleggene, lastet opp på forhånd (`/api/vedlegg`). Grensen sjekkes i @esaf/core. */
const attachmentIds = z.array(z.uuid()).max(50)

// Full validering av innholdet skjer i @esaf/core (postInput). Her sjekkes bare formen.
const postFields = z.object({
  channel: z.enum(channelKeys),
  title: z.string(),
  body: z.string(),
  url: z.string(),
  attachmentIds,
})

export const submitPost = createServerFn({ method: 'POST' })
  .validator(postFields)
  .handler(({ data }) => run((viewer) => createPost(db, viewer, data)))

/** Bare forfatteren får innlegget her. Andre får 404. */
export const fetchEditablePost = createServerFn({ method: 'GET' })
  .validator(z.object({ postId: z.uuid() }))
  .handler(({ data }) => run((viewer) => getEditablePost(db, viewer, data.postId)))

export const editPost = createServerFn({ method: 'POST' })
  .validator(postFields.extend({ postId: z.uuid() }))
  .handler(({ data: { postId, ...fields } }) =>
    run((viewer) => updatePost(db, viewer, postId, fields, storage)),
  )

export const removePost = createServerFn({ method: 'POST' })
  .validator(z.object({ postId: z.uuid() }))
  .handler(({ data }) => run((viewer) => deletePost(db, viewer, data.postId, storage)))

export const pinPost = createServerFn({ method: 'POST' })
  .validator(z.object({ postId: z.uuid(), pinned: z.boolean() }))
  .handler(({ data }) => run((viewer) => setPostPinned(db, viewer, data.postId, data.pinned)))

export const submitComment = createServerFn({ method: 'POST' })
  .validator(
    z.object({ postId: z.uuid(), body: z.string(), attachmentIds, replyTo: z.uuid().optional() }),
  )
  .handler(({ data: { postId, replyTo, ...input } }) =>
    run((viewer) => addComment(db, viewer, postId, input, { replyTo })),
  )

export const editComment = createServerFn({ method: 'POST' })
  .validator(z.object({ commentId: z.uuid(), body: z.string(), attachmentIds }))
  .handler(({ data: { commentId, ...input } }) =>
    run((viewer) => updateComment(db, viewer, commentId, input, storage)),
  )

export const removeComment = createServerFn({ method: 'POST' })
  .validator(z.object({ commentId: z.uuid() }))
  .handler(({ data }) => run((viewer) => deleteComment(db, viewer, data.commentId, storage)))

export const reactToComment = createServerFn({ method: 'POST' })
  .validator(z.object({ commentId: z.uuid(), kind: z.enum(reactionKinds) }))
  .handler(({ data }) =>
    run((viewer) => toggleCommentReaction(db, viewer, data.commentId, data.kind)),
  )

export const vote = createServerFn({ method: 'POST' })
  .validator(z.object({ postId: z.uuid() }))
  .handler(({ data }) => run((viewer) => toggleVote(db, viewer, data.postId)))

export const fetchCohorts = createServerFn({ method: 'GET' }).handler(() =>
  run((viewer) => listCohorts(db, viewer)),
)

export const fetchCommunity = createServerFn({ method: 'GET' }).handler(() =>
  run((viewer) => communityOverview(db, viewer)),
)
