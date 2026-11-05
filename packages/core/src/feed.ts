import { schema, type CommentReactionKind, type Db, type PostChannel } from '@esaf/db'
import { and, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { assertCan, assertMember, can, type Viewer } from './access.ts'
import {
  attachAssets,
  deleteAssetsOf,
  forgetGifs,
  groupAssets,
  loadAssets,
  MAX_ATTACHMENTS,
  purgeAssets,
  type AssetView,
  type PurgeTarget,
} from './assets.ts'
import { AccessDeniedError, DomainError, NotFoundError } from './errors.ts'
import { currentRole, loadExperience } from './experience.ts'
import { markdownToPlainText } from './markdown.ts'
import { personIdsInCohort, type Tx } from './members.ts'
import { mentionsToPlainText, resolveMentions } from './mentions.ts'
import { notifyComment, notifyMentions } from './notifications.ts'
import { photoUrls, type ProfilePhoto } from './photos.ts'
import type { ObjectStorage } from './storage.ts'

const { auditEvent, cohort, comment, commentReaction, person, personCohort, post, postVote } =
  schema

export const postChannels = schema.postChannel.enumValues

export const commentReactionKinds = schema.commentReactionKind.enumValues

const httpUrl = z
  .string()
  .trim()
  .max(500)
  .transform((v) => (v === '' ? null : v))
  .nullable()
  .refine((v) => v === null || /^https?:\/\/[^\s]+\.[^\s]+$/i.test(v), {
    message: 'Lenken må starte med https://',
  })

/**
 * Vedleggene, i rekkefølgen de skal vises: filer lastet opp med `uploadAsset`.
 * Uten feltet beholdes vedleggene som de er.
 */
const attachmentIds = z
  .array(z.uuid('Ugyldig vedlegg.'))
  .max(MAX_ATTACHMENTS, `Maks ${MAX_ATTACHMENTS} vedlegg.`)
  .optional()

/** Tittelen er ren tekst. Teksten er Markdown, se `markdown.ts`. */
export const postInput = z.object({
  channel: z.enum(postChannels),
  title: z
    .string()
    .trim()
    .min(3, 'Tittelen må ha minst 3 tegn.')
    .max(200, 'Maks 200 tegn i tittelen.'),
  body: z.string().trim().max(10_000, 'Innlegget er for langt.'),
  url: httpUrl,
  attachmentIds,
})
export type PostInput = z.input<typeof postInput>

/** En kommentar kan være bare vedlegg, for eksempel et bilde. */
export const commentInput = z
  .object({
    body: z.string().trim().max(5_000, 'Kommentaren er for lang.'),
    attachmentIds,
  })
  .refine((c) => c.body.length > 0 || (c.attachmentIds?.length ?? 0) > 0, {
    message: 'Skriv noe først.',
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
  /** Starten av teksten som ren tekst, uten Markdown. */
  excerpt: string
  createdAt: Date
  author: Author
  votes: number
  comments: number
  viewerVoted: boolean
  isOwn: boolean
  /** Festet av en moderator. Står øverst i «Hjem» og i kanalen sin. */
  pinned: boolean
  /** Hvor mange bilder og dokumenter som er lagt ved, og det første bildet (400 px). */
  attachments: { images: number; documents: number; thumbnail: string | null }
}

/** Én slags reaksjon på en kommentar. Bare de som noen har gitt, er med. */
export type ReactionView = {
  kind: CommentReactionKind
  count: number
  viewerReacted: boolean
  /** Hvem som reagerte, i rekkefølgen de gjorde det. */
  people: string[]
}

export type CommentView = {
  id: string
  /**
   * Kommentaren dette er et svar på, eller null for en vanlig kommentar. Svar har
   * ett nivå. Er den slettet, står den ikke i lista, men svarene gjør det.
   */
  parentId: string | null
  /** Markdown. */
  body: string
  createdAt: Date
  editedAt: Date | null
  author: Author
  canEdit: boolean
  canDelete: boolean
  /** Bilder og dokumenter, i rekkefølgen forfatteren valgte. */
  attachments: AssetView[]
  reactions: ReactionView[]
}

export type PostView = Omit<PostSummary, 'attachments'> & {
  /** Markdown. */
  body: string
  editedAt: Date | null
  /** Bare forfatteren kan redigere. Moderatorer kan fjerne, ikke skrive om. */
  canEdit: boolean
  canDelete: boolean
  /** Kan feste og løsne innlegget. */
  canPin: boolean
  /** Bilder og dokumenter, i rekkefølgen forfatteren valgte. */
  attachments: AssetView[]
  commentList: CommentView[]
}

/** Det forfatteren trenger for å redigere et innlegg. */
export type EditablePost = Pick<
  PostView,
  'id' | 'channel' | 'title' | 'body' | 'url' | 'attachments'
>

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
  // Omtaler blir «@Navn» først, så Markdown-tolkningen ikke ser dem som lenker.
  const flat = markdownToPlainText(mentionsToPlainText(body))
  return flat.length > 280 ? `${flat.slice(0, 277)}…` : flat
}

export type ListPostsOptions = {
  channel?: PostChannel
  sort?: 'new' | 'top'
  q?: string
  authorPersonId?: string
  /** Bare innlegg skrevet av personer i kullet med dette uteksamineringsåret. */
  cohortYear?: number
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
  if (options.cohortYear !== undefined) {
    conditions.push(inArray(post.authorPersonId, personIdsInCohort(db, options.cohortYear)))
  }
  const q = options.q?.trim()
  if (q) {
    const pattern = `%${q.replace(/[%_\\]/g, '\\$&')}%`
    conditions.push(or(ilike(post.title, pattern), ilike(post.body, pattern))!)
  }
  // Festede innlegg står øverst i feeden og kanalen sin, sist festet først. Ikke i søk,
  // på profiler eller på kullsider, der det er bestemte personers innlegg som vises.
  const pinnedFirst = !q && !options.authorPersonId && options.cohortYear === undefined

  const rows = await db
    .select({
      id: post.id,
      channel: post.channel,
      title: post.title,
      body: post.body,
      url: post.url,
      createdAt: post.createdAt,
      pinnedAt: post.pinnedAt,
      authorPersonId: post.authorPersonId,
      votes: voteCount,
      comments: commentCount,
      viewerVoted: voted(viewer.personId),
    })
    .from(post)
    .where(and(...conditions))
    .orderBy(
      ...(pinnedFirst ? [sql`${post.pinnedAt} is null`, desc(post.pinnedAt)] : []),
      options.sort === 'top' ? desc(hotness) : desc(post.createdAt),
    )
    .limit(Math.min(options.limit ?? 30, 100))
    .offset(options.offset ?? 0)

  const [authors, attachments] = await Promise.all([
    loadAuthors(
      db,
      rows.map((r) => r.authorPersonId),
    ),
    rows.length
      ? loadAssets(db, viewer, { postIds: rows.map((r) => r.id) }).then(groupAssets)
      : new Map<string, AssetView[]>(),
  ])
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
    pinned: r.pinnedAt !== null,
    attachments: attachmentSummary(attachments.get(r.id) ?? []),
  }))
}

