import { randomUUID } from 'node:crypto'
import { createDb, loadRootEnv, runMigrations, schema, type Db } from '@esaf/db'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  addComment,
  createPost,
  decideMembership,
  emailCatalog,
  emailKinds,
  EmailError,
  emailOverview,
  grantRoleAsOperator,
  listEmailLog,
  loadViewer,
  pruneEmailLog,
  sendNotificationEmails,
  sendTestEmail,
  setEmailPreference,
  withEmailLog,
  type EmailMessage,
  type Mailer,
  type Viewer,
} from '../src/index.ts'

loadRootEnv()
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

type Member = NonNullable<Viewer> & { personId: string }

const APP = 'https://app.esaf.no'

describe.skipIf(!url)('e-postloggen', () => {
  let db: Db
  let admin: Member
  let ola: Member
  let kari: Member
  let sent: EmailMessage[]
  let failWith: EmailError | Error | null
  let mailer: Mailer

  beforeAll(async () => {
    await runMigrations(url!)
    db = createDb(url!)
    mailer = withEmailLog(
      db,
      {
        provider: 'console',
        async send(message) {
          if (failWith) throw failWith
          sent.push(message)
        },
      },
      { error() {} },
    )
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

  const send = (to: string, log: EmailMessage['log']) =>
    mailer.send({ to, subject: 'Emne', text: 'Tekst', html: '<p>Tekst</p>', log })

  beforeEach(async () => {
    sent = []
    failWith = null
    await db.execute(
      sql`truncate ${schema.emailLog}, ${schema.notification}, ${schema.notificationEmailPreference}, ${schema.comment}, ${schema.post}, ${schema.auditEvent}, ${schema.membership}, ${schema.personEmail}, ${schema.person}, ${schema.user} cascade`,
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
  })

  it('logger utfallet, og finner profilen fra adressen', async () => {
    await send('OLA.HANSEN@example.test', { kind: 'password_reset' })
    // Adressen er bare kjent fra kullisten.
    const listed = randomUUID()
    await db.insert(schema.person).values({ id: listed, fullName: 'Lise Liste' })
    await db
      .insert(schema.personEmail)
      .values({ email: 'lise@example.test', personId: listed, source: 'import' })
    await send('lise@example.test', { kind: 'invitation' })
    await send('ukjent@example.test', { kind: 'invitation' })
    failWith = new EmailError('bounced')
    await expect(send('kari.nordmann@example.test', { kind: 'verification' })).rejects.toThrow()
    failWith = new EmailError('throttled')
    await expect(send('kari.nordmann@example.test', { kind: 'verification' })).rejects.toThrow()
    failWith = new Error('noe annet')
    await expect(send('kari.nordmann@example.test', { kind: 'verification' })).rejects.toThrow()
    // Uten `log` skrives ingenting.
    failWith = null
    await mailer.send({ to: 'ola.hansen@example.test', subject: 'x', text: 'x', html: 'x' })

    const log = await listEmailLog(db, admin)
    expect(
      log.map((e) => [e.kind, e.toEmail, e.person?.fullName ?? null, e.status, e.errorReason]),
    ).toEqual([
      ['verification', 'kari.nordmann@example.test', 'Kari Nordmann', 'failed', 'error'],
      ['verification', 'kari.nordmann@example.test', 'Kari Nordmann', 'failed', 'throttled'],
      ['verification', 'kari.nordmann@example.test', 'Kari Nordmann', 'bounced', 'bounced'],
      ['invitation', 'ukjent@example.test', null, 'sent', null],
      ['invitation', 'lise@example.test', 'Lise Liste', 'sent', null],
      ['password_reset', 'ola.hansen@example.test', 'Ola Hansen', 'sent', null],
    ])
  })

  it('filtrerer, søker og blar', async () => {
    for (let i = 0; i < 5; i++) await send('ola.hansen@example.test', { kind: 'notification' })
    await send('kari.nordmann@example.test', { kind: 'digest', items: 3, category: 'all' })
    failWith = new EmailError('unavailable')
    await expect(send('kari.nordmann@example.test', { kind: 'welcome' })).rejects.toThrow()

    expect(await listEmailLog(db, admin, { kind: 'digest' })).toMatchObject([
      { items: 3, category: 'all', person: { personId: kari.personId } },
    ])
    expect(await listEmailLog(db, admin, { status: 'failed' })).toHaveLength(1)
    expect(await listEmailLog(db, admin, { personId: ola.personId })).toHaveLength(5)
    expect(await listEmailLog(db, admin, { q: 'kari' })).toHaveLength(2)
    expect(await listEmailLog(db, admin, { q: '100%_' })).toEqual([])

    const first = await listEmailLog(db, admin, { limit: 4 })
    const rest = await listEmailLog(db, admin, { limit: 4, beforeId: first.at(-1)!.id })
    expect(rest).toHaveLength(3)
    expect(new Set([...first, ...rest].map((e) => e.id)).size).toBe(7)
  })

  it('bare admins ser loggen og tallene', async () => {
    const denied = async (p: Promise<unknown>) =>
      p.then(
        () => 'ok',
        (e: { reason?: string }) => e.reason,
      )
    expect(await denied(listEmailLog(db, ola))).toBe('forbidden')
    expect(await denied(emailOverview(db, ola))).toBe('forbidden')
    expect(await denied(sendTestEmail(db, ola, mailer, { kind: 'welcome', appUrl: APP }))).toBe(
      'forbidden',
    )
  })

  it('tallene per type og dag, og valgene for varsler', async () => {
    const now = new Date()
    await send('ola.hansen@example.test', { kind: 'invitation' })
    await send('ola.hansen@example.test', { kind: 'invitation' })
    failWith = new EmailError('bounced')
    await expect(send('ola.hansen@example.test', { kind: 'invitation' })).rejects.toThrow()
    failWith = null
    // En gammel e-post teller bare i «totalt».
    await db.insert(schema.emailLog).values({
      kind: 'invitation',
      toEmail: 'gammel@example.test',
      subject: 'x',
      status: 'sent',
      provider: 'console',
      createdAt: new Date(now.getTime() - 40 * 24 * 3600 * 1000),
    })
    await setEmailPreference(db, ola, { category: 'mentions', frequency: 'off' })
    await setEmailPreference(db, kari, { category: 'mentions', frequency: 'daily' })

    const o = await emailOverview(db, admin, now)
    const invitation = o.kinds.find((k) => k.kind === 'invitation')!
    expect(invitation.last7).toEqual({ sent: 2, bounced: 1, failed: 0 })
    expect(invitation.total).toEqual({ sent: 3, bounced: 1, failed: 0 })
    expect(o.last30).toEqual({ sent: 2, bounced: 1, failed: 0 })
    expect(o.kinds.map((k) => k.kind)).toEqual([...emailKinds])
    expect(o.daily).toHaveLength(30)
    expect(o.daily.at(-1)).toMatchObject({ sent: 2, failed: 1 })
    expect(o.recipients).toBe(3)
    expect(o.preferences.find((p) => p.id === 'mentions')!.counts).toEqual({
      instant: 1,
      daily: 1,
      weekly: 0,
      off: 1,
    })
  })

  it('varsler og testsending logges med type, kategori og antall', async () => {
    const postId = await createPost(db, ola, {
      channel: 'lansering',
      title: 'Vi lanserer i dag',
      body: 'Endelig ute.',
      url: '',
    })
    await addComment(db, kari, postId, { body: 'Gratulerer!' })
    await sendNotificationEmails(db, {
      mailer,
      appUrl: APP,
      secret: 'en-hemmelighet-som-er-lang-nok-for-testene',
      now: new Date(Date.now() + 4 * 60 * 1000),
    })
    const { to } = await sendTestEmail(db, admin, mailer, { kind: 'digest', appUrl: APP })
    expect(to).toBe('ada.admin@example.test')
    expect(sent.at(-1)!.subject).toMatch(/^\[Test\] Oppsummering fra ESAF/)
    expect(
      (await listEmailLog(db, admin)).map((e) => [e.kind, e.person?.fullName, e.category, e.items]),
    ).toEqual([
      ['test', 'Ada Admin', null, 0],
      ['notification', 'Ola Hansen', 'post_comments', 1],
    ])
    await expect(sendTestEmail(db, admin, null, { kind: 'digest', appUrl: APP })).rejects.toThrow(
      'E-post er ikke satt opp',
    )
    failWith = new EmailError('rejected')
    await expect(
      sendTestEmail(db, admin, mailer, { kind: 'welcome', appUrl: APP }),
    ).rejects.toThrow('E-posttjenesten avviste sendingen')
  })

  it('eksemplene finnes for alle e-postene, uten ekte tokens', () => {
    const catalog = emailCatalog(APP)
    expect(catalog.map((t) => t.kind).sort()).toEqual(emailKinds.filter((k) => k !== 'test').sort())
    for (const t of catalog) {
      expect(t.sample.subject.length, t.kind).toBeGreaterThan(5)
      // Lenker med token er oppdiktet; velkomsten lenker bare til appen.
      if (t.kind !== 'welcome') expect(t.sample.text, t.kind).toContain('eksempel')
    }
  })

  it('loggen slettes etter ett år', async () => {
    const now = new Date()
    await send('ola.hansen@example.test', { kind: 'invitation' })
    await db.insert(schema.emailLog).values({
      kind: 'invitation',
      toEmail: 'gammel@example.test',
      subject: 'x',
      status: 'sent',
      provider: 'console',
      createdAt: new Date(now.getTime() - 366 * 24 * 3600 * 1000),
    })
    expect(await pruneEmailLog(db, now)).toBe(1)
    expect(await listEmailLog(db, admin)).toHaveLength(1)
  })
})
