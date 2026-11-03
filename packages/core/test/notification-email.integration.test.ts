import { randomUUID } from 'node:crypto'
import { createDb, loadRootEnv, runMigrations, schema, type Db } from '@esaf/db'
import { eq, isNotNull, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  addComment,
  createPost,
  decideAccessRequest,
  decideMembership,
  deletePost,
  EmailError,
  getEmailPreferences,
  grantRoleAsOperator,
  loadViewer,
  markAllNotificationsRead,
  sendNotificationEmails,
  setEmailPreference,
  submitAccessRequest,
  unsubscribe,
  unsubscribeToken,
  type EmailMessage,
  type Mailer,
  type Viewer,
} from '../src/index.ts'

loadRootEnv()
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

type Member = NonNullable<Viewer> & { personId: string }

const APP = 'https://app.esaf.no'
const SECRET = 'en-hemmelighet-som-er-lang-nok-for-testene'
/** Litt etter at «med en gang» har ventet ferdig. */
const soon = () => new Date(Date.now() + 4 * 60 * 1000)
/** Dagen etter: forbi neste daglige oppsummering. */
const tomorrow = () => new Date(Date.now() + 25 * 3600 * 1000)

describe.skipIf(!url)('varsler på e-post', () => {
  let db: Db
  let admin: Member
  let ola: Member
  let kari: Member
  let per: Member
  let sent: EmailMessage[]
  let failWith: EmailError | null

  const mailer: Mailer = {
    provider: 'console',
    async send(message) {
      if (failWith) throw failWith
      sent.push(message)
    },
  }
  const run = (now: Date) =>
    sendNotificationEmails(db, { mailer, appUrl: APP, secret: SECRET, now, log: { error() {} } })

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

  beforeEach(async () => {
    sent = []
    failWith = null
    await db.execute(
      sql`truncate ${schema.notification}, ${schema.notificationEmailPreference}, ${schema.postVote}, ${schema.comment}, ${schema.post}, ${schema.auditEvent}, ${schema.membership}, ${schema.personCohort}, ${schema.person}, ${schema.cohort}, ${schema.user} cascade`,
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
  })

  /** Ola skriver et innlegg; Kari kommenterer. Ola får varsel om kommentaren. */
  async function commentOnOlasPost(body = 'Gratulerer med lanseringen!') {
    const postId = await createPost(db, ola, {
      channel: 'lansering',
      title: 'Vi lanserer i dag',
      body: 'Endelig ute.',
      url: '',
    })
    const commentId = await addComment(db, kari, postId, { body })
    return { postId, commentId }
  }

  const emailed = () =>
    db
      .select({ id: schema.notification.id })
      .from(schema.notification)
      .where(isNotNull(schema.notification.emailedAt))

  it('sender et varsel noen minutter etter, én gang, med avmelding med ett klikk', async () => {
    const { postId, commentId } = await commentOnOlasPost()
    // Med en gang venter noen minutter.
    expect(await run(new Date())).toMatchObject({ emails: 0 })

    expect(await run(soon())).toMatchObject({ emails: 1, notifications: 1, failed: 0 })
    expect(sent).toHaveLength(1)
    const [message] = sent
    expect(message).toMatchObject({
      to: 'ola.hansen@example.test',
      subject: 'Kari Nordmann kommenterte innlegget ditt «Vi lanserer i dag»',
    })
    expect(message!.text).toContain('«Gratulerer med lanseringen!»')
    expect(message!.text).toContain(`${APP}/feed/${postId}#kommentar-${commentId}`)
    expect(message!.headers).toEqual({
      'List-Unsubscribe': expect.stringMatching(
        /^<https:\/\/app\.esaf\.no\/api\/varsler\/avmeld\?t=.+>$/,
      ),
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    })

    // Hvert varsel sendes én gang.
    await run(soon())
    expect(sent).toHaveLength(1)
    expect(await emailed()).toHaveLength(1)
  })

  it('lest i appen sendes ikke; av sendes ikke; slettet innhold sendes ikke', async () => {
    await commentOnOlasPost()
    await markAllNotificationsRead(db, ola)
    await run(soon())
    expect(sent).toEqual([])

    await setEmailPreference(db, ola, { category: 'post_comments', frequency: 'off' })
    await commentOnOlasPost('Enda en')
    await run(soon())
    expect(sent).toEqual([])

    // Slås det på igjen, sendes ikke det som kom mens det var av.
    await setEmailPreference(db, ola, { category: 'post_comments', frequency: 'instant' })
    await run(soon())
    expect(sent).toEqual([])

    const { postId } = await commentOnOlasPost('Slettes')
    await deletePost(db, ola, postId)
    await run(soon())
    expect(sent).toEqual([])
  })

  it('samtaler man er med i, kommer i den daglige oppsummeringen', async () => {
    const postId = await createPost(db, ola, {
      channel: 'sporsmal',
      title: 'Hvem kan regnskap?',
      body: '',
      url: '',
    })
    await addComment(db, per, postId, { body: 'Spør Kari.' })
    await addComment(db, kari, postId, { body: 'Jeg kan hjelpe!' })
    // Ola får sine med en gang (kommentarer på eget innlegg).
    await run(soon())
    expect(sent.map((m) => m.to)).toEqual(['ola.hansen@example.test'])
    expect(sent[0]!.subject).toBe('2 varsler fra ESAF')

    // Per er med i samtalen: daglig oppsummering som standard.
    await run(tomorrow())
    expect(sent.map((m) => m.to)).toEqual(['ola.hansen@example.test', 'per.berg@example.test'])
    expect(sent[1]!.subject).toBe('Oppsummering fra ESAF: 1 varsel')
    expect(sent[1]!.text).toContain('Kari Nordmann kommenterte også «Hvem kan regnskap?»')
  })

  it('valgene: standard per kategori, endring, og «alle av»', async () => {
    const prefs = await getEmailPreferences(db, ola)
    expect(prefs.email).toBe('ola.hansen@example.test')
    expect(Object.fromEntries(prefs.categories.map((c) => [c.id, c.frequency]))).toEqual({
      post_comments: 'instant',
      mentions: 'instant',
      thread_comments: 'daily',
      companies: 'instant',
      cohort: 'weekly',
    })
    await setEmailPreference(db, ola, { category: 'mentions', frequency: 'weekly' })
    await setEmailPreference(db, ola, { category: 'all', frequency: 'off' })
    expect(
      (await getEmailPreferences(db, ola)).categories.every((c) => c.frequency === 'off'),
    ).toBe(true)
    await expect(
      setEmailPreference(db, ola, { category: 'tull', frequency: 'off' }),
    ).rejects.toThrow('Ukjent kategori.')
  })

  it('avmeldingslenken slår av uten innlogging, og bare for den den ble laget for', async () => {
    const token = unsubscribeToken(SECRET, ola.personId, 'post_comments')
    expect(await unsubscribe(db, SECRET, token)).toMatchObject({ category: 'post_comments' })
    // Igjen er greit.
    await unsubscribe(db, SECRET, token)
    const prefs = await getEmailPreferences(db, ola)
    expect(prefs.categories.find((c) => c.id === 'post_comments')?.frequency).toBe('off')
    expect(prefs.categories.find((c) => c.id === 'mentions')?.frequency).toBe('instant')
    expect((await getEmailPreferences(db, kari)).categories[0]?.frequency).toBe('instant')
    await expect(unsubscribe(db, 'feil-hemmelighet', token)).rejects.toThrow('ikke gyldig')
  })

  it('feiler leverandøren, prøves det igjen; en adresse som avviser, prøves ikke igjen', async () => {
    await commentOnOlasPost()
    failWith = new EmailError('unavailable')
    expect(await run(soon())).toMatchObject({ emails: 0, failed: 1 })
    expect(await emailed()).toEqual([])

    failWith = null
    expect(await run(soon())).toMatchObject({ emails: 1 })

    await commentOnOlasPost('Til en adresse som avviser')
    failWith = new EmailError('bounced')
    await run(soon())
    failWith = null
    await run(soon())
    expect(sent).toHaveLength(1)
  })

  it('to runder samtidig sender aldri det samme to ganger', async () => {
    await commentOnOlasPost()
    const results = await Promise.all([run(soon()), run(soon()), run(soon())])
    expect(sent).toHaveLength(1)
    // Bare én runde sender; de andre fikk ikke låsen, eller fant ingenting igjen.
    expect(results.filter((r) => r.emails > 0)).toHaveLength(1)
  })

  it('ventende og deaktiverte medlemmer får ikke e-post', async () => {
    await commentOnOlasPost()
    await db
      .update(schema.membership)
      .set({ status: 'inactive' })
      .where(eq(schema.membership.personId, ola.personId))
    await run(soon())
    expect(sent).toEqual([])
  })

  it('godkjent forespørsel gir velkomst på e-post med en gang, én gang, uten avmelding', async () => {
    const userId = await account('Nina Ny')
    await submitAccessRequest(db, await loadViewer(db, userId), {
      profilePersonId: null,
      fullName: 'Nina Ny',
      graduationYear: 2017,
      linkedinUrl: '',
      note: '',
    })
    const [request] = await db.select().from(schema.accessRequest)
    await decideAccessRequest(db, admin, { requestId: request!.id, decision: 'approve' })

    expect(await run(new Date())).toMatchObject({ emails: 1 })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ to: 'nina.ny@example.test', subject: 'Du er med i ESAF' })
    expect(sent[0]!.text).toContain('ES 2017')
    expect(sent[0]!.text).toContain(`${APP}/`)
    expect(sent[0]!.headers).toBeUndefined()

    await run(tomorrow())
    expect(sent).toHaveLength(1)
  })

  it('velkomsten etter en invitasjon sendes ikke på e-post', async () => {
    await db.insert(schema.notification).values({
      recipientPersonId: ola.personId,
      type: 'welcome',
      eventKey: 'welcome',
      payload: {},
    })
    await run(soon())
    expect(sent).toEqual([])
  })

  it('feiler velkomsten, prøves den igjen', async () => {
    const userId = await account('Nina Ny')
    await submitAccessRequest(db, await loadViewer(db, userId), {
      profilePersonId: null,
      fullName: 'Nina Ny',
      graduationYear: null,
      linkedinUrl: '',
      note: '',
    })
    const [request] = await db.select().from(schema.accessRequest)
    await decideAccessRequest(db, admin, { requestId: request!.id, decision: 'approve' })
    failWith = new EmailError('unavailable')
    expect(await run(new Date())).toMatchObject({ emails: 0, failed: 1 })
    failWith = null
    await run(new Date())
    expect(sent.map((m) => m.subject)).toEqual(['Du er med i ESAF'])
  })
})
