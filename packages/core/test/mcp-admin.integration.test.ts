import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb, loadRootEnv, runMigrations, schema, type Db } from '@esaf/db'
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccessDeniedError,
  addFieldSources,
  addQuote,
  authenticateApiToken,
  changeRole,
  createApiToken,
  createDiskStorage,
  createInvitation,
  createProfile,
  createProfileBatch,
  decideMembership,
  deleteProfile,
  DomainError,
  fillUnclaimedContact,
  getEditableProfile,
  getPersonAdmin,
  grantRoleAsOperator,
  listApiTokens,
  listAuditEvents,
  listPeopleIndex,
  loadViewer,
  planProfileBatch,
  removePasskeys,
  revokeApiToken,
  setMemberAccess,
  setQuoteLinks,
  withMcpAudit,
  type ObjectStorage,
  type Viewer,
} from '../src/index.ts'

loadRootEnv()
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

const portrait = () =>
  sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 20, g: 90, b: 160 } } })
    .png()
    .toBuffer()

describe.skipIf(!url)('MCP: nøkler og adminverktøy i @esaf/core', () => {
  let db: Db
  let dir: string
  let storage: ObjectStorage
  let owner: Viewer
  let admin: Viewer
  let ola: Viewer

  beforeAll(async () => {
    await runMigrations(url!)
    db = createDb(url!)
    dir = await mkdtemp(join(tmpdir(), 'esaf-mcp-core-'))
    storage = createDiskStorage(dir)
  })
  afterAll(async () => {
    await db?.close()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  async function account(name: string, { twoFactor = false } = {}) {
    const id = randomUUID()
    await db.insert(schema.user).values({
      id,
      name,
      email: `${name.toLowerCase()}@example.test`,
      emailVerified: true,
      twoFactorEnabled: twoFactor,
    })
    return id
  }

  async function withRole(name: string, role: 'admin' | 'owner') {
    const userId = await account(name, { twoFactor: true })
    await grantRoleAsOperator(db, {
      email: `${name.toLowerCase()}@example.test`,
      reason: 'test',
      role,
    })
    return loadViewer(db, userId)
  }

  beforeEach(async () => {
    await db.execute(
      sql`truncate ${schema.apiToken}, ${schema.fieldSource}, ${schema.auditEvent}, ${schema.membership}, ${schema.personCohort}, ${schema.personEmail}, ${schema.person}, ${schema.cohort}, ${schema.user}, ${schema.company}, ${schema.quote}, ${schema.invitation} cascade`,
    )
    owner = await withRole('Eier', 'owner')
    admin = await withRole('Admin', 'admin')
    const olaId = await account('Ola')
    const v = await loadViewer(db, olaId)
    await decideMembership(db, admin, { personId: v!.personId!, decision: 'approve' })
    ola = await loadViewer(db, olaId)
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

  const token = (viewer: Viewer, input: Partial<Parameters<typeof createApiToken>[2]> = {}) =>
    createApiToken(db, viewer, { name: 'Claude', days: 30, readOnly: false, ...input })

  describe('MCP-nøkler', () => {
    it('lages bare av admins i en sterk økt, og bare hashen lagres', async () => {
      expect(await denial(token(ola))).toBe('forbidden')
      const weak = { ...admin!, twoFactorEnabled: false }
      expect(await denial(token(weak))).toBe('strong_auth_required')

      const { token: raw, view } = await token(admin)
      expect(raw).toMatch(/^esaf_[A-Za-z0-9_-]{43}$/)
      expect(view).toMatchObject({ name: 'Claude', status: 'active', readOnly: false })
      expect(view.prefix).toBe(raw.slice(0, 11))
      const [row] = await db.select().from(schema.apiToken)
      expect(row!.tokenHash).not.toContain(raw)
      expect(JSON.stringify(row)).not.toContain(raw)

      const [created] = await listAuditEvents(db, admin, { actionPrefix: 'mcp_token.' })
      expect(created).toMatchObject({ action: 'mcp_token.create', details: { name: 'Claude' } })
    })

    it('en nøkkel gir en sterk viewer med kontoens rolle, og kan ikke lage nøkler selv', async () => {
      const { token: raw, view } = await token(admin, { readOnly: true })
      const viewer = await authenticateApiToken(db, raw)
      expect(viewer).toMatchObject({
        personId: admin!.personId,
        mcp: { apiTokenId: view.id, readOnly: true },
      })
      expect(await denial(token(viewer))).toBe('forbidden')
      expect(await denial(revokeApiToken(db, viewer, view.id))).toBe('forbidden')
      expect(await authenticateApiToken(db, 'esaf_feil')).toBeNull()
      expect(await authenticateApiToken(db, `esaf_${'a'.repeat(43)}`)).toBeNull()
    })

    it('utløpte og tilbaketrukne nøkler virker ikke, og eieren ser status', async () => {
      const a = await token(admin)
      const b = await token(admin, { name: 'Gammel' })
      await db
        .update(schema.apiToken)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(schema.apiToken.id, b.view.id))
      expect(await authenticateApiToken(db, b.token)).toBeNull()

      await revokeApiToken(db, admin, a.view.id)
      expect(await authenticateApiToken(db, a.token)).toBeNull()
      const list = await listApiTokens(db, admin)
      expect(list.map((t) => [t.name, t.status])).toEqual([
        ['Gammel', 'expired'],
        ['Claude', 'revoked'],
      ])
      // Andres nøkler finnes ikke for deg.
      expect(await denial(revokeApiToken(db, owner, b.view.id))).toBe('Fant ikke nøkkelen.')
    })

    it('virker bare mens kontoen har passkey eller tofaktor', async () => {
      const { token: raw } = await token(admin)
      await db
        .update(schema.user)
        .set({ twoFactorEnabled: false })
        .where(eq(schema.user.id, admin!.userId))
      expect(await authenticateApiToken(db, raw)).toBeNull()
    })

    it('høyst ti gyldige nøkler per konto', async () => {
      for (let i = 0; i < 10; i++) await token(admin, { name: `Nøkkel ${i}` })
      expect(await denial(token(admin))).toMatch(/allerede 10 gyldige nøkler/)
    })

    it('trekkes tilbake når kontoen mister adminrollen, deaktiveres eller mister passkeyene', async () => {
      const first = await token(admin)
      await changeRole(db, owner, { personId: admin!.personId!, role: 'moderator' })
      expect(await authenticateApiToken(db, first.token)).toBeNull()
      const [change] = await listAuditEvents(db, owner, { actionPrefix: 'role.change' })
      expect(change!.details).toMatchObject({ revokedTokens: 1 })

      await changeRole(db, owner, { personId: admin!.personId!, role: 'admin' })
      admin = await loadViewer(db, admin!.userId)
      await token(admin)
      await setMemberAccess(db, owner, {
        personId: admin!.personId!,
        active: false,
        reason: 'Gikk ut av styret',
      })
      const tokens = await db.select().from(schema.apiToken)
      expect(tokens.every((t) => t.revokedAt !== null)).toBe(true)

      const other = await withRole('Annen', 'admin')
      const raw = await token(other)
      await db.insert(schema.passkey).values({
        id: randomUUID(),
        userId: other!.userId,
        publicKey: 'x',
        credentialID: randomUUID(),
        counter: 0,
        deviceType: 'singleDevice',
        backedUp: false,
      })
      await removePasskeys(db, owner, { personId: other!.personId!, reason: 'Mistet telefonen' })
      expect(await authenticateApiToken(db, raw.token)).toBeNull()
    })

    it('alt som skrives med nøkkelen, merkes i revisjonsloggen', async () => {
      const { token: raw, view } = await token(admin)
      const viewer = await authenticateApiToken(db, raw)
      const tagged = withMcpAudit(db, { apiTokenId: view.id, readOnly: false })
      const { personId } = await createProfile(tagged, viewer, {
        fullName: 'Via Nøkkel',
        cohorts: [],
        emails: [],
        status: 'active',
      })
      await createProfile(db, admin, {
        fullName: 'Fra Appen',
        cohorts: [],
        emails: [],
        status: 'active',
      })
      const rows = await db
        .select({ subject: schema.auditEvent.subjectPersonId, token: schema.auditEvent.apiTokenId })
        .from(schema.auditEvent)
        .where(eq(schema.auditEvent.action, 'profile.create'))
      expect(rows.find((r) => r.subject === personId)!.token).toBe(view.id)
      expect(rows.find((r) => r.subject !== personId)!.token).toBeNull()

      const viaMcp = await listAuditEvents(db, admin, { viaMcp: true })
      expect(viaMcp.map((e) => [e.action, e.viaMcp])).toEqual([
        ['profile.create', { kind: 'key', name: 'Claude' }],
      ])
      // Settingen gjelder bare transaksjonen, ikke neste forespørsel på samme tilkobling.
      const [{ setting }] = (
        await db.execute<{ setting: string | null }>(
          sql`select current_setting('esaf.api_token_id', true) as setting`,
        )
      ).rows as [{ setting: string | null }]
      expect(setting || null).toBeNull()
    })
  })

  describe('mange profiler på én gang', () => {
    it('planen finner duplikater på e-post, LinkedIn og navn, også innad i forespørselen', async () => {
      await createProfile(db, admin, {
        fullName: 'Kari Nordmann',
        cohorts: [{ graduationYear: 2019, relation: 'student' }],
        emails: ['kari@example.test'],
        status: 'active',
      })
      const plan = await planProfileBatch(db, admin, [
        { fullName: 'Ny Person', cohorts: [{ graduationYear: 2027 }] },
        { fullName: 'Kåri Nordmann', cohorts: [{ graduationYear: 2020 }] },
        { fullName: 'Noen Annen', emails: ['KARI@example.test'] },
        { fullName: 'Ny Person', cohorts: [{ graduationYear: 2027 }] },
        { fullName: 'X' },
      ])
      expect(plan.counts).toEqual({ create: 1, duplicate: 3, invalid: 1 })
      expect(plan.rows[1]).toMatchObject({ status: 'duplicate', blocked: false })
      expect(plan.rows[1]!.matches[0]).toMatchObject({
        fullName: 'Kari Nordmann',
        reasons: ['name'],
      })
      expect(plan.rows[2]).toMatchObject({ status: 'duplicate', blocked: true })
      expect(plan.rows[2]!.errors[0]).toMatch(/hører allerede til Kari Nordmann/)
      expect(plan.rows[3]!.matches[0]).toMatchObject({ row: 0, personId: null })
      expect(plan.rows[4]).toMatchObject({ status: 'invalid' })
      expect(await denial(planProfileBatch(db, ola, [{ fullName: 'A B' }]))).toBe('forbidden')
    })

    it('lager profilene i én transaksjon med felt, erfaring, kilder og bilde', async () => {
      const result = await createProfileBatch(
        db,
        storage,
        admin,
        [
          {
            ref: 'a',
            fullName: 'Ada Lovelace',
            cohorts: [{ graduationYear: 2027 }],
            emails: ['ada@example.test'],
            contactEmail: 'ada.kontakt@example.test',
            phone: '41234567',
            city: 'Trondheim',
            bio: 'Gründer.',
            linkedinUrl: 'linkedin.com/in/ada?utm_source=x',
            experience: [{ company: 'Analytisk AS', title: 'CEO', founder: true }],
            esCompany: 'Analytisk AS',
            sources: [
              { field: 'bio', label: 'entreprenorskolen.no', confidence: 'high' },
              { field: 'experience', url: 'https://www.proff.no/ada', confidence: 'medium' },
            ],
          },
          { ref: 'b', fullName: 'Grace Hopper', cohorts: [{ graduationYear: 2027 }] },
          { ref: 'c', fullName: 'Med Ødelagt Bilde', cohorts: [{ graduationYear: 2027 }] },
        ],
        {
          photos: new Map([
            [0, await portrait()],
            [2, new Uint8Array([1, 2, 3])],
          ]),
        },
      )
      expect(result).toMatchObject({ created: 3, skipped: 0 })
      expect(result.rows[2]!.warnings[0]).toMatch(/Bildet ble ikke lagret/)
      const ada = result.rows[0]!.personId!
      const profile = await getEditableProfile(db, admin, ada)
      expect(profile).toMatchObject({
        fullName: 'Ada Lovelace',
        city: 'Trondheim',
        linkedinUrl: 'https://linkedin.com/in/ada',
        contactEmail: 'ada.kontakt@example.test',
        contactEmailVisible: true,
        phone: '+47 412 34 567',
        esCompany: 'Analytisk AS',
      })
      expect(profile.photo).not.toBeNull()
      expect(profile.experience).toMatchObject([{ company: 'Analytisk AS', founder: true }])
      const details = await getPersonAdmin(db, admin, ada)
      expect(details.emails.map((e) => e.email).sort()).toEqual([
        'ada.kontakt@example.test',
        'ada@example.test',
      ])
      expect(details.status).toBe('active')
      const sources = await db
        .select()
        .from(schema.fieldSource)
        .where(eq(schema.fieldSource.entityId, ada))
      expect(sources.map((s) => [s.field, s.sourceLabel]).sort()).toEqual([
        ['bio', 'entreprenorskolen.no'],
        ['experience', 'proff.no'],
      ])
      const [company] = await db.select().from(schema.company)
      expect(company!.status).toBe('unknown')
      expect(
        (await readdir(dir, { recursive: true })).filter((f) => f.endsWith('.webp')),
      ).toHaveLength(2)

      const audit = await listAuditEvents(db, admin, { actionPrefix: 'profile.' })
      expect(audit.filter((e) => e.action === 'profile.create')).toHaveLength(3)
      expect(audit.find((e) => e.action === 'profile.batch_create')!.details).toMatchObject({
        created: 3,
        cohorts: [2027],
        withPhoto: 1,
      })
    })

    it('hopper over duplikater uten allowDuplicates, og lager aldri en med en annens e-post', async () => {
      await createProfile(db, admin, {
        fullName: 'Kari Nordmann',
        cohorts: [{ graduationYear: 2019, relation: 'student' }],
        emails: ['kari@example.test'],
        status: 'active',
      })
      const rows = [
        { fullName: 'Kari Nordmann', cohorts: [{ graduationYear: 2019 }] },
        { fullName: 'Kari Annen', emails: ['kari@example.test'] },
      ]
      expect(await createProfileBatch(db, storage, admin, rows)).toMatchObject({
        created: 0,
        skipped: 2,
      })
      const forced = await createProfileBatch(db, storage, admin, rows, { allowDuplicates: true })
      expect(forced.created).toBe(1)
      expect(forced.rows[1]!.personId).toBeNull()
    })
  })

  describe('andre adminverktøy', () => {
    it('sletter bare profiler uten konto, med begrunnelse, og trekker tilbake invitasjoner', async () => {
      const { personId } = await createProfile(db, admin, {
        fullName: 'Feil Profil',
        cohorts: [{ graduationYear: 2027, relation: 'student' }],
        emails: ['feil@example.test'],
        status: 'active',
      })
      await createInvitation(db, admin, { email: 'feil@example.test', personId })
      expect(await denial(deleteProfile(db, storage, admin, { personId, reason: '' }))).toMatch(
        /begrunnelse/,
      )
      expect(
        await denial(
          deleteProfile(db, storage, admin, { personId: ola!.personId!, reason: 'Feil' }),
        ),
      ).toMatch(/tatt i bruk/)
      await deleteProfile(db, storage, admin, { personId, reason: 'Lagt inn to ganger' })
      expect(await db.select().from(schema.person).where(eq(schema.person.id, personId))).toEqual(
        [],
      )
      const [invite] = await db.select().from(schema.invitation)
      expect(invite!.revokedAt).not.toBeNull()
      const [logged] = await listAuditEvents(db, admin, { actionPrefix: 'profile.delete' })
      expect(logged!.details).toMatchObject({
        fullName: 'Feil Profil',
        reason: 'Lagt inn to ganger',
        revokedInvitations: 1,
      })
    })

    it('fyller tom kontaktinfo på profiler uten konto, men endrer den aldri', async () => {
      const { personId } = await createProfile(db, admin, {
        fullName: 'Uten Kontakt',
        cohorts: [],
        emails: [],
        status: 'active',
      })
      expect(
        await fillUnclaimedContact(db, admin, personId, {
          contactEmail: 'ny@example.test',
          phone: '+47 900 00 000',
        }),
      ).toEqual({ filled: ['contactEmail', 'phone'] })
      expect(
        await denial(fillUnclaimedContact(db, admin, personId, { phone: '+47 911 11 111' })),
      ).toMatch(/har allerede et telefonnummer/)
      expect(
        await denial(fillUnclaimedContact(db, admin, ola!.personId!, { phone: '+47 911 11 111' })),
      ).toMatch(/tatt i bruk/)
      expect((await getPersonAdmin(db, admin, personId)).emails.map((e) => e.email)).toEqual([
        'ny@example.test',
      ])
    })

    it('kilder legges til for gyldige felt, og en ny runde oppdaterer i stedet for å doble', async () => {
      const { personId } = await createProfile(db, admin, {
        fullName: 'Med Kilder',
        cohorts: [],
        emails: [],
        status: 'active',
      })
      const source = {
        field: 'bio',
        url: 'https://www.example.no/om',
        confidence: 'medium' as const,
      }
      await addFieldSources(db, admin, {
        entityType: 'person',
        entityId: personId,
        sources: [source],
      })
      await addFieldSources(db, admin, {
        entityType: 'person',
        entityId: personId,
        sources: [{ ...source, confidence: 'high' }],
        reviewed: true,
      })
      const rows = await db.select().from(schema.fieldSource)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ sourceLabel: 'example.no', confidence: 'high' })
      expect(rows[0]!.reviewedAt).not.toBeNull()
      expect(
        await denial(
          addFieldSources(db, admin, {
            entityType: 'person',
            entityId: personId,
            sources: [{ field: 'phone', label: 'x', confidence: 'high' }],
          }),
        ),
      ).toMatch(/kan ikke ha kilde/)
      expect(
        await denial(
          addFieldSources(db, ola, { entityType: 'person', entityId: personId, sources: [source] }),
        ),
      ).toBe('forbidden')
    })

    it('sitater legges inn med kobling til person og selskap, og kan kobles om', async () => {
      const [company] = await db
        .insert(schema.company)
        .values({ slug: 'syrlig', name: 'Syrlig' })
        .returning()
      const { quoteId } = await addQuote(db, admin, {
        text: 'Vi startet på ES.',
        speakerName: 'Ola',
        speakerRole: null,
        date: '2024-05-01',
        sourceUrl: 'https://www.adressa.no/sak',
        sourceLabel: null,
        confidence: 'high',
        personId: ola!.personId,
        companyId: company!.id,
      })
      await setQuoteLinks(db, admin, quoteId, { personId: null })
      const [row] = await db.select().from(schema.quote)
      expect(row).toMatchObject({ personId: null, companyId: company!.id })
      const actions = (await listAuditEvents(db, admin, { actionPrefix: 'quote.' })).map(
        (e) => e.action,
      )
      expect(actions).toEqual(['quote.edit', 'quote.add'])
      expect(
        await denial(
          addQuote(db, ola, {
            text: 'x',
            speakerName: 'Ola',
            speakerRole: null,
            date: null,
            sourceUrl: null,
            sourceLabel: null,
            confidence: 'high',
          }),
        ),
      ).toBe('forbidden')
    })

    it('personindeksen viser hva som mangler, uten kontaktinfo', async () => {
      await createProfileBatch(db, storage, admin, [
        { fullName: 'Har Bio', bio: 'Noe', cohorts: [{ graduationYear: 2027 }], phone: '41234567' },
      ])
      const index = await listPeopleIndex(db, admin)
      const row = index.find((p) => p.fullName === 'Har Bio')!
      expect(row.has).toMatchObject({ bio: true, photo: false, phone: true, linkedin: false })
      expect(JSON.stringify(row)).not.toContain('41234567')
      expect(row.cohorts).toEqual([{ graduationYear: 2027, relation: 'student' }])
      expect(await db.$count(schema.auditEvent, and(isNotNull(schema.auditEvent.apiTokenId)))).toBe(
        0,
      )
    })
  })
})
