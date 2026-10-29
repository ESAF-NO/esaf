import { randomUUID } from 'node:crypto'
import { createDb, loadRootEnv, runMigrations, schema, type Db, type MemberRole } from '@esaf/db'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccessDeniedError,
  addComment,
  createPost,
  deleteComment,
  deletePost,
  getEditablePost,
  getPost,
  grantRoleAsOperator,
  listAuditEvents,
  listPosts,
  loadViewer,
  NotFoundError,
  setPostPinned,
  updateComment,
  updatePost,
  type PostInput,
  type Viewer,
} from '../src/index.ts'

loadRootEnv()
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

describe.skipIf(!url)('redigering, Markdown og festede innlegg', () => {
  let db: Db
  let owner: Viewer
  let admin: Viewer
  let adminWithoutTwoFactor: Viewer
  let moderator: Viewer
  let ola: Viewer
  let kari: Viewer
  let pending: Viewer

  beforeAll(async () => {
    await runMigrations(url!)
    db = createDb(url!)
  })
  afterAll(() => db?.close())

  async function account(name: string, twoFactorEnabled: boolean) {
    const id = randomUUID()
    await db.insert(schema.user).values({
      id,
      name,
      email: `${name.toLowerCase()}@example.test`,
      emailVerified: true,
      twoFactorEnabled,
    })
    return id
  }

  /** Et aktivt medlem med en rolle. Admins og hovedadmins har tofaktor med mindre noe annet er sagt. */
  async function withRole(name: string, role: MemberRole, twoFactorEnabled = role !== 'member') {
    const id = await account(name, twoFactorEnabled)
    await grantRoleAsOperator(db, {
      email: `${name.toLowerCase()}@example.test`,
      reason: 'test',
      role,
    })
    return loadViewer(db, id)
  }

  beforeEach(async () => {
    await db.execute(
      sql`truncate ${schema.postVote}, ${schema.comment}, ${schema.post}, ${schema.auditEvent}, ${schema.membership}, ${schema.personCohort}, ${schema.personEmail}, ${schema.person}, ${schema.cohort}, ${schema.user} cascade`,
    )
    owner = await withRole('Eier', 'owner')
    admin = await withRole('Admin', 'admin')
    adminWithoutTwoFactor = await withRole('Admin2', 'admin', false)
    moderator = await withRole('Moderator', 'moderator')
    ola = await withRole('Ola', 'member')
    kari = await withRole('Kari', 'member')
    pending = await loadViewer(db, await account('Ventende', false))
  })

  async function denial(promise: Promise<unknown>) {
    try {
      await promise
      return 'allowed'
    } catch (error) {
      if (error instanceof AccessDeniedError) return error.reason
      if (error instanceof NotFoundError) return 'not_found'
      throw error
    }
  }

  const question: PostInput = {
    channel: 'sporsmal',
    title: 'Hvem kan B2B-salg?',
    body: 'Trenger råd om **prising**.',
    url: '',
  }

  describe('redigering', () => {
    it('bare forfatteren kan redigere innlegget sitt, heller ikke moderatorer og admins', async () => {
      const id = await createPost(db, ola, question)
      const changes: PostInput = {
        channel: 'jobb',
        title: 'Vi ansetter en selger',
        body: 'Se lenken.',
        url: 'https://example.test/jobb',
      }
      for (const [viewer, reason] of [
        [null, 'unauthenticated'],
        [pending, 'not_member'],
        [kari, 'forbidden'],
        [moderator, 'forbidden'],
        [admin, 'forbidden'],
        [owner, 'forbidden'],
      ] as const) {
        expect(await denial(updatePost(db, viewer, id, changes))).toBe(reason)
        expect(await denial(getEditablePost(db, viewer, id))).toBe(reason)
      }
      expect(await getPost(db, ola, id)).toMatchObject({ editedAt: null, title: question.title })

      expect(await getEditablePost(db, ola, id)).toEqual({
        id,
        channel: 'sporsmal',
        title: 'Hvem kan B2B-salg?',
        body: 'Trenger råd om **prising**.',
        url: null,
      })
      await updatePost(db, ola, id, changes)
      const edited = await getPost(db, kari, id)
      expect(edited).toMatchObject({ ...changes, canEdit: false, isOwn: false })
      expect(edited.editedAt).toBeInstanceOf(Date)
      expect(await getPost(db, ola, id)).toMatchObject({ canEdit: true })
      // Moderatorer kan fortsatt fjerne, men ikke redigere.
      expect(await getPost(db, moderator, id)).toMatchObject({ canEdit: false, canDelete: true })
    })

    it('merker bare innlegget som redigert når noe faktisk er endret', async () => {
      const id = await createPost(db, ola, question)
      await updatePost(db, ola, id, { ...question, title: `  ${question.title}  ` })
      expect((await getPost(db, ola, id)).editedAt).toBeNull()
      await updatePost(db, ola, id, { ...question, body: 'Trenger råd om _prising_.' })
      const view = await getPost(db, ola, id)
      expect(view.body).toBe('Trenger råd om _prising_.')
      expect(view.editedAt).toBeInstanceOf(Date)
    })

    it('validerer endringer på samme måte som nye innlegg', async () => {
      const id = await createPost(db, ola, question)
      await expect(updatePost(db, ola, id, { ...question, title: 'x' })).rejects.toThrow('minst 3')
      await expect(
        updatePost(db, ola, id, { ...question, url: 'javascript:alert(1)' }),
      ).rejects.toThrow('https')
      expect((await getPost(db, ola, id)).title).toBe(question.title)
    })

    it('bare forfatteren kan redigere kommentaren sin', async () => {
      const id = await createPost(db, ola, question)
      const commentId = await addComment(db, kari, id, { body: 'Jeg kan hjelpe!' })
      for (const [viewer, reason] of [
        [pending, 'not_member'],
        [ola, 'forbidden'],
        [moderator, 'forbidden'],
        [admin, 'forbidden'],
      ] as const) {
        expect(await denial(updateComment(db, viewer, commentId, { body: 'Skrevet om' }))).toBe(
          reason,
        )
      }
      await updateComment(db, kari, commentId, { body: 'Jeg kan hjelpe!' })
      expect((await getPost(db, ola, id)).commentList[0]?.editedAt).toBeNull()

      await expect(updateComment(db, kari, commentId, { body: '  ' })).rejects.toThrow()
      await updateComment(db, kari, commentId, { body: 'Jeg kan hjelpe, send meg en **DM**.' })
      const [ownView] = (await getPost(db, kari, id)).commentList
      expect(ownView).toMatchObject({ body: 'Jeg kan hjelpe, send meg en **DM**.', canEdit: true })
      expect(ownView?.editedAt).toBeInstanceOf(Date)
      expect((await getPost(db, ola, id)).commentList[0]).toMatchObject({
        canEdit: false,
        canDelete: false,
      })
    })

    it('slettet innhold kan ikke redigeres', async () => {
      const id = await createPost(db, ola, question)
      const kept = await addComment(db, kari, id, { body: 'Står' })
      const removed = await addComment(db, kari, id, { body: 'Borte' })
      await deleteComment(db, kari, removed)
      expect(await denial(updateComment(db, kari, removed, { body: 'Igjen' }))).toBe('not_found')

      await deletePost(db, ola, id)
      expect(await denial(updatePost(db, ola, id, question))).toBe('not_found')
      expect(await denial(getEditablePost(db, ola, id))).toBe('not_found')
      expect(await denial(updateComment(db, kari, kept, { body: 'Igjen' }))).toBe('not_found')
    })
  })

  describe('Markdown', () => {
    it('lagrer Markdown som den ble skrevet, og gir utdrag som ren tekst', async () => {
      const body = [
        'Vi har **hentet 18 MNOK**. Les mer i [pressemeldingen](https://example.test/pm).',
        '',
        '- Takk til @[Kari](0b6a3c55-8a59-4a4e-9a8a-6a0f2b1c9d10)',
        '- `kode` og <b>html</b>',
      ].join('\n')
      const id = await createPost(db, ola, { ...question, channel: 'lansering', body })
      // Omtalen peker ikke på et medlem, så serveren gjør den om til vanlig tekst.
      expect((await getPost(db, kari, id)).body).toBe(
        body.replace('@[Kari](0b6a3c55-8a59-4a4e-9a8a-6a0f2b1c9d10)', '@Kari'),
      )
      const [summary] = await listPosts(db, kari)
      expect(summary?.excerpt).toBe(
        'Vi har hentet 18 MNOK. Les mer i pressemeldingen. Takk til @Kari kode og <b>html</b>',
      )
    })
  })

  describe('festede innlegg', () => {
    it('bare moderatorer og oppover kan feste, og admins må ha tofaktor', async () => {
      const id = await createPost(db, ola, question)
      expect(await denial(setPostPinned(db, null, id, true))).toBe('unauthenticated')
      expect(await denial(setPostPinned(db, pending, id, true))).toBe('not_member')
      expect(await denial(setPostPinned(db, ola, id, true))).toBe('forbidden')
      expect(await denial(setPostPinned(db, adminWithoutTwoFactor, id, true))).toBe(
        'strong_auth_required',
      )
      expect((await getPost(db, ola, id)).canPin).toBe(false)
      expect((await getPost(db, adminWithoutTwoFactor, id)).canPin).toBe(false)
      expect((await getPost(db, moderator, id)).canPin).toBe(true)

      await setPostPinned(db, moderator, id, true)
      expect((await getPost(db, ola, id)).pinned).toBe(true)
      await setPostPinned(db, admin, id, false)
      expect((await getPost(db, ola, id)).pinned).toBe(false)
    })

    it('festing og løsning logges, og gjentatte klikk logges ikke', async () => {
      const id = await createPost(db, ola, question)
      await setPostPinned(db, moderator, id, true)
      await setPostPinned(db, moderator, id, true)
      await setPostPinned(db, admin, id, false)
      await setPostPinned(db, admin, id, false)

      const entries = (await listAuditEvents(db, owner)).filter((e) =>
        e.action.startsWith('content.'),
      )
      expect(entries).toMatchObject([
        {
          action: 'content.unpin_post',
          actor: { personId: admin!.personId },
          subject: { personId: ola!.personId },
          details: { postId: id, title: question.title },
        },
        {
          action: 'content.pin_post',
          actor: { personId: moderator!.personId },
          subject: { personId: ola!.personId },
          details: { postId: id, title: question.title },
        },
      ])
    })

    it('står øverst i «Hjem» og i kanalen sin, men ikke i søk og på profiler', async () => {
      const old = await createPost(db, ola, {
        ...question,
        channel: 'arrangement',
        title: 'ESAF-helg',
      })
      await db.execute(
        sql`update ${schema.post} set created_at = now() - interval '5 days' where id = ${old}`,
      )
      const popular = await createPost(db, kari, { ...question, title: 'Populært spørsmål' })
      for (const v of [ola, moderator, admin]) {
        await db.insert(schema.postVote).values({ postId: popular, personId: v!.personId! })
      }
      const fresh = await createPost(db, ola, { ...question, title: 'Ferskt spørsmål' })
      const ids = (posts: { id: string }[]) => posts.map((p) => p.id)

      expect(ids(await listPosts(db, kari, { sort: 'top' }))).toEqual([popular, fresh, old])
      await setPostPinned(db, moderator, old, true)

      const home = await listPosts(db, kari, { sort: 'top' })
      expect(home.map((p) => [p.id, p.pinned])).toEqual([
        [old, true],
        [popular, false],
        [fresh, false],
      ])
      expect(ids(await listPosts(db, kari, { sort: 'new' }))).toEqual([old, fresh, popular])
      expect(ids(await listPosts(db, kari, { channel: 'arrangement' }))).toEqual([old])
      expect(ids(await listPosts(db, kari, { channel: 'sporsmal', sort: 'new' }))).toEqual([
        fresh,
        popular,
      ])
      // Søk og profiler viser innleggene i vanlig rekkefølge.
      expect(ids(await listPosts(db, kari, { q: 'prising', sort: 'new' }))).toEqual([
        fresh,
        popular,
        old,
      ])
      expect(
        ids(await listPosts(db, kari, { authorPersonId: ola!.personId!, sort: 'new' })),
      ).toEqual([fresh, old])

      // Sist festet står først.
      await setPostPinned(db, moderator, fresh, true)
      expect(ids(await listPosts(db, kari, { sort: 'top' }))).toEqual([fresh, old, popular])
    })

    it('slettede innlegg kan ikke festes', async () => {
      const id = await createPost(db, ola, question)
      await deletePost(db, ola, id)
      expect(await denial(setPostPinned(db, moderator, id, true))).toBe('not_found')
    })
  })
})