function attachmentSummary(list: AssetView[]): PostSummary['attachments'] {
  const images = list.filter((a) => a.image)
  return {
    images: images.length,
    documents: list.length - images.length,
    thumbnail: images[0]?.image?.small ?? null,
  }
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
      pinnedAt: post.pinnedAt,
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
  const [authors, reactions] = await Promise.all([
    loadAuthors(db, [row.authorPersonId, ...comments.map((c) => c.authorPersonId)]),
    loadReactions(
      db,
      viewer,
      comments.map((c) => c.id),
    ),
  ])
  const moderator = can(viewer, 'content.moderate')
  const isOwn = row.authorPersonId === viewer.personId
  const attachments = groupAssets(
    await loadAssets(
      db,
      viewer,
      { postIds: [row.id], commentIds: comments.map((c) => c.id) },
      () => moderator,
    ),
  )

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
    pinned: row.pinnedAt !== null,
    canEdit: isOwn,
    canDelete: isOwn || moderator,
    canPin: moderator,
    attachments: attachments.get(row.id) ?? [],
    commentList: comments.map((c) => {
      const own = c.authorPersonId === viewer.personId
      return {
        id: c.id,
        parentId: c.parentCommentId,
        body: c.body,
        createdAt: c.createdAt,
        editedAt: c.editedAt,
        author: authors.get(c.authorPersonId)!,
        canEdit: own,
        canDelete: own || moderator,
        attachments: attachments.get(c.id) ?? [],
        reactions: reactions.get(c.id) ?? [],
      }
    }),
  }
}

