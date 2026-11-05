import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { createDb, loadRootEnv, runMigrations, schema, type Db } from '@esaf/db'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  addComment,
  createDiskStorage,
  createPost,
  deleteComment,
  deletePost,
  formatMention,
  getPost,
  grantRoleAsOperator,
  listNotifications,
  listPosts,
  loadViewer,
  MAX_REACTIONS_PER_COMMENT,
  mergePeople,
  NotFoundError,
  previewPeopleMerge,
  toggleCommentReaction,
  type Viewer,
} from '../src/index.ts'

loadRootEnv()
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

describe.skipIf(!url)('svar og reaksjoner på kommentarer', () => {
  let db: Db
  let ola: Viewer
  let kari: Viewer
  let per: Viewer
  let lise: Viewer
  let moderator: Viewer
  let pending: Viewer
  let postId: string

  beforeAll(async () => {
    await runMigrations(url!)
    db = createDb(url!)
  })
  afterAll(() => db?.close())

  async function member(name: string, role: 'member' | 'moderator' = 'member') {
    const id = randomUUID()
    const email = `${name.toLowerCase()}@example.test`
    await db.insert(schema.user).values({ id, name, email, emailVerified: true })
    await grantRoleAsOperator(db, { email, reason: 'test', role })
    return loadViewer(db, id)
  }

  beforeEach(async () => {
    await db.execute(
      sql`truncate ${schema.notification}, ${schema.commentReaction}, ${schema.comment}, ${schema.post}, ${schema.auditEvent}, ${schema.membership}, ${schema.personCohort}, ${schema.personEmail}, ${schema.person}, ${schema.cohort}, ${schema.user} cascade`,
    )
    ola = await member('Ola')
    kari = await member('Kari')
    per = await member('Per')
    lise = await member('Lise')
    moderator = await member('Moderator', 'moderator')
    const id = randomUUID()
    await db
      .insert(schema.user)
      .values({ id, name: 'Ny', email: 'ny@example.test', emailVerified: true })
    pending = await loadViewer(db, id)
    postId = await createPost(db, ola, {
      channel: 'sporsmal',
      title: 'Hvem kan B2B-salg?',
      body: '',
      url: '',
    })
  })

  const say = (viewer: Viewer, body: string, replyTo?: string, on = postId) =>
    addComment(db, viewer, on, { body }, { replyTo })

  const typesFor = async (viewer: Viewer) =>
    (await listNotifications(db, viewer)).items.map((n) => n.type)

  describe('tråder', () => {
    it('et svar peker på kommentaren og teller med i antallet', async () => {
      const root = await say(kari, 'Hei')
      const reply = await say(per, 'Hei selv', root)
      const post = await getPost(db, ola, postId)
      expect(post.commentList.map((c) => [c.id, c.parentId])).toEqual([
        [root, null],
        [reply, root],
      ])
      expect(post.comments).toBe(2)
      expect((await listPosts(db, ola))[0]!.comments).toBe(2)
    })

    it('svar på et svar havner i samme tråd', async () => {
      const root = await say(kari, 'Hei')
      const first = await say(per, 'Hei selv', root)
      const second = await say(lise, 'Og hei', first)
      const post = await getPost(db, ola, postId)
      expect(post.commentList.find((c) => c.id === second)!.parentId).toBe(root)
    })

    it('kan ikke svare på en kommentar i et annet innlegg', async () => {
      const other = await createPost(db, kari, {
        channel: 'sporsmal',
        title: 'Noe annet',
        body: '',
        url: '',
      })
      const elsewhere = await say(kari, 'Der borte', undefined, other)
      await expect(say(per, 'Her', elsewhere)).rejects.toBeInstanceOf(NotFoundError)
    })

    it('kan ikke svare på en slettet kommentar, men tråden lever videre', async () => {
      const root = await say(kari, 'Hei')
      const reply = await say(per, 'Hei selv', root)
      await deleteComment(db, kari, root)
      await expect(say(lise, 'For sent', root)).rejects.toBeInstanceOf(NotFoundError)

      const late = await say(lise, 'Svar på svaret', reply)
      const list = (await getPost(db, ola, postId)).commentList
      expect(list.map((c) => c.id)).toEqual([reply, late])
      expect(list.every((c) => c.parentId === root)).toBe(true)
    })

    it('uten medlemskap kan ingen svare', async () => {
      const root = await say(kari, 'Hei')
      await expect(say(pending, 'Slipp meg inn', root)).rejects.toThrow()
    })

    it('svar blir stående om kommentaren forsvinner helt', async () => {
      const root = await say(kari, 'Hei')
      const reply = await say(per, 'Hei selv', root)
      await db.delete(schema.comment).where(eq(schema.comment.id, root))
      const [row] = await db.select().from(schema.comment).where(eq(schema.comment.id, reply))
      expect(row!.parentCommentId).toBeNull()
    })
  })

  describe('varsler', () => {
    it('den det svares på, får et svarvarsel, innleggets forfatter sitt vanlige', async () => {
      const root = await say(kari, 'Hei')
      await say(per, 'Hei selv', root)
      expect((await typesFor(kari))[0]).toBe('comment_reply')
      expect((await typesFor(ola))[0]).toBe('comment_on_post')
    })

    it('forfatteren av innlegget får svarvarsel når det er deres kommentar', async () => {
      const root = await say(ola, 'Tilleggsinfo')
      await say(per, 'Takk', root)
      expect(await typesFor(ola)).toEqual(['comment_reply'])
    })

    it('svar på et svar varsler begge forfatterne, én gang hver', async () => {
      const root = await say(kari, 'Hei')
      const first = await say(per, 'Hei selv', root)
      await say(lise, 'Og hei', first)
      expect(await typesFor(per)).toEqual(['comment_reply'])
      expect(await typesFor(kari)).toEqual(['comment_reply', 'comment_reply'])
    })

    it('omtale går foran svar, og ingen varsles om sitt eget svar', async () => {
      const root = await say(kari, 'Hei')
      await say(kari, 'Svarer meg selv', root)
      expect(await typesFor(kari)).toEqual([])

      const [row] = await db
        .select({ name: schema.person.fullName })
        .from(schema.person)
        .where(eq(schema.person.id, kari!.personId!))
      const mention = formatMention({ personId: kari!.personId!, name: row!.name })
      await say(per, `${mention} se her`, root)
      expect(await typesFor(kari)).toEqual(['mention'])
    })

    it('den som har slettet kommentaren øverst, får ikke varsel om nye svar', async () => {
      const root = await say(kari, 'Hei')
      const reply = await say(per, 'Hei selv', root)
      await deleteComment(db, kari, root)
      const before = await db.$count(
        schema.notification,
        and(
          eq(schema.notification.recipientPersonId, kari!.personId!),
          eq(schema.notification.type, 'comment_reply'),
        ),
      )
      await say(lise, 'Og hei', reply)
      const after = await db.$count(
        schema.notification,
        and(
          eq(schema.notification.recipientPersonId, kari!.personId!),
          eq(schema.notification.type, 'comment_reply'),
        ),
      )
      expect(after).toBe(before)
    })
  })

  describe('reaksjoner', () => {
    it('gis og tas bort, med tall, navn og hva den innloggede har gitt', async () => {
      const id = await say(kari, 'Hei')
      await toggleCommentReaction(db, ola, id, '❤️')
      await toggleCommentReaction(db, per, id, '❤️')
      const after = await toggleCommentReaction(db, ola, id, '👍')
      expect(after).toMatchObject([
        { emoji: '❤️', count: 2, viewerReacted: true },
        { emoji: '👍', count: 1, viewerReacted: true },
      ])
      expect(after[0]!.people).toHaveLength(2)

      const seenByKari = (await getPost(db, kari, postId)).commentList[0]!.reactions
      expect(seenByKari.map((r) => r.viewerReacted)).toEqual([false, false])

      expect(await toggleCommentReaction(db, ola, id, '👍')).toMatchObject([{ emoji: '❤️' }])
    })

    it('gir ingen varsler', async () => {
      const id = await say(kari, 'Hei')
      await toggleCommentReaction(db, per, id, '🎉')
      expect(await typesFor(kari)).toEqual([])
    })

    it('tåler to like trykk samtidig', async () => {
      const id = await say(kari, 'Hei')
      await Promise.allSettled([
        toggleCommentReaction(db, per, id, '👍'),
        toggleCommentReaction(db, per, id, '👍'),
      ])
      const count = await db.$count(
        schema.commentReaction,
        eq(schema.commentReaction.commentId, id),
      )
      expect(count).toBeLessThanOrEqual(1)
    })

    it('kan ikke gis på slettede kommentarer eller innlegg, eller av andre enn medlemmer', async () => {
      const id = await say(kari, 'Hei')
      const gone = await say(kari, 'Borte')
      await deleteComment(db, moderator, gone)
      await expect(toggleCommentReaction(db, per, gone, '👍')).rejects.toBeInstanceOf(NotFoundError)
      await expect(toggleCommentReaction(db, pending, id, '👍')).rejects.toThrow()
      await deletePost(db, ola, postId)
      await expect(toggleCommentReaction(db, per, id, '👍')).rejects.toBeInstanceOf(NotFoundError)
    })

    it('følger med når to personer slås sammen, uten å telle dobbelt', async () => {
      const email = 'admin@example.test'
      const id = randomUUID()
      await db
        .insert(schema.user)
        .values({ id, name: 'Admin', email, emailVerified: true, twoFactorEnabled: true })
      await grantRoleAsOperator(db, { email, reason: 'test', role: 'admin' })
      const admin = await loadViewer(db, id)
      const [profile] = await db
        .insert(schema.person)
        .values({ fullName: 'Per Duplikat' })
        .returning({ id: schema.person.id })

      const both = await say(kari, 'Begge reagerte')
      const onlyProfile = await say(kari, 'Bare profilen reagerte')
      await toggleCommentReaction(db, per, both, '👍')
      await db.insert(schema.commentReaction).values([
        { commentId: both, personId: profile!.id, emoji: '👍' },
        { commentId: onlyProfile, personId: profile!.id, emoji: '❤️' },
      ])

      const preview = await previewPeopleMerge(db, admin, {
        sourceId: profile!.id,
        targetId: per!.personId!,
      })
      expect(preview.transfers.find((t) => t.label === 'Reaksjoner')?.count).toBe(2)
      await mergePeople(db, createDiskStorage(tmpdir()), admin, {
        sourceId: profile!.id,
        targetId: per!.personId!,
        previewToken: preview.token,
      })

      const list = (await getPost(db, per, postId)).commentList
      expect(list.map((c) => c.reactions.map((r) => [r.emoji, r.count, r.viewerReacted]))).toEqual([
        [['👍', 1, true]],
        [['❤️', 1, true]],
      ])
    })

    it('tar alle emoji, med hudfarge, flagg og sammensatte', async () => {
      const id = await say(kari, 'Hei')
      for (const emoji of ['🦄', '👍🏽', '🇳🇴', '👩‍💻', '1️⃣']) {
        await toggleCommentReaction(db, per, id, emoji)
      }
      const list = await toggleCommentReaction(db, ola, id, '🦄')
      expect(list.map((r) => [r.emoji, r.count])).toEqual([
        ['🦄', 2],
        ['👍🏽', 1],
        ['🇳🇴', 1],
        ['👩‍💻', 1],
        ['1️⃣', 1],
      ])
    })

    it('husker hva hver person bruker mest, med den sist brukte først ved likt antall', async () => {
      const [a, b, c] = [await say(kari, 'A'), await say(kari, 'B'), await say(kari, 'C')]
      expect((await getPost(db, per, postId)).favoriteReactions).toEqual([])

      await toggleCommentReaction(db, per, a, '🦄')
      await toggleCommentReaction(db, per, a, '🚀')
      await toggleCommentReaction(db, per, a, '🔥')
      await toggleCommentReaction(db, per, b, '🔥')
      await toggleCommentReaction(db, per, c, '🔥')
      await toggleCommentReaction(db, per, b, '🦄')
      await toggleCommentReaction(db, ola, a, '🌮')

      expect((await getPost(db, per, postId)).favoriteReactions).toEqual(['🔥', '🦄', '🚀'])
      expect((await getPost(db, ola, postId)).favoriteReactions).toEqual(['🌮'])
    })

    it('gir aldri flere favoritter enn det er snarveier', async () => {
      const id = await say(kari, 'Hei')
      for (const e of [...'😀😁😂😃😄😅😆']) await toggleCommentReaction(db, per, id, e)
      expect((await getPost(db, per, postId)).favoriteReactions).toHaveLength(5)
    })

    it('avviser alt som ikke er akkurat én emoji', async () => {
      const id = await say(kari, 'Hei')
      for (const value of ['', 'hemmelig', 'a', '1', '👍👍', '👍 ', '❤', '<b>']) {
        await expect(toggleCommentReaction(db, per, id, value)).rejects.toThrow('Ugyldig reaksjon')
      }
    })

    it('tar ikke flere ulike emoji enn taket, men lar folk bli med på dem som er der', async () => {
      const id = await say(kari, 'Hei')
      const emoji = [...'😀😁😂😃😄😅😆😇😈😉😊😋😌😍😎😏😐😑😒😓']
      expect(emoji).toHaveLength(MAX_REACTIONS_PER_COMMENT)
      for (const e of emoji) await toggleCommentReaction(db, per, id, e)

      await expect(toggleCommentReaction(db, ola, id, '🦄')).rejects.toThrow('nok ulike reaksjoner')
      const list = await toggleCommentReaction(db, ola, id, '😀')
      expect(list[0]).toMatchObject({ emoji: '😀', count: 2 })
    })
  })
})
