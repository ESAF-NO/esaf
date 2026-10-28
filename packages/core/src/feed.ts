import { schema, type Db, type PostChannel } from '@esaf/db'
import { and, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { assertMember, can, type Viewer } from './access.ts'
import { AccessDeniedError, DomainError, NotFoundError } from './errors.ts'
import { currentRole, loadExperience } from './experience.ts'
import { photoUrls, type ProfilePhoto } from './photos.ts'

const { auditEvent, cohort, comment, person, personCohort, post, postVote } = schema

export const postChannels = schema.postChannel.enumValues

const httpUrl = z
  .string()
  .trim()
  .max(500)
  .transform((v) => (v === '' ? null : v))
  .nullable()
  .refine((v) => v === null || /^https?:\/\/[^\s]+\.[^\s]+$/i.test(v), {
    message: 'Lenken må starte med https://',
  })

export const postInput = z.object({
  channel: z.enum(postChannels),
  title: z
    .string()
    .trim()
    .min(3, 'Tittelen må ha minst 3 tegn.')
    .max(200, 'Maks 200 tegn i tittelen.'),
  body: z.string().trim().max(10_000, 'Innlegget er for langt.'),
  url: httpUrl,
})
export type PostInput = z.input<typeof postInput>

export const commentInput = z.object({
  body: z.string().trim().min(1, 'Skriv noe først.').max(5_000, 'Kommentaren er for lang.'),
})

export type Author = {
  personId: string
  fullName: string
  photo: ProfilePhoto | null
  claimed: boolean
  jobTitle: string | null
  currentCompany: string | null
  cohortYears: number[]
}

export type PostSummary = {
  id: string
  channel: PostChannel
  title: string
  url: string | null
  excerpt: string
  createdAt: Date
  author: Author
  votes: number
  comments: number
  viewerVoted: boolean
  isOwn: boolean
}

export type CommentView = {
  id: string
  body: string
  createdAt: Date
  author: Author
  canDelete: boolean
}

export type PostView = PostSummary & {
  body: string
  editedAt: Date | null
  canDelete: boolean
  commentList: CommentView[]
}

async function loadAuthors(db: Db, personIds: string[]): Promise<Map<string, Author>> {
  if (!personIds.length) return new Map()
  const ids = [...new Set(personIds)]
  const [people, cohorts, experiences] = await Promise.all([
    db
      .select({
        personId: person.id,
        fullName: person.fullName,
        photoKey: person.photoKey,
        userId: person.userId,
      })
      .from(person)
      .where(inArray(person.id, ids)),
    db
      .select({ personId: personCohort.personId, year: cohort.graduationYear })
      .from(personCohort)
      .innerJoin(cohort, eq(cohort.id, personCohort.cohortId))
      .where(inArray(personCohort.personId, ids)),
    loadExperience(db, ids),
  ])
  return new Map(
    people.map((p) => [
      p.personId,
      {
        personId: p.personId,
        fullName: p.fullName,
        photo: photoUrls(p.photoKey),
        claimed: p.userId !== null,
        ...currentRole(experiences.get(p.personId) ?? []),
        cohortYears: cohorts
          .filter((c) => c.personId === p.personId)
          .map((c) => c.year)
          .sort(),
      },
    ]),
  )
}

// Drizzle skriver hovedtabellens kolonner uten tabellnavn. I subspørringer under
// ville `id` da bety den indre tabellens id, så referansen til innlegget kvalifiseres.
const postIdRef = sql.raw('"post"."id"')
const voteCount = sql<number>`(select count(*)::int from ${postVote} where ${postVote.postId} = ${postIdRef})`
const commentCount = sql<number>`(select count(*)::int from ${comment} where ${comment.postId} = ${postIdRef} and ${comment.deletedAt} is null)`
const voted = (personId: string) =>
  sql<boolean>`exists(select 1 from ${postVote} where ${postVote.postId} = ${postIdRef} and ${postVote.personId} = ${personId})`
/** Hacker News-aktig rangering: stemmer (og litt for kommentarer) veid mot alder. */
const hotness = sql`(${voteCount} + ${commentCount} * 0.5 + 1) / power(extract(epoch from (now() - ${sql.raw('"post"."created_at"')})) / 3600 + 2, 1.5)`

const excerptOf = (body: string) => {
  const flat = body.replace(/\s+/g, ' ').trim()
  return flat.length > 280 ? `${flat.slice(0, 277)}…` : flat
}

export type ListPostsOptions = {
  channel?: PostChannel
  sort?: 'new' | 'top'
  q?: string
  authorPersonId?: string
  limit?: number
  offset?: number
}

/** Feeden. Kun for aktive medlemmer. */
export async function listPosts(
  db: Db,
  viewer: Viewer,
  options: ListPostsOptions = {},
): Promise<PostSummary[]> {
  assertMember(viewer)
  const conditions: SQL[] = [isNull(post.deletedAt)]
  if (options.channel) conditions.push(eq(post.channel, options.channel))
  if (options.authorPersonId) conditions.push(eq(post.authorPersonId, options.authorPersonId))
  const q = options.q?.trim()
  if (q) {
    const pattern = `%${q.replace(/[%_\\]/g, '\\$&')}%`
    conditions.push(or(ilike(post.title, pattern), ilike(post.body, pattern))!)
  }

  const rows = await db
    .select({
      id: post.id,
      channel: post.channel,
      title: post.title,
      body: post.body,
      url: post.url,
      createdAt: post.createdAt,
      authorPersonId: post.authorPersonId,
      votes: voteCount,
      comments: commentCount,
      viewerVoted: voted(viewer.personId),
    })
    .from(post)
    .where(and(...conditions))
    .orderBy(options.sort === 'top' ? desc(hotness) : desc(post.createdAt))
    .limit(Math.min(options.limit ?? 30, 100))
    .offset(options.offset ?? 0)

  const authors = await loadAuthors(
    db,
    rows.map((r) => r.authorPersonId),
  )
  return rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    title: r.title,
    url: r.url,
    excerpt: excerptOf(r.body),
    createdAt: r.createdAt,
    author: authors.get(r.authorPersonId)!,
    votes: r.votes,
    comments: r.comments,
    viewerVoted: r.viewerVoted,
    isOwn: r.authorPersonId === viewer.personId,
  }))
}