/** Reaksjonene per kommentar, i rekkefølgen de finnes i `commentReactionKinds`. */
async function loadReactions(
  db: Db | Tx,
  viewer: { personId: string },
  commentIds: string[],
): Promise<Map<string, ReactionView[]>> {
  if (!commentIds.length) return new Map()
  const rows = await db
    .select({
      commentId: commentReaction.commentId,
      kind: commentReaction.kind,
      personId: commentReaction.personId,
      fullName: person.fullName,
    })
    .from(commentReaction)
    .innerJoin(person, eq(person.id, commentReaction.personId))
    .where(inArray(commentReaction.commentId, commentIds))
    .orderBy(commentReaction.createdAt)
  const byComment = new Map<string, ReactionView[]>()
  for (const r of rows) {
    const list = byComment.get(r.commentId) ?? []
    byComment.set(r.commentId, list)
    let entry = list.find((e) => e.kind === r.kind)
    if (!entry) {
      entry = { kind: r.kind, count: 0, viewerReacted: false, people: [] }
      list.push(entry)
    }
    entry.count++
    entry.people.push(r.fullName)
    if (r.personId === viewer.personId) entry.viewerReacted = true
  }
  for (const list of byComment.values()) {
    list.sort((a, b) => commentReactionKinds.indexOf(a.kind) - commentReactionKinds.indexOf(b.kind))
  }
  return byComment
}

/**
 * Bare forfatteren kan endre det de har skrevet. Moderatorer kan fjerne andres
 * innhold, men aldri skrive det om, så det som står i noens navn er deres egne ord.
 */
function assertAuthor(viewer: { personId: string }, authorPersonId: string) {
  if (authorPersonId !== viewer.personId) throw new AccessDeniedError('forbidden')
}

/** Innlegget slik det ble skrevet, til forfatterens redigeringsskjema. */
export async function getEditablePost(
  db: Db,
  viewer: Viewer,
  postId: string,
): Promise<EditablePost> {
  assertMember(viewer)
  const [row] = await db
    .select({
      id: post.id,
      channel: post.channel,
      title: post.title,
      body: post.body,
      url: post.url,
      authorPersonId: post.authorPersonId,
    })
    .from(post)
    .where(and(eq(post.id, postId), isNull(post.deletedAt)))
  if (!row) throw new NotFoundError('Fant ikke innlegget.')
  assertAuthor(viewer, row.authorPersonId)
  const { authorPersonId: _author, ...editable } = row
  const attachments = await loadAssets(db, viewer, { postIds: [row.id] })
  return { ...editable, attachments: groupAssets(attachments).get(row.id) ?? [] }
}

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new DomainError(parsed.error.issues[0]?.message ?? 'Ugyldig innhold.')
  return parsed.data
}

export async function createPost(db: Db, viewer: Viewer, input: PostInput): Promise<string> {
  assertMember(viewer)
  const { attachmentIds, ...data } = parse(postInput, input)
  return db.transaction(async (tx) => {
    const { text: body, personIds } = await resolveMentions(tx, data.body)
    const [created] = await tx
      .insert(post)
      .values({ ...data, body, authorPersonId: viewer.personId })
      .returning({ id: post.id })
    if (attachmentIds?.length) {
      await attachAssets(tx, viewer, { postId: created!.id }, attachmentIds)
    }
    await notifyMentions(tx, {
      postId: created!.id,
      actorPersonId: viewer.personId,
      mentioned: personIds,
    })
    return created!.id
  })
}

