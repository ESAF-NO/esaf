import { randomUUID } from 'node:crypto'
import { createDb, loadRootEnv, runMigrations, schema, type Db } from '@esaf/db'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccessDeniedError,
  addComment,
  createPost,
  decideMembership,
  deleteComment,
  deletePost,
  getPost,
  grantRoleAsOperator,
  listCompanies,
  listPosts,
  loadViewer,
  toggleVote,
  updateProfile,
  type Viewer,
} from '../src/index.ts'

loadRootEnv()
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

describe.skipIf(!url)('feed', () => {
  let db: Db
  let admin: Viewer
  let ola: Viewer
  let kari: Viewer
  let pending: Viewer

  beforeAll(async () => {
    await runMigrations(url!)
    db = createDb(url!)
  })
  afterAll(() => db?.close())

  async function account(name: string) {
    const id = randomUUID()
    await db
      .insert(schema.user)
      .values({ id, name, email: `${name.toLowerCase()}@example.test`, emailVerified: true })
    return id
  }

  beforeEach(async () => {
    await db.execute(
      sql`truncate ${schema.postVote}, ${schema.comment}, ${schema.post}, ${schema.auditEvent}, ${schema.membership}, ${schema.personCohort}, ${schema.personEmail}, ${schema.person}, ${schema.cohort}, ${schema.user} cascade`,
    )
    const adminId = await account('Admin')
    await grantRoleAsOperator(db, { email: 'admin@example.test', reason: 'test', role: 'admin' })
    await db
      .update(schema.user)
      .set({ twoFactorEnabled: true })
      .where(eq(schema.user.email, 'admin@example.test'))
    admin = await loadViewer(db, adminId)
    const olaId = await account('Ola')
    const kariId = await account('Kari')
    for (const id of [olaId, kariId]) {
      const v = await loadViewer(db, id)
      await decideMembership(db, admin, { personId: v!.personId!, decision: 'approve' })
    }
    ola = await loadViewer(db, olaId)
    kari = await loadViewer(db, kariId)
    pending = await loadViewer(db, await account('Ventende'))
  })

  async function denial(promise: Promise<unknown>) {
    try {
      await promise
      return 'allowed'
    } catch (error) {
      if (error instanceof AccessDeniedError) return error.reason
      throw error
    }
  }

  const question = {
    channel: 'sporsmal' as const,
    title: 'Hvem kan B2B-salg?',
    body: 'Trenger råd',
    url: '',
  }

  it('bare aktive medlemmer kan lese og skrive', async () => {
    expect(await denial(listPosts(db, null))).toBe('unauthenticated')
    expect(await denial(listPosts(db, pending))).toBe('not_member')
    expect(await denial(createPost(db, pending, question))).toBe('not_member')
    const id = await createPost(db, ola, question)
    expect(await denial(getPost(db, pending, id))).toBe('not_member')
    expect(await denial(toggleVote(db, pending, id))).toBe('not_member')
    expect(await denial(addComment(db, pending, id, { body: 'hei' }))).toBe('not_member')
  })

  it('innlegg, kommentarer og stemmer', async () => {
    const id = await createPost(db, ola, question)
    await addComment(db, kari, id, { body: 'Jeg kan hjelpe!' })
    expect(await toggleVote(db, kari, id)).toEqual({ voted: true, votes: 1 })
    expect(await toggleVote(db, admin, id)).toEqual({ voted: true, votes: 2 })
    expect(await toggleVote(db, kari, id)).toEqual({ voted: false, votes: 1 })

    const [summary] = await listPosts(db, kari)
    expect(summary).toMatchObject({
      title: 'Hvem kan B2B-salg?',
      votes: 1,
      comments: 1,
      viewerVoted: false,
      isOwn: false,
    })
    const view = await getPost(db, ola, id)
    expect(view.commentList.map((c) => [c.author.fullName, c.body])).toEqual([
      ['Kari', 'Jeg kan hjelpe!'],
    ])
    expect(view).toMatchObject({ isOwn: true, canDelete: true })
    expect((await getPost(db, kari, id)).canDelete).toBe(false)
  })

  it('filtrerer på kanal og søk, og sorterer på topp', async () => {
    const a = await createPost(db, ola, { ...question, title: 'Gammelt spørsmål' })
    await db.execute(
      sql`update ${schema.post} set created_at = now() - interval '3 days' where id = ${a}`,
    )
    const b = await createPost(db, kari, {
      channel: 'jobb',
      title: 'Vi ansetter en utvikler',
      body: '',
      url: 'https://example.test/jobb',
    })
    const c = await createPost(db, kari, {
      channel: 'lansering',
      title: 'Vi lanserer i dag',
      body: 'Sjekk det ut',
      url: '',
    })
    for (const v of [ola, admin]) await toggleVote(db, v, c)

    expect((await listPosts(db, ola, { channel: 'jobb' })).map((p) => p.id)).toEqual([b])
    expect((await listPosts(db, ola, { q: 'lanserer' })).map((p) => p.id)).toEqual([c])
    expect((await listPosts(db, ola, { sort: 'new' }))[2]?.id).toBe(a)
    expect((await listPosts(db, ola, { sort: 'top' }))[0]?.id).toBe(c)
  })

  it('validerer innhold', async () => {
    await expect(createPost(db, ola, { ...question, title: 'x' })).rejects.toThrow('minst 3')
    await expect(createPost(db, ola, { ...question, url: 'javascript:alert(1)' })).rejects.toThrow(
      'https',
    )
    const id = await createPost(db, ola, question)
    await expect(addComment(db, ola, id, { body: '   ' })).rejects.toThrow()
  })

  it('bare forfatter eller admin kan slette', async () => {
    const id = await createPost(db, ola, question)
    const commentId = await addComment(db, ola, id, { body: 'Oppdatering' })
    expect(await denial(deleteComment(db, kari, commentId))).toBe('forbidden')
    expect(await denial(deletePost(db, kari, id))).toBe('forbidden')
    await deleteComment(db, admin, commentId)
    expect((await getPost(db, ola, id)).commentList).toEqual([])
    await deletePost(db, ola, id)
    expect(await listPosts(db, kari)).toEqual([])
    await expect(getPost(db, kari, id)).rejects.toThrow('Fant ikke')
  })

  it('selskapskatalogen samler ES-selskaper, gründerselskaper og arbeidsgivere', async () => {
    const base = {
      city: '',
      studyBackground: '',
      bio: '',
      expertise: [],
      industries: [],
      experience: [],
      linkedinUrl: '',
      contactEmail: '',
      contactEmailVisible: false,
      phone: '',
      phoneVisible: false,
    }
    await updateProfile(db, ola, ola!.personId!, {
      ...base,
      fullName: 'Ola',
      esCompany: 'Syrlig AS',
    })
    await updateProfile(db, kari, kari!.personId!, {
      ...base,
      fullName: 'Kari',
      esCompany: ' syrlig as ',
      experience: [
        { company: 'Equinor', title: 'Analytiker', startYear: 2022, endYear: null, founder: false },
        { company: 'Fjordflow', title: null, startYear: 2019, endYear: 2022, founder: true },
      ],
    })
    const companies = await listCompanies(db, ola)
    expect(companies).toMatchObject([
      {
        slug: 'syrlig-as',
        startedByAlumni: true,
        esCompany: true,
        people: [
          { fullName: 'Kari', role: 'es' },
          { fullName: 'Ola', role: 'es' },
        ],
      },
      { name: 'Fjordflow', startedByAlumni: true, people: [{ fullName: 'Kari', role: 'founder' }] },
      {
        name: 'Equinor',
        startedByAlumni: false,
        people: [{ fullName: 'Kari', role: 'current', title: 'Analytiker' }],
      },
    ])
    expect(await denial(listCompanies(db, pending))).toBe('not_member')
  })
})