export async function getPost(db: Db, viewer: Viewer, postId: string): Promise<PostView> {
  assertMember(viewer)
  const [row] = await db
    .select({
      id: post.id,
      channel: post.channel,
      title: post.title,
      body: post.body,
      url: post.url,
      createdAt: post.createdAt,
      editedAt: post.editedAt,
      authorPersonId: post.authorPersonId,
      votes: voteCount,
      comments: commentCount,
      viewerVoted: voted(viewer.personId),
    })
    .from(post)
    .where(and(eq(post.id, postId), isNull(post.deletedAt)))
  if (!row) throw new NotFoundError('Fant ikke innlegget.')

  const comments = await db
    .select()
    .from(comment)
    .where(and(eq(comment.postId, postId), isNull(comment.deletedAt)))
    .orderBy(comment.createdAt)
  const authors = await loadAuthors(db, [
    row.authorPersonId,
    ...comments.map((c) => c.authorPersonId),
  ])
  const moderator = can(viewer, 'content.moderate')
  const isOwn = row.authorPersonId === viewer.personId

  return {
    id: row.id,
    channel: row.channel,
    title: row.title,
    url: row.url,
    body: row.body,
    excerpt: excerptOf(row.body),
    createdAt: row.createdAt,
    editedAt: row.editedAt,
    author: authors.get(row.authorPersonId)!,
    votes: row.votes,
    comments: row.comments,
    viewerVoted: row.viewerVoted,
    isOwn,
    canDelete: isOwn || moderator,
    commentList: comments.map((c) => ({
      id: c.id,
      body: c.body,
      createdAt: c.createdAt,
      author: authors.get(c.authorPersonId)!,
      canDelete: c.authorPersonId === viewer.personId || moderator,
    })),
  }
}

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new DomainError(parsed.error.issues[0]?.message ?? 'Ugyldig innhold.')
  return parsed.data
}