/**
 * Forfatteren endrer kanal, tittel, tekst, lenke eller vedlegg. «Redigert» settes
 * bare når noe faktisk er endret, så et lagre-klikk uten endringer ikke merker
 * innlegget. Med `storage` fjernes filene til vedlegg som er tatt bort, med en
 * gang; ellers gjør oppryddingen det (`cleanupAssets`).
 */
export async function updatePost(
  db: Db,
  viewer: Viewer,
  postId: string,
  input: PostInput,
  storage?: ObjectStorage,
): Promise<void> {
  assertMember(viewer)
  const [row] = await db
    .select({
      authorPersonId: post.authorPersonId,
      channel: post.channel,
      title: post.title,
      body: post.body,
      url: post.url,
    })
    .from(post)
    .where(and(eq(post.id, postId), isNull(post.deletedAt)))
  if (!row) throw new NotFoundError('Fant ikke innlegget.')
  assertAuthor(viewer, row.authorPersonId)
  const { attachmentIds, ...parsed } = parse(postInput, input)
  const removed = await db.transaction(async (tx) => {
    // Omtaler skrives om som ved nytt innlegg; bare nylig nevnte får varsel.
    const { text: body, personIds } = await resolveMentions(tx, parsed.body)
    const data = { ...parsed, body }
    const fields = Object.keys(data) as (keyof typeof data)[]
    const attached =
      attachmentIds === undefined
        ? { changed: false, removed: [] }
        : await attachAssets(tx, viewer, { postId }, attachmentIds)
    if (!attached.changed && fields.every((key) => data[key] === row[key])) return []
    await tx
      .update(post)
      .set({ ...data, editedAt: new Date() })
      .where(and(eq(post.id, postId), isNull(post.deletedAt)))
    await notifyMentions(tx, { postId, actorPersonId: viewer.personId, mentioned: personIds })
    return attached.removed
  })
  if (storage) await purgeAssets(db, storage, removed)
}

/**
 * Forfatteren eller en moderator kan slette. Innlegget skjules, kommentarene
 * beholdes i databasen. Vedleggene i innlegget og kommentarene slettes; med
 * `storage` fjernes filene med en gang, ellers av oppryddingen.
 */
export async function deletePost(
  db: Db,
  viewer: Viewer,
  postId: string,
  storage?: ObjectStorage,
): Promise<void> {
  assertMember(viewer)
  const [row] = await db
    .select()
    .from(post)
    .where(and(eq(post.id, postId), isNull(post.deletedAt)))
  if (!row) throw new NotFoundError('Fant ikke innlegget.')
  const own = row.authorPersonId === viewer.personId
  if (!own && !can(viewer, 'content.moderate')) throw new AccessDeniedError('forbidden')
  const removed = await db.transaction(async (tx) => {
    await tx.update(post).set({ deletedAt: new Date() }).where(eq(post.id, postId))
    const comments = await tx
      .select({ id: comment.id })
      .from(comment)
      .where(eq(comment.postId, postId))
    const files = await deleteAssetsOf(tx, {
      postIds: [postId],
      commentIds: comments.map((c) => c.id),
    })
    // Når noen fjerner andres innhold, skal det kunne etterprøves.
    if (!own) {
      await forgetGifs(
        tx,
        files.map((f) => f.id),
      )
      await tx.insert(auditEvent).values({
        actorPersonId: viewer.personId,
        action: 'content.remove_post',
        subjectPersonId: row.authorPersonId,
        details: { postId, title: row.title, attachments: files.length },
      })
    }
    return files
  })
  if (storage) await purgeAssets(db, storage, removed)
}

/**
 * Ny kommentar. Med `replyTo` er det et svar på den kommentaren. Svar har ett nivå:
 * et svar på et svar havner i samme tråd, og begge forfatterne får beskjed.
 */
