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
  listAccessRequests,
  loadViewer,
  markAllNotificationsRead,
  sendNotificationEmails,
  sendWelcomeEmail,
  blockEmailAddress,
  setEmailKindEnabled,
  withEmailLog,
  withEmailSwitch,
  setEmailPaused,
  setEmailPreference,
  submitAccessRequest,
  unsubscribe,
  unsubscribeToken,
  WELCOME_PENDING_MS,
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
      sql`truncate ${schema.appSetting}, ${schema.emailLog}, ${schema.emailBlock}, ${schema.notification}, ${schema.notificationEmailPreference}, ${schema.postVote}, ${schema.comment}, ${schema.post}, ${schema.auditEvent}, ${schema.membership}, ${schema.personCohort}, ${schema.person}, ${schema.cohort}, ${schema.user} cascade`,
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
    expect(sent[0]!.text.startsWith('Hei Nina!')).toBe(true)
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

  it('på pause sendes ingenting; slått på igjen sendes ikke det som kom mens den var av', async () => {
    await setEmailPaused(db, admin, { paused: true, reason: 'Feil i malen' })
    await commentOnOlasPost('Under pausen')
    expect(await run(soon())).toMatchObject({ skipped: true, paused: true, emails: 0 })

    // Mens den er på pause, stopper også e-post som sendes direkte.
    await expect(
      withEmailSwitch(db, mailer).send({
        to: 'x@example.test',
        subject: 's',
        text: 't',
        html: 'h',
      }),
    ).rejects.toMatchObject({ reason: 'paused' })

    await setEmailPaused(db, admin, { paused: false })
    expect(await run(soon())).toMatchObject({ paused: false, emails: 0 })
    expect(sent).toEqual([])

    // Det som kommer etterpå, sendes som før.
    await commentOnOlasPost('Etter pausen')
    await run(new Date(Date.now() + 8 * 60 * 1000))
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain('Etter pausen')
  })

  it('bryteren: bare admins, i revisjonsloggen, og samme valg to ganger gjør ingenting', async () => {
    await expect(setEmailPaused(db, ola, { paused: true })).rejects.toMatchObject({
      reason: 'forbidden',
    })
    const paused = await setEmailPaused(db, admin, { paused: true, reason: '  Test  ' })
    expect(paused).toMatchObject({
      paused: true,
      reason: 'Test',
      changedBy: { personId: admin.personId, fullName: 'Ada Admin' },
    })
    await setEmailPaused(db, admin, { paused: true })
    await setEmailPaused(db, admin, { paused: false })
    const actions = await db
      .select({ action: schema.auditEvent.action, details: schema.auditEvent.details })
      .from(schema.auditEvent)
      .where(sql`${schema.auditEvent.action} like 'email.%'`)
      .orderBy(schema.auditEvent.createdAt)
    expect(actions).toEqual([
      { action: 'email.pause', details: { reason: 'Test' } },
      { action: 'email.resume', details: { reason: null } },
    ])
  })

  it('varsler kan slås av for seg; det som kom mens de var av, sendes ikke etterpå', async () => {
    await setEmailKindEnabled(db, admin, { kind: 'notification', enabled: false })
    await commentOnOlasPost('Mens varsler var av')
    await run(soon())
    expect(sent).toEqual([])
    await setEmailKindEnabled(db, admin, { kind: 'notification', enabled: true })
    await run(soon())
    expect(sent).toEqual([])
    await commentOnOlasPost('Etter')
    await run(new Date(Date.now() + 8 * 60 * 1000))
    expect(sent.map((m) => m.text.includes('Etter'))).toEqual([true])
  })

  it('til en stoppet adresse sendes ingenting, og det prøves ikke igjen', async () => {
    await blockEmailAddress(db, admin, { email: 'Ola.Hansen@example.test', reason: 'Ba om det' })
    await commentOnOlasPost()
    const switched = withEmailSwitch(db, mailer)
    const result = await sendNotificationEmails(db, {
      mailer: switched,
      appUrl: APP,
      secret: SECRET,
      now: soon(),
      log: { error() {} },
    })
    expect(result).toMatchObject({ emails: 0, failed: 1 })
    expect(sent).toEqual([])
    // Merket som ferdig, så det ikke prøves hver runde.
    expect(await emailed()).toHaveLength(1)
  })

  it('velkomsten er på vei til jobben har sendt den, men ikke når e-post står på pause', async () => {
    const logged = withEmailLog(db, mailer, { error() {} })
    const userId = await account('Vera Venter')
    await submitAccessRequest(db, await loadViewer(db, userId), {
      profilePersonId: null,
      fullName: 'Vera Venter',
      graduationYear: 2017,
      linkedinUrl: '',
      note: '',
    })
    const [request] = await db.select().from(schema.accessRequest)
    await decideAccessRequest(db, admin, { requestId: request!.id, decision: 'approve' })
    const pending = async () => (await listAccessRequests(db, admin, 'approved'))[0]!.welcomePending
    expect(await pending()).toBe(true)

    await setEmailPaused(db, admin, { paused: true })
    expect(await pending()).toBe(false)
    await setEmailPaused(db, admin, { paused: false })
    expect(await pending()).toBe(true)

    await sendWelcomeEmail(db, admin, logged, { requestId: request!.id, appUrl: APP })
    expect(await pending()).toBe(false)
  })

  it('velkomsten kan sendes for hånd, og forespørselen viser når den sist ble sendt', async () => {
    const logged = withEmailLog(db, mailer, { error() {} })
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
    expect((await listAccessRequests(db, admin, 'approved'))[0]).toMatchObject({
      welcomeEmail: null,
      welcomePending: true,
    })
    // Kom den ikke innen rimelig tid, er det admin som må sende den.
    await db
      .update(schema.accessRequest)
      .set({ decidedAt: new Date(Date.now() - WELCOME_PENDING_MS - 1000) })
    expect((await listAccessRequests(db, admin, 'approved'))[0]!.welcomePending).toBe(false)

    // Godkjent før velkomsten fantes: admin sender den selv.
    const { to } = await sendWelcomeEmail(db, admin, logged, {
      requestId: request!.id,
      appUrl: APP,
    })
    expect(to).toBe('nina.ny@example.test')
    expect(sent.map((m) => m.subject)).toEqual(['Du er med i ESAF'])
    expect((await listAccessRequests(db, admin, 'approved'))[0]!.welcomeEmail).toMatchObject({
      status: 'sent',
    })
    // Den automatiske kommer ikke i tillegg.
    await run(new Date())
    expect(sent).toHaveLength(1)

    await expect(
      sendWelcomeEmail(db, ola, logged, { requestId: request!.id, appUrl: APP }),
    ).rejects.toMatchObject({ reason: 'forbidden' })
    await db
      .update(schema.membership)
      .set({ status: 'inactive' })
      .where(eq(schema.membership.personId, (await loadViewer(db, userId))!.personId!))
    await expect(
      sendWelcomeEmail(db, admin, logged, { requestId: request!.id, appUrl: APP }),
    ).rejects.toThrow('bare til godkjente, aktive medlemmer')
  })

  describe('forespørsler om tilgang til adminene', () => {
    const MIN = 60 * 1000
    const HOUR = 60 * MIN

    async function request(name: string) {
      const userId = await account(name)
      await submitAccessRequest(db, await loadViewer(db, userId), {
        profilePersonId: null,
        fullName: name,
        graduationYear: 2021,
        linkedinUrl: '',
        note: '',
      })
    }
    const after = (ms: number) => new Date(Date.now() + ms)
    const alerts = () => sent.filter((m) => m.log?.kind === 'access_request')

    it('samler det som kommer samtidig i én e-post, som ikke nevner navnet', async () => {
      await request('Mallory Lenke')
      await request('Sigrid Sol')
      expect(await run(new Date())).toMatchObject({ emails: 0 })

      await run(soon())
      expect(alerts()).toHaveLength(1)
      const [message] = alerts()
      expect(message).toMatchObject({
        to: 'ada.admin@example.test',
        subject: '2 personer venter på godkjenning i ESAF',
      })
      expect(message!.text).toContain(`${APP}/admin`)
      expect(message!.text).not.toContain('Mallory')
      expect(message!.subject).not.toContain('Mallory')
      expect(message!.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
    })

    it('høyst én e-post hver sjette time, og bare om det har kommet nye', async () => {
      await request('Sigrid Sol')
      await run(soon())
      expect(alerts()).toHaveLength(1)

      await run(after(5 * MIN))
      expect(alerts()).toHaveLength(1)

      // Mange nye rett etter: de venter til pausen er over, og kommer samlet.
      for (const name of ['Nils Nord', 'Eva Vest', 'Siri Syd']) await request(name)
      await run(after(30 * MIN))
      await run(after(5 * HOUR))
      expect(alerts()).toHaveLength(1)

      await run(after(7 * HOUR))
      expect(alerts()).toHaveLength(2)
      expect(alerts()[1]!.subject).toBe('4 personer venter på godkjenning i ESAF')

      // Ingen nye siden sist: ingen påminnelse.
      await run(after(14 * HOUR))
      expect(alerts()).toHaveLength(2)
    })

    it('behandlet før e-posten skulle gå, sendes ingenting', async () => {
      await request('Sigrid Sol')
      const [open] = await listAccessRequests(db, admin, 'open')
      await decideAccessRequest(db, admin, { requestId: open!.id, decision: 'reject' })
      await run(soon())
      expect(alerts()).toHaveLength(0)
    })

    it('bare admins får den, og hver admin kan slå den av', async () => {
      const annen = await member('Anne Admin')
      await db
        .update(schema.membership)
        .set({ role: 'admin' })
        .where(eq(schema.membership.personId, annen.personId))
      await db
        .update(schema.membership)
        .set({ role: 'moderator' })
        .where(eq(schema.membership.personId, ola.personId))
      await setEmailPreference(db, admin, { category: 'access_requests', frequency: 'off' })

      await request('Sigrid Sol')
      await run(soon())
      expect(alerts().map((m) => m.to)).toEqual(['anne.admin@example.test'])
    })

    it('valget vises bare for admins, og er på eller av', async () => {
      const ids = async (v: Member) =>
        (await getEmailPreferences(db, v)).categories.map((c) => c.id as string)
      expect(await ids(admin)).toContain('access_requests')
      expect(await ids(ola)).not.toContain('access_requests')
      await expect(
        setEmailPreference(db, admin, { category: 'access_requests', frequency: 'daily' }),
      ).rejects.toThrow('Velg «Med en gang» eller «Av».')
    })

    it('feiler leverandøren før noen fikk den, prøves det igjen neste runde', async () => {
      await request('Sigrid Sol')
      failWith = new EmailError('unavailable')
      expect(await run(soon())).toMatchObject({ failed: 1 })
      failWith = null
      await run(after(5 * MIN))
      expect(alerts()).toHaveLength(1)
    })

    it('av i bryteren sendes ikke; de som fortsatt venter, kommer når den slås på', async () => {
      await setEmailKindEnabled(db, admin, {
        kind: 'access_request',
        enabled: false,
        reason: 'test',
      })
      await request('Sigrid Sol')
      await run(soon())
      expect(alerts()).toHaveLength(0)

      await setEmailKindEnabled(db, admin, {
        kind: 'access_request',
        enabled: true,
        reason: 'test',
      })
      await run(after(5 * MIN))
      expect(alerts()).toHaveLength(1)
    })

    it('stopper ikke varslene når det ikke er noen forespørsler', async () => {
      await commentOnOlasPost()
      expect(await run(soon())).toMatchObject({ emails: 1 })
      expect(alerts()).toHaveLength(0)
    })
  })
})
