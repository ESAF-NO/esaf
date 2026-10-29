import { randomUUID } from 'node:crypto'
import { createDb, loadRootEnv, runMigrations, schema, type Db } from '@esaf/db'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccessDeniedError,
  addComment,
  countUnreadNotifications,
  createPost,
  decideAccessRequest,
  decideMembership,
  deleteComment,
  deletePost,
  DomainError,
  formatMention,
  getPost,
  grantRoleAsOperator,
  listMentionable,
  listNotifications,
  listPosts,
  loadViewer,
  markAllNotificationsRead,
  markNotificationRead,
  NotFoundError,
  submitAccessRequest,
  type Viewer,
} from '../src/index.ts'
import { notifyMentions } from '../src/notifications.ts'

loadRootEnv()
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

type Member = NonNullable<Viewer> & { personId: string }

describe.skipIf(!url)('varsler og omtaler', () => {
  let db: Db
  let admin: Member
  let ola: Member
  let kari: Member
  let per: Member
  let pending: Member

  beforeAll(async () => {
    await runMigrations(url!)
    db = createDb(url!)
  })
  afterAll(() => db?.close())

  async function account(name: string) {
    const id = randomUUID()
    await db.insert(schema.user).values({
      id,
      name,
      email: `${name.toLowerCase().replace(/\s+/g, '.')}@example.test`,
      emailVerified: true,
    })
    return id
  }

  async function member(name: string) {
    const id = await account(name)
    const v = await loadViewer(db, id)
    await decideMembership(db, admin, { personId: v!.personId!, decision: 'approve' })
    return (await loadViewer(db, id)) as Member
  }

  /** En profil fra kullisten som ingen har tatt i bruk, men som står som aktiv. */
  async function unclaimedProfile(fullName: string) {
    const [p] = await db.insert(schema.person).values({ fullName, source: 'import' }).returning()
    await db.insert(schema.membership).values({ personId: p!.id, status: 'active' })
    return p!.id
  }

  async function inCohort(personId: string, graduationYear: number) {
    await db.insert(schema.cohort).values({ graduationYear }).onConflictDoNothing()
    const [c] = await db
      .select()
      .from(schema.cohort)
      .where(eq(schema.cohort.graduationYear, graduationYear))
    await db.insert(schema.personCohort).values({ personId, cohortId: c!.id })
  }

  beforeEach(async () => {
    await db.execute(
      sql`truncate ${schema.notification}, ${schema.postVote}, ${schema.comment}, ${schema.post}, ${schema.accessRequest}, ${schema.auditEvent}, ${schema.membership}, ${schema.personCohort}, ${schema.personEmail}, ${schema.person}, ${schema.cohort}, ${schema.user} cascade`,
    )
    const adminId = await account('Ada Admin')
    await grantRoleAsOperator(db, {
      email: 'ada.admin@example.test',
      reason: 'test',
      role: 'admin',
    })
    await db.update(schema.user).set({ twoFactorEnabled: true }).where(eq(schema.user.id, adminId))
    admin = (await loadViewer(db, adminId)) as Member
    ola = await member('Ola Hansen')
    kari = await member('Kari Nordmann')
    per = await member('Per Berg')
    pending = (await loadViewer(db, await account('Vera Venter'))) as Member
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

  /** Innboksen som [type, hvem] med nyeste først. */
  async function inbox(viewer: Member) {
    const { items } = await listNotifications(db, viewer, { limit: 50 })
    return items.map((n) => [n.type, n.actor?.fullName ?? null])
  }

  const question = (body = 'Trenger råd') => ({
    channel: 'sporsmal' as const,
    title: 'Hvem kan B2B-salg?',
    body,
    url: '',
  })
  const mention = (v: Member, name: string) => formatMention({ personId: v.personId, name })

  it('en kommentar varsler forfatteren av innlegget, ikke den som skrev den', async () => {
    const postId = await createPost(db, ola, question())
    const commentId = await addComment(db, kari, postId, { body: 'Jeg kan hjelpe!' })

    const { items } = await listNotifications(db, ola)
    expect(items).toMatchObject([
      {
        type: 'comment_on_post',
        read: false,
        actor: { personId: kari.personId, fullName: 'Kari Nordmann', claimed: true },
        post: { id: postId, title: 'Hvem kan B2B-salg?' },
        commentId,
        excerpt: 'Jeg kan hjelpe!',
      },
    ])
    expect(await inbox(kari)).toEqual([])

    // Forfatteren svarer selv: ingen varsel til seg selv, men Kari har kommentert.
    await addComment(db, ola, postId, { body: 'Takk!' })
    expect(await inbox(ola)).toHaveLength(1)
    expect(await inbox(kari)).toEqual([['comment_on_thread', 'Ola Hansen']])
  })

  it('nye kommentarer varsler alle som har kommentert før', async () => {
    const postId = await createPost(db, ola, question())
    await addComment(db, kari, postId, { body: 'Første' })
    const perComment = await addComment(db, per, postId, { body: 'Andre' })
    expect(await inbox(ola)).toEqual([
      ['comment_on_post', 'Per Berg'],
      ['comment_on_post', 'Kari Nordmann'],
    ])
    expect(await inbox(kari)).toEqual([['comment_on_thread', 'Per Berg']])
    expect(await inbox(per)).toEqual([])

    // Den som har slettet kommentaren sin, følger ikke lenger tråden.
    await deleteComment(db, per, perComment)
    await addComment(db, kari, postId, { body: 'Tredje' })
    expect(await inbox(per)).toEqual([])
    expect(await inbox(ola)).toHaveLength(2)
    expect((await inbox(ola))[0]).toEqual(['comment_on_post', 'Kari Nordmann'])
  })

  it('én hendelse gir ett varsel per mottaker, også ved omtale', async () => {
    const postId = await createPost(db, ola, question())
    await addComment(db, per, postId, { body: 'Følger med' })
    const commentId = await addComment(db, kari, postId, {
      body: `${mention(ola, 'Ola')} og ${mention(per, 'Per')}: hva med ${mention(per, 'Per')}?`,
    })
    // Ola er både forfatter og nevnt, Per både har kommentert og er nevnt.
    expect(await inbox(ola)).toEqual([
      ['mention', 'Kari Nordmann'],
      ['comment_on_post', 'Per Berg'],
    ])
    expect(await inbox(per)).toEqual([['mention', 'Kari Nordmann']])

    // Kalles omtalene på nytt (som ved redigering), kommer det ingen nye varsler.
    await db.transaction((tx) =>
      notifyMentions(tx, {
        postId,
        commentId,
        actorPersonId: kari.personId,
        mentioned: [ola.personId, per.personId],
      }),
    )
    expect(await inbox(ola)).toHaveLength(2)
    expect(await inbox(per)).toHaveLength(1)
  })

  it('omtaler i innlegg varsler de nevnte og lagres med navnet fra profilen', async () => {
    const postId = await createPost(
      db,
      ola,
      question(`Spør ${mention(kari, 'Hvem som helst')} eller meg (${mention(ola, 'Ola')}).`),
    )
    expect(await inbox(kari)).toEqual([['mention', 'Ola Hansen']])
    expect(await inbox(ola)).toEqual([])

    const { items } = await listNotifications(db, kari)
    expect(items[0]).toMatchObject({
      post: { id: postId },
      commentId: null,
      excerpt: 'Spør @Kari Nordmann eller meg (@Ola Hansen).',
    })
    // Navnet i omtalen er alltid personens eget, uansett hva klienten sendte.
    const view = await getPost(db, kari, postId)
    expect(view.body).toBe(
      `Spør ${mention(kari, 'Kari Nordmann')} eller meg (${mention(ola, 'Ola Hansen')}).`,
    )
    const [summary] = await listPosts(db, kari)
    expect(summary?.excerpt).toBe('Spør @Kari Nordmann eller meg (@Ola Hansen).')
  })

  it('omtaler av andre enn aktive medlemmer med konto gjør ingenting', async () => {
    const profile = await unclaimedProfile('Lise Liste')
    const gone = await member('Gunnar Gått')
    await db
      .update(schema.membership)
      .set({ status: 'inactive' })
      .where(eq(schema.membership.personId, gone.personId))
    const unknown = randomUUID()

    const postId = await createPost(
      db,
      ola,
      question(
        [
          formatMention({ personId: pending.personId, name: 'Vera' }),
          formatMention({ personId: profile, name: 'Lise' }),
          formatMention({ personId: gone.personId, name: 'Gunnar' }),
          formatMention({ personId: unknown, name: 'Ukjent' }),
        ].join(' '),
      ),
    )
    const count = await db.select({ n: sql<number>`count(*)::int` }).from(schema.notification)
    expect(count[0]?.n).toBe(0)
    expect((await getPost(db, ola, postId)).body).toBe('@Vera @Lise @Gunnar @Ukjent')

    // Heller ikke kommentarer eller tråder gir varsel til andre enn aktive medlemmer.
    await db
      .update(schema.membership)
      .set({ status: 'inactive' })
      .where(eq(schema.membership.personId, ola.personId))
    await addComment(db, kari, postId, { body: 'Hei' })
    expect(await db.select().from(schema.notification)).toEqual([])
  })

  it('kan ikke nevne flere enn 20 personer i én tekst', async () => {
    const many: Member[] = []
    for (let i = 0; i < 21; i++) many.push(await member(`Medlem ${i}`))
    const body = many.map((m) => mention(m, 'x')).join(' ')
    await expect(createPost(db, ola, question(body))).rejects.toThrow(DomainError)
    await expect(createPost(db, ola, question(body))).rejects.toThrow('opptil 20')
    expect(await listPosts(db, ola)).toEqual([])
    await createPost(
      db,
      ola,
      question(
        many
          .slice(0, 20)
          .map((m) => mention(m, 'x'))
          .join(' '),
      ),
    )
    expect(await inbox(many[0]!)).toEqual([['mention', 'Ola Hansen']])
  })

  it('varsler om slettede innlegg og kommentarer skjules', async () => {
    const first = await createPost(db, ola, question())
    const commentId = await addComment(db, kari, first, { body: 'Hei' })
    expect(await countUnreadNotifications(db, ola)).toBe(1)
    await deleteComment(db, kari, commentId)
    expect(await inbox(ola)).toEqual([])
    expect(await countUnreadNotifications(db, ola)).toBe(0)

    const second = await createPost(db, ola, question(`Hva mener ${mention(per, 'Per')}?`))
    await addComment(db, kari, second, { body: 'Godt spørsmål' })
    expect(await inbox(per)).toHaveLength(1)
    expect(await inbox(ola)).toHaveLength(1)
    await deletePost(db, admin, second)
    expect(await inbox(per)).toEqual([])
    expect(await inbox(ola)).toEqual([])
    expect(await countUnreadNotifications(db, per)).toBe(0)
  })

  it('lest og ulest', async () => {
    const a = await createPost(db, ola, question())
    const b = await createPost(db, ola, question())
    await addComment(db, kari, a, { body: 'En' })
    await addComment(db, per, a, { body: 'To' })
    await addComment(db, kari, b, { body: 'Tre' })
    expect(await countUnreadNotifications(db, ola)).toBe(3)

    // Den som åpner et varsel om et innlegg, ser alle kommentarene der.
    const { items } = await listNotifications(db, ola)
    const onA = items.find((n) => n.post?.id === a)!
    await markNotificationRead(db, ola, onA.id)
    expect(await countUnreadNotifications(db, ola)).toBe(1)
    expect((await listNotifications(db, ola)).items.map((n) => [n.post?.id, n.read])).toEqual([
      [b, false],
      [a, true],
      [a, true],
    ])
    expect(await countUnreadNotifications(db, kari)).toBe(1)

    await markAllNotificationsRead(db, ola)
    expect(await countUnreadNotifications(db, ola)).toBe(0)
    // Kari sitt varsel (Per kommenterte også) er fortsatt ulest.
    expect(await countUnreadNotifications(db, kari)).toBe(1)
  })

  it('blar bakover uten å hoppe over eller gjenta varsler', async () => {
    const postId = await createPost(db, ola, question())
    for (let i = 0; i < 5; i++) await addComment(db, i % 2 ? kari : per, postId, { body: `${i}` })
    const seen: string[] = []
    let before: string | undefined
    for (;;) {
      const page = await listNotifications(db, ola, { limit: 2, before })
      seen.push(...page.items.map((n) => n.excerpt!))
      if (!page.hasMore) break
      before = page.items.at(-1)!.id
    }
    expect(seen).toEqual(['4', '3', '2', '1', '0'])
    await expect(listNotifications(db, ola, { before: 'ikke-en-id' })).rejects.toThrow(
      NotFoundError,
    )
  })

  it('man ser og endrer bare sine egne varsler', async () => {
    const postId = await createPost(db, ola, question())
    await addComment(db, kari, postId, { body: 'Hei' })
    const [own] = (await listNotifications(db, ola)).items
    expect(await inbox(per)).toEqual([])
    await expect(markNotificationRead(db, per, own!.id)).rejects.toThrow(NotFoundError)
    await markAllNotificationsRead(db, per)
    expect(await countUnreadNotifications(db, ola)).toBe(1)

    for (const viewer of [null, pending]) {
      const expected = viewer ? 'not_member' : 'unauthenticated'
      expect(await denial(listNotifications(db, viewer))).toBe(expected)
      expect(await denial(countUnreadNotifications(db, viewer))).toBe(expected)
      expect(await denial(markNotificationRead(db, viewer, own!.id))).toBe(expected)
      expect(await denial(markAllNotificationsRead(db, viewer))).toBe(expected)
      expect(await denial(listMentionable(db, viewer))).toBe(expected)
    }
  })

  it('forslag til omtaler er aktive medlemmer med konto, uten en selv', async () => {
    await unclaimedProfile('Lise Liste')
    await inCohort(kari.personId, 2017)
    const people = await listMentionable(db, ola)
    expect(people.map((p) => p.fullName)).toEqual(['Ada Admin', 'Kari Nordmann', 'Per Berg'])
    expect(people.find((p) => p.personId === kari.personId)?.cohortYears).toEqual([2017])
  })

  it('godkjenning gir velkomst, og kullet får beskjed', async () => {
    await inCohort(kari.personId, 2017)
    await inCohort(per.personId, 2018)
    await inCohort(await unclaimedProfile('Lise Liste'), 2017)

    const applicant = (await loadViewer(db, await account('Nina Ny'))) as Member
    await submitAccessRequest(db, applicant, {
      profilePersonId: null,
      fullName: 'Nina Ny',
      graduationYear: 2017,
      linkedinUrl: '',
      note: '',
    })
    const [request] = await db.select().from(schema.accessRequest)
    await decideAccessRequest(db, admin, { requestId: request!.id, decision: 'approve' })

    const nina = (await loadViewer(db, applicant.userId)) as Member
    const { items } = await listNotifications(db, nina)
    expect(items).toMatchObject([{ type: 'welcome', actor: null, graduationYear: 2017 }])
    expect((await listNotifications(db, kari)).items).toMatchObject([
      {
        type: 'cohort_joined',
        actor: { personId: nina.personId, fullName: 'Nina Ny' },
        graduationYear: 2017,
      },
    ])
    expect(await inbox(per)).toEqual([])
    expect(await inbox(admin)).toEqual([])
    // Profilen fra kullisten har ingen konto og får ingenting.
    expect(await db.select().from(schema.notification)).toHaveLength(2)
  })

  it('godkjenning med profil fra kullisten varsler profilen, avslag ingen', async () => {
    const profile = await unclaimedProfile('Nils Nordmann')
    await inCohort(profile, 2017)
    await inCohort(kari.personId, 2017)
    await db
      .insert(schema.personEmail)
      .values({ email: 'nils.n@example.test', personId: profile, source: 'import' })
    const nilsId = randomUUID()
    await db
      .insert(schema.user)
      .values({ id: nilsId, name: 'Nils', email: 'nils.n@example.test', emailVerified: true })
    await submitAccessRequest(db, await loadViewer(db, nilsId), {
      profilePersonId: profile,
      fullName: 'Nils Nordmann',
      graduationYear: 2017,
      linkedinUrl: '',
      note: '',
    })
    const rejected = (await loadViewer(db, await account('Rolf Avvist'))) as Member
    await submitAccessRequest(db, rejected, {
      profilePersonId: null,
      fullName: 'Rolf Avvist',
      graduationYear: 2017,
      linkedinUrl: '',
      note: '',
    })
    const requests = await db.select().from(schema.accessRequest)
    for (const r of requests) {
      await decideAccessRequest(db, admin, {
        requestId: r.id,
        decision: r.userId === nilsId ? 'approve' : 'reject',
      })
    }

    const nils = (await loadViewer(db, nilsId)) as Member
    expect(nils.personId).toBe(profile)
    expect(await inbox(nils)).toEqual([['welcome', null]])
    expect(await inbox(kari)).toEqual([['cohort_joined', 'Nils Nordmann']])
    expect(await db.select().from(schema.notification)).toHaveLength(2)
  })
})