export async function addComment(
  db: Db,
  viewer: Viewer,
  postId: string,
  input: z.input<typeof commentInput>,
  { replyTo }: { replyTo?: string } = {},
): Promise<string> {
  assertMember(viewer)
  const { attachmentIds, ...data } = parse(commentInput, input)
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: post.id })
      .from(post)
      .where(and(eq(post.id, postId), isNull(post.deletedAt)))
    if (!target) throw new NotFoundError('Fant ikke innlegget.')
    const thread = replyTo ? await replyTarget(tx, postId, replyTo) : null
    const { text: body, personIds } = await resolveMentions(tx, data.body)
    const [created] = await tx
      .insert(comment)
      .values({
        postId,
        authorPersonId: viewer.personId,
        body,
        parentCommentId: thread?.rootId ?? null,
      })
      .returning({ id: comment.id })
    if (attachmentIds?.length) {
      await attachAssets(tx, viewer, { commentId: created!.id }, attachmentIds)
    }
    await notifyComment(tx, {
      postId,
      commentId: created!.id,
      actorPersonId: viewer.personId,
      mentioned: personIds,
      repliedTo: thread?.authors ?? [],
    })
    return created!.id
  })
}

/**
 * Tråden et svar havner i, og hvem som skal ha beskjed: forfatteren av kommentaren
 * det svares på, og av den øverste i tråden. Låses, så kommentaren ikke slettes
 * mens svaret lagres. Den øverste kan være slettet; da fortsetter tråden under
 * «Kommentaren er slettet», men den forfatteren får ingen beskjed.
 */
async function replyTarget(tx: Tx, postId: string, commentId: string) {
  const [parent] = await tx
    .select({
      id: comment.id,
      authorPersonId: comment.authorPersonId,
      parentCommentId: comment.parentCommentId,
    })
    .from(comment)
    .where(and(eq(comment.id, commentId), eq(comment.postId, postId), isNull(comment.deletedAt)))
    .for('share')
  if (!parent) throw new NotFoundError('Kommentaren du svarer på, er slettet.')
  if (!parent.parentCommentId) {
    return { rootId: parent.id, authors: [parent.authorPersonId] }
  }
  const [root] = await tx
    .select({ authorPersonId: comment.authorPersonId })
    .from(comment)
    .where(and(eq(comment.id, parent.parentCommentId), isNull(comment.deletedAt)))
  return {
    rootId: parent.parentCommentId,
    authors: [parent.authorPersonId, ...(root ? [root.authorPersonId] : [])],
  }
}

/** Som `deletePost`, for én kommentar og vedleggene i den. */
export async function deleteComment(
  db: Db,
  viewer: Viewer,
  commentId: string,
  storage?: ObjectStorage,
): Promise<void> {
  assertMember(viewer)
  const [row] = await db
    .select()
    .from(comment)
    .where(and(eq(comment.id, commentId), isNull(comment.deletedAt)))
  if (!row) throw new NotFoundError('Fant ikke kommentaren.')
  const own = row.authorPersonId === viewer.personId
  if (!own && !can(viewer, 'content.moderate')) throw new AccessDeniedError('forbidden')
  const removed = await db.transaction(async (tx) => {
    await tx.update(comment).set({ deletedAt: new Date() }).where(eq(comment.id, commentId))
    const files = await deleteAssetsOf(tx, { commentIds: [commentId] })
    if (!own) {
      await forgetGifs(
        tx,
        files.map((f) => f.id),
      )
      await tx.insert(auditEvent).values({
        actorPersonId: viewer.personId,
        action: 'content.remove_comment',
        subjectPersonId: row.authorPersonId,
        details: {
          postId: row.postId,
          commentId,
          excerpt: row.body.slice(0, 120),
          attachments: files.length,
        },
      })
    }
    return files
  })
  if (storage) await purgeAssets(db, storage, removed)
}

