import { randomUUID } from 'node:crypto'
import { createDb, loadRootEnv, runMigrations, schema, type Db, type MemberRole } from '@esaf/db'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccessDeniedError,
  changeRole,
  createPost,
  decideMembership,
  deletePost,
  DomainError,
  grantRoleAsOperator,
  listAccounts,
  listAuditEvents,
  loadViewer,
  removePasskeys,
  setMemberAccess,
  type Viewer,
} from '../src/index.ts'

loadRootEnv()
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

describe.skipIf(!url)('roller og medlemsadministrasjon', () => {
  let db: Db
  let owner: Viewer
  let admin: Viewer
  let moderator: Viewer
  let member: Viewer
  const ids: Record<string, string> = {}

  beforeAll(async () => {
    await runMigrations(url!)
    db = createDb(url!)
  })
  afterAll(() => db?.close())

  async function account(name: string, twoFactorEnabled = true) {
    const id = randomUUID()
    await db.insert(schema.user).values({
      id,
      name,
      email: `${name.toLowerCase()}@example.test`,
      emailVerified: true,
      twoFactorEnabled,
    })
    ids[name] = id
    return id
  }

  /** Et aktivt medlem med en rolle, gitt av en hovedadmin. */
  async function withRole(name: string, role: MemberRole) {
    const id = await account(name)
    const v = await loadViewer(db, id)
    await decideMembership(db, owner, { personId: v!.personId!, decision: 'approve' })
    if (role !== 'member') await changeRole(db, owner, { personId: v!.personId!, role })
    return loadViewer(db, id)
  }

  beforeEach(async () => {
    await db.execute(
      sql`truncate ${schema.post}, ${schema.accessRequest}, ${schema.auditEvent}, ${schema.membership}, ${schema.personCohort}, ${schema.person}, ${schema.cohort}, ${schema.session}, ${schema.user} cascade`,
    )
    await account('Eier')
    await grantRoleAsOperator(db, { email: 'eier@example.test', reason: 'test' })
    owner = await loadViewer(db, ids.Eier!)
    admin = await withRole('Admin', 'admin')
    moderator = await withRole('Moderator', 'moderator')
    member = await withRole('Medlem', 'member')
  })

  async function denial(promise: Promise<unknown>) {
    try {
      await promise
      return 'allowed'
    } catch (error) {
      if (error instanceof AccessDeniedError) return error.reason
      if (error instanceof DomainError) return error.message
      throw error
    }
  }

  it('bare hovedadmins med tofaktor kan endre roller, og aldri sin egen', async () => {
    const target = { personId: member!.personId!, role: 'moderator' as const }
    expect(await denial(changeRole(db, admin, target))).toBe('forbidden')
    expect(await denial(changeRole(db, member, target))).toBe('forbidden')
    expect(await denial(changeRole(db, owner, { ...target, personId: owner!.personId! }))).toMatch(
      'din egen rolle',
    )

    await db
      .update(schema.user)
      .set({ twoFactorEnabled: false })
      .where(eq(schema.user.id, ids.Eier!))
    const withoutTwoFactor = await loadViewer(db, ids.Eier!)
    expect(await denial(changeRole(db, withoutTwoFactor, target))).toBe('strong_auth_required')
    await db
      .update(schema.user)
      .set({ twoFactorEnabled: true })
      .where(eq(schema.user.id, ids.Eier!))

    await changeRole(db, owner, { ...target, reason: 'Moderator for feeden' })
    expect((await loadViewer(db, ids.Medlem!))?.membership?.role).toBe('moderator')
    const [entry] = await listAuditEvents(db, owner, { limit: 1 })
    expect(entry).toMatchObject({
      action: 'role.change',
      actor: { personId: owner!.personId },
      subject: { personId: member!.personId },
      details: { from: 'member', to: 'moderator', reason: 'Moderator for feeden' },
    })
  })

  async function addPasskey(userId: string) {
    await db.insert(schema.passkey).values({
      id: randomUUID(),
      userId,
      name: 'Testnøkkel',
      publicKey: 'pk',
      credentialID: randomUUID(),
      counter: 0,
      deviceType: 'multiDevice',
      backedUp: true,
    })
  }

  it('en admin med bare passkey må ha logget inn med passkey i denne økten', async () => {
    await db
      .update(schema.user)
      .set({ twoFactorEnabled: false })
      .where(eq(schema.user.id, ids.Admin!))
    await addPasskey(ids.Admin!)

    const withPassword = await loadViewer(db, ids.Admin!, { signedInWithPasskey: false })
    expect(withPassword).toMatchObject({ hasPasskey: true, passkeySession: false })
    expect(await denial(listAccounts(db, withPassword))).toBe('strong_auth_required')
    // Uten økt regnes innloggingen som passord.
    expect(await denial(listAccounts(db, await loadViewer(db, ids.Admin!)))).toBe(
      'strong_auth_required',
    )

    const withPasskey = await loadViewer(db, ids.Admin!, { signedInWithPasskey: true })
    expect(await denial(listAccounts(db, withPasskey))).toBe('allowed')
    const row = (await listAccounts(db, withPasskey)).find((a) => a.fullName === 'Admin')
    expect(row).toMatchObject({ twoFactorEnabled: false, passkeys: 1 })
  })

  it('passkeys kan fjernes for den som har mistet dem, etter reglene for tilgang', async () => {
    await addPasskey(ids.Moderator!)
    await addPasskey(ids.Moderator!)
    await addPasskey(ids.Admin!)
    await db.insert(schema.session).values({
      id: randomUUID(),
      token: randomUUID(),
      userId: ids.Moderator!,
      expiresAt: new Date(Date.now() + 864e5),
      signedInWithPasskey: true,
    })
    const input = { personId: moderator!.personId!, reason: 'Mistet telefonen' }

    expect(await denial(removePasskeys(db, moderator, input))).toBe('forbidden')
    expect(await denial(removePasskeys(db, admin, { ...input, reason: '' }))).toMatch('begrunnelse')
    expect(
      await denial(removePasskeys(db, admin, { personId: admin!.personId!, reason: 'test' })),
    ).toMatch('dine egne')
    expect(
      await denial(removePasskeys(db, admin, { personId: owner!.personId!, reason: 'test' })),
    ).toMatch('Bare en hovedadmin')

    await removePasskeys(db, admin, input)
    expect((await loadViewer(db, ids.Moderator!))?.hasPasskey).toBe(false)
    // Logget ut overalt, i tilfelle noen andre har en av dem.
    expect(
      await db.select().from(schema.session).where(eq(schema.session.userId, ids.Moderator!)),
    ).toEqual([])
    expect(await denial(removePasskeys(db, admin, input))).toMatch('ingen passkeys')
    const [entry] = await listAuditEvents(db, admin, { limit: 1 })
    expect(entry).toMatchObject({
      action: 'security.remove_passkeys',
      actor: { personId: admin!.personId },
      subject: { personId: moderator!.personId },
      details: { reason: 'Mistet telefonen', count: 2 },
    })

    // Hovedadmins kan fjerne passkeys for admins.
    await removePasskeys(db, owner, { personId: admin!.personId!, reason: 'Ny telefon' })
    expect((await loadViewer(db, ids.Admin!))?.hasPasskey).toBe(false)
  })

  it('den siste hovedadmin kan verken fjerne seg selv eller miste tilgangen', async () => {
    expect(
      await denial(
        setMemberAccess(db, owner, { personId: owner!.personId!, active: false, reason: 'test' }),
      ),
    ).toMatch('din egen tilgang')
    // En ny hovedadmin kan fjerne den gamle, så overlevering mellom styrer fungerer.
    await changeRole(db, owner, { personId: admin!.personId!, role: 'owner' })
    const newOwner = await loadViewer(db, ids.Admin!)
    await changeRole(db, newOwner, { personId: owner!.personId!, role: 'admin' })
    expect((await loadViewer(db, ids.Eier!))?.membership?.role).toBe('admin')
  })

  it('deaktivering logger ut overalt, fjerner rollen og krever begrunnelse', async () => {
    await db.insert(schema.session).values({
      id: randomUUID(),
      token: randomUUID(),
      userId: ids.Moderator!,
      expiresAt: new Date(Date.now() + 864e5),
    })
    const input = { personId: moderator!.personId!, active: false }
    expect(await denial(setMemberAccess(db, admin, { ...input, reason: ' ' }))).toMatch(
      'begrunnelse',
    )
    await setMemberAccess(db, admin, { ...input, reason: 'Ikke ES-alumn likevel' })

    const after = await loadViewer(db, ids.Moderator!)
    expect(after?.membership).toEqual({ status: 'inactive', role: 'member' })
    expect(
      await db.select().from(schema.session).where(eq(schema.session.userId, ids.Moderator!)),
    ).toEqual([])
    const [entry] = await listAuditEvents(db, admin, { limit: 1 })
    expect(entry).toMatchObject({
      action: 'membership.deactivate',
      details: { reason: 'Ikke ES-alumn likevel', previousRole: 'moderator' },
      // Loggen sier om profilen kan åpnes; en deaktivert persons profil kan ikke det.
      actor: { personId: admin!.personId, active: true },
      subject: { personId: moderator!.personId, active: false },
    })

    // Gjenoppretting gir vanlig medlemskap; rollen må gis på nytt.
    await setMemberAccess(db, admin, { ...input, active: true, reason: '' })
    expect((await loadViewer(db, ids.Moderator!))?.membership).toEqual({
      status: 'active',
      role: 'member',
    })
  })

  it('admins kan ikke endre tilgangen til andre admins, det kan bare hovedadmins', async () => {
    const otherAdmin = await withRole('Admin2', 'admin')
    const input = { personId: otherAdmin!.personId!, active: false, reason: 'test' }
    expect(await denial(setMemberAccess(db, admin, input))).toMatch('Bare en hovedadmin')
    expect(await denial(setMemberAccess(db, moderator, input))).toBe('forbidden')
    await setMemberAccess(db, owner, input)
    expect((await loadViewer(db, ids.Admin2!))?.membership?.status).toBe('inactive')
  })

  it('medlemslisten og revisjonsloggen krever rettigheter', async () => {
    expect(await denial(listAccounts(db, member))).toBe('forbidden')
    expect(await denial(listAccounts(db, moderator))).toBe('forbidden')
    expect(await denial(listAuditEvents(db, member))).toBe('forbidden')

    const accounts = await listAccounts(db, admin)
    expect(accounts.map((a) => [a.fullName, a.role, a.twoFactorEnabled])).toEqual([
      ['Admin', 'admin', true],
      ['Eier', 'owner', true],
      ['Medlem', 'member', true],
      ['Moderator', 'moderator', true],
    ])
    // Ventende kontoer hører hjemme under forespørsler, ikke i medlemslisten.
    await loadViewer(db, await account('Ventende'))
    expect((await listAccounts(db, admin)).map((a) => a.fullName)).not.toContain('Ventende')
  })

  it('moderatorer kan fjerne andres innlegg, og det logges', async () => {
    const own = await createPost(db, member, {
      channel: 'generelt',
      title: 'Et innlegg',
      body: '',
      url: '',
    })
    // Egne innlegg kan alle slette, uten at det logges som moderering.
    expect(await denial(deletePost(db, member, own))).toBe('allowed')
    const spam = await createPost(db, member, {
      channel: 'generelt',
      title: 'Spam',
      body: '',
      url: '',
    })
    const outsider = await withRole('Annen', 'member')
    expect(await denial(deletePost(db, outsider, spam))).toBe('forbidden')
    await deletePost(db, moderator, spam)
    const [entry] = await listAuditEvents(db, owner, { limit: 1 })
    expect(entry).toMatchObject({
      action: 'content.remove_post',
      actor: { personId: moderator!.personId },
      subject: { personId: member!.personId },
      details: { title: 'Spam' },
    })
  })
})