export async function createPost(db: Db, viewer: Viewer, input: PostInput): Promise<string> {
  assertMember(viewer)
  const data = parse(postInput, input)
  const [created] = await db
    .insert(post)
    .values({ ...data, authorPersonId: viewer.personId })
    .returning({ id: post.id })
  return created!.id
}

/** Forfatteren eller en admin kan slette. Innlegget skjules, kommentarene beholdes i databasen. */
export async function deletePost(db: Db, viewer: Viewer, postId: string): Promise<void> {
  assertMember(viewer)
  const [row] = await db
    .select()
    .from(post)
    .where(and(eq(post.id, postId), isNull(post.deletedAt)))
  if (!row) throw new NotFoundError('Fant ikke innlegget.')
  const own = row.authorPersonId === viewer.personId
  if (!own && !can(viewer, 'content.moderate')) throw new AccessDeniedError('forbidden')
  await db.transaction(async (tx) => {
    await tx.update(post).set({ deletedAt: new Date() }).where(eq(post.id, postId))
    // Når noen fjerner andres innhold, skal det kunne etterprøves.
    if (!own) {
      await tx.insert(auditEvent).values({
        actorPersonId: viewer.personId,
        action: 'content.remove_post',
        subjectPersonId: row.authorPersonId,
        details: { postId, title: row.title },
      })
    }
  })
}

export async function addComment(
  db: Db,
  viewer: Viewer,
  postId: string,
  input: z.input<typeof commentInput>,
): Promise<string> {
  assertMember(viewer)
  const data = parse(commentInput, input)
  const [target] = await db
    .select({ id: post.id })
    .from(post)
    .where(and(eq(post.id, postId), isNull(post.deletedAt)))
  if (!target) throw new NotFoundError('Fant ikke innlegget.')
  const [created] = await db
    .insert(comment)
    .values({ postId, authorPersonId: viewer.personId, body: data.body })
    .returning({ id: comment.id })
  return created!.id
}

export async function deleteComment(db: Db, viewer: Viewer, commentId: string): Promise<void> {
  assertMember(viewer)
  const [row] = await db
    .select()
    .from(comment)
    .where(and(eq(comment.id, commentId), isNull(comment.deletedAt)))
  if (!row) throw new NotFoundError('Fant ikke kommentaren.')
  const own = row.authorPersonId === viewer.personId
  if (!own && !can(viewer, 'content.moderate')) throw new AccessDeniedError('forbidden')
  await db.transaction(async (tx) => {
    await tx.update(comment).set({ deletedAt: new Date() }).where(eq(comment.id, commentId))
    if (!own) {
      await tx.insert(auditEvent).values({
        actorPersonId: viewer.personId,
        action: 'content.remove_comment',
        subjectPersonId: row.authorPersonId,
        details: { postId: row.postId, commentId, excerpt: row.body.slice(0, 120) },
      })
    }
  })
}

/** Gir eller fjerner stemmen til den innloggede. */
export async function toggleVote(
  db: Db,
  viewer: Viewer,
  postId: string,
): Promise<{ voted: boolean; votes: number }> {
  assertMember(viewer)
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: post.id })
      .from(post)
      .where(and(eq(post.id, postId), isNull(post.deletedAt)))
    if (!target) throw new NotFoundError('Fant ikke innlegget.')
    const removed = await tx
      .delete(postVote)
      .where(and(eq(postVote.postId, postId), eq(postVote.personId, viewer.personId)))
      .returning()
    if (!removed.length) {
      await tx.insert(postVote).values({ postId, personId: viewer.personId }).onConflictDoNothing()
    }
    const [{ votes }] = (await tx
      .select({ votes: sql<number>`count(*)::int` })
      .from(postVote)
      .where(eq(postVote.postId, postId))) as [{ votes: number }]
    return { voted: !removed.length, votes }
  })
}