/** Forfatteren endrer teksten eller vedleggene i kommentaren sin. */
export async function updateComment(
  db: Db,
  viewer: Viewer,
  commentId: string,
  input: z.input<typeof commentInput>,
  storage?: ObjectStorage,
): Promise<void> {
  assertMember(viewer)
  const [row] = await db
    .select({ authorPersonId: comment.authorPersonId, body: comment.body, postId: comment.postId })
    .from(comment)
    .innerJoin(post, eq(post.id, comment.postId))
    .where(and(eq(comment.id, commentId), isNull(comment.deletedAt), isNull(post.deletedAt)))
  if (!row) throw new NotFoundError('Fant ikke kommentaren.')
  assertAuthor(viewer, row.authorPersonId)
  const { attachmentIds, ...data } = parse(commentInput, input)
  const removed: PurgeTarget[] = await db.transaction(async (tx) => {
    const { text: body, personIds } = await resolveMentions(tx, data.body)
    const attached =
      attachmentIds === undefined
        ? { changed: false, removed: [] }
        : await attachAssets(tx, viewer, { commentId }, attachmentIds)
    if (body === row.body && !attached.changed) return []
    await tx
      .update(comment)
      .set({ body, editedAt: new Date() })
      .where(and(eq(comment.id, commentId), isNull(comment.deletedAt)))
    // Ikke `notifyComment`: en redigering er ingen ny kommentar for dem som følger tråden.
    await notifyMentions(tx, {
      postId: row.postId,
      commentId,
      actorPersonId: viewer.personId,
      mentioned: personIds,
    })
    return attached.removed
  })
  if (storage) await purgeAssets(db, storage, removed)
}

/**
 * Fester eller løsner et innlegg. Festede innlegg står øverst i «Hjem» og i
 * kanalen sin. Bare for moderatorer og oppover, og hver endring logges.
 */
export async function setPostPinned(
  db: Db,
  viewer: Viewer,
  postId: string,
  pinned: boolean,
): Promise<void> {
  assertCan(viewer, 'content.moderate')
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ authorPersonId: post.authorPersonId, title: post.title, pinnedAt: post.pinnedAt })
      .from(post)
      .where(and(eq(post.id, postId), isNull(post.deletedAt)))
      .for('update')
    if (!row) throw new NotFoundError('Fant ikke innlegget.')
    // Allerede slik (f.eks. etter et dobbeltklikk): ingen endring, ingenting å logge.
    if ((row.pinnedAt !== null) === pinned) return
    await tx
      .update(post)
      .set({ pinnedAt: pinned ? new Date() : null })
      .where(eq(post.id, postId))
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: pinned ? 'content.pin_post' : 'content.unpin_post',
      subjectPersonId: row.authorPersonId,
      details: { postId, title: row.title },
    })
  })
}

/**
 * Gir eller fjerner en reaksjon fra den innloggede, og gir reaksjonene på
 * kommentaren slik de står nå. Reaksjoner gir ingen varsler: de er for små til det.
 */
export async function toggleCommentReaction(
  db: Db,
  viewer: Viewer,
  commentId: string,
  kind: CommentReactionKind,
): Promise<ReactionView[]> {
  assertMember(viewer)
  const parsed = parse(z.enum(commentReactionKinds, 'Ugyldig reaksjon.'), kind)
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: comment.id })
      .from(comment)
      .innerJoin(post, eq(post.id, comment.postId))
      .where(and(eq(comment.id, commentId), isNull(comment.deletedAt), isNull(post.deletedAt)))
    if (!target) throw new NotFoundError('Fant ikke kommentaren.')
    const mine = and(
      eq(commentReaction.commentId, commentId),
      eq(commentReaction.personId, viewer.personId),
      eq(commentReaction.kind, parsed),
    )
    const removed = await tx.delete(commentReaction).where(mine).returning()
    if (!removed.length) {
      await tx
        .insert(commentReaction)
        .values({ commentId, personId: viewer.personId, kind: parsed })
        .onConflictDoNothing()
    }
    return (await loadReactions(tx, viewer, [commentId])).get(commentId) ?? []
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
