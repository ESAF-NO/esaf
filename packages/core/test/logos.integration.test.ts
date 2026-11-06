import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb, loadRootEnv, runMigrations, schema, type Db } from '@esaf/db'
import { eq, sql } from 'drizzle-orm'
import sharp from 'sharp'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AccessDeniedError,
  assertCanChangeLogo,
  createDiskStorage,
  decideMembership,
  getCohortPage,
  getCompany,
  getEditableCompany,
  getProfile,
  grantRoleAsOperator,
  listCompanies,
  loadViewer,
  mergeCompanies,
  NotFoundError,
  readCompanyLogo,
  removeCompanyLogo,
  searchCompanies,
  setCompanyLogo,
  updateProfile,
  type CompanyLogoUrls,
  type ExperienceInput,
  type ObjectStorage,
  type Viewer,
} from '../src/index.ts'

loadRootEnv()
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

/** En gyldig logo å laste opp: bred og med gjennomsiktighet. */
const png = (colour = { r: 240, g: 120, b: 20, alpha: 1 }) =>
  sharp({ create: { width: 600, height: 200, channels: 4, background: colour } })
    .png()
    .toBuffer()

/** Filnavnet i adressen, slik logoruten i appen får det. */
const fileOf = (url: string) => url.replace('/api/logoer/', '')

const job = (company: string, more: Partial<ExperienceInput> = {}): ExperienceInput => ({
  company,
  title: null,
  startYear: null,
  endYear: null,
  founder: false,
  ...more,
})

describe.skipIf(!url)('selskapslogoer', () => {
  let db: Db
  let dir: string
  let storage: ObjectStorage
  let admin: Viewer
  let adminWithout2fa: Viewer
  let ola: Viewer
  let kari: Viewer
  let tidligere: Viewer
  let pending: Viewer
  let syrlig: string

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

  async function member(name: string) {
    const v = await loadViewer(db, await account(name))
    await decideMembership(db, admin, { personId: v!.personId!, decision: 'approve' })
    return loadViewer(db, v!.userId)
  }

  /** Lagrer erfaring (og eventuelt ES-selskap) på egen profil. */
  async function work(viewer: Viewer, experience: ExperienceInput[], esCompany = '') {
    const [me] = await db
      .select({ fullName: schema.person.fullName })
      .from(schema.person)
      .where(eq(schema.person.id, viewer!.personId!))
    await updateProfile(db, viewer, viewer!.personId!, {
      fullName: me!.fullName,
      city: '',
      studyBackground: '',
      esCompany,
      bio: '',
      expertise: [],
      industries: [],
      experience,
      linkedinUrl: '',
      contactEmail: '',
      contactEmailVisible: false,
      phone: '',
      phoneVisible: false,
    })
  }

  async function companyId(slug: string) {
    const [row] = await db
      .select({ id: schema.company.id })
      .from(schema.company)
      .where(eq(schema.company.slug, slug))
    return row!.id
  }

  beforeEach(async () => {
    await db.execute(
      sql`truncate ${schema.auditEvent}, ${schema.experience}, ${schema.membership}, ${schema.personCohort}, ${schema.person}, ${schema.cohort}, ${schema.user}, ${schema.company} cascade`,
    )
    dir = await mkdtemp(join(tmpdir(), 'esaf-logoer-'))
    storage = createDiskStorage(dir)

    const adminId = await account('Admin')
    await grantRoleAsOperator(db, { email: 'admin@example.test', reason: 'test', role: 'admin' })
    await db
      .update(schema.user)
      .set({ twoFactorEnabled: true })
      .where(eq(schema.user.email, 'admin@example.test'))
    admin = await loadViewer(db, adminId)
    const otherAdminId = await account('Uten2fa')
    await grantRoleAsOperator(db, { email: 'uten2fa@example.test', reason: 'test', role: 'admin' })
    adminWithout2fa = await loadViewer(db, otherAdminId)

    ola = await member('Ola')
    kari = await member('Kari')
    tidligere = await member('Tidligere')
    pending = await loadViewer(db, await account('Ventende'))

    await work(ola, [job('Syrlig', { founder: true, startYear: 2016 })])
    await work(tidligere, [job('Syrlig', { startYear: 2017, endYear: 2019 })])
    syrlig = await companyId('syrlig')
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  /** Filene som ligger i lagringen nå. */
  const stored = async () => (await readdir(join(dir, 'logoer')).catch(() => [] as string[])).sort()

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

  const audit = (action: string) =>
    db.select().from(schema.auditEvent).where(eq(schema.auditEvent.action, action))

  async function page(viewer: Viewer, slug = 'syrlig') {
    const found = await getCompany(db, viewer, slug)
    if ('movedTo' in found) throw new Error(`Flyttet til ${found.movedTo}`)
    return found
  }

  async function editable(viewer: Viewer) {
    const found = await getEditableCompany(db, viewer, 'syrlig')
    if ('movedTo' in found) throw new Error(`Flyttet til ${found.movedTo}`)
    return found
  }

  it('gründeren kan laste opp, bytte og fjerne logoen', async () => {
    const first = await setCompanyLogo(db, storage, ola, syrlig, await png())
    expect(first.small).toMatch(/^\/api\/logoer\/[A-Za-z0-9_-]{22}-64\.webp$/)
    expect(first.large).toMatch(/^\/api\/logoer\/[A-Za-z0-9_-]{22}-256\.webp$/)
    expect(await stored()).toEqual([fileOf(first.small), fileOf(first.large)].sort())
    expect((await page(kari)).logo).toEqual(first)
    const served = await readCompanyLogo(db, storage, kari, fileOf(first.large))
    expect(await sharp(served).metadata()).toMatchObject({
      format: 'webp',
      width: 256,
      height: 256,
      hasAlpha: true,
    })

    // Ny logo får ny adresse, og den gamle slettes.
    const second = await setCompanyLogo(db, storage, ola, syrlig, await png())
    expect(second.small).not.toBe(first.small)
    expect(await stored()).toEqual([fileOf(second.small), fileOf(second.large)].sort())
    expect(await denial(readCompanyLogo(db, storage, kari, fileOf(first.small)))).toBe('not_found')

    await removeCompanyLogo(db, storage, ola, syrlig)
    expect(await stored()).toEqual([])
    expect((await page(kari)).logo).toBeNull()
    expect(await denial(readCompanyLogo(db, storage, kari, fileOf(second.small)))).toBe('not_found')
    // Å fjerne noe som ikke finnes, er ingen feil.
    await removeCompanyLogo(db, storage, ola, syrlig)

    // Endringer fra dem som er knyttet til selskapet, logges ikke, som annen redigering.
    expect(
      await db
        .select()
        .from(schema.auditEvent)
        .where(sql`action like 'company.%'`),
    ).toEqual([])
  })

  it('bare de som kan redigere selskapet, kan endre logoen', async () => {
    const file = await png()
    // ES-teamet kan, som gründeren (testen over).
    await work(kari, [], 'Syrlig')
    await setCompanyLogo(db, storage, kari, syrlig, file)
    const annen = await member('Annen')
    await setCompanyLogo(db, storage, tidligere, syrlig, file)
    expect(await denial(setCompanyLogo(db, storage, annen, syrlig, file))).toBe('forbidden')
    expect(await denial(removeCompanyLogo(db, storage, annen, syrlig))).toBe('forbidden')
    expect(await denial(assertCanChangeLogo(db, annen, syrlig))).toBe('forbidden')
    expect(await denial(setCompanyLogo(db, storage, adminWithout2fa, syrlig, file))).toBe(
      'strong_auth_required',
    )
    expect(await denial(removeCompanyLogo(db, storage, adminWithout2fa, syrlig))).toBe(
      'strong_auth_required',
    )
    expect(await denial(setCompanyLogo(db, storage, null, syrlig, file))).toBe('unauthenticated')
    expect(await denial(setCompanyLogo(db, storage, pending, syrlig, file))).toBe('not_member')
    expect(await denial(setCompanyLogo(db, storage, ola, randomUUID(), file))).toBe('not_found')
    expect(await stored()).toHaveLength(2)
    expect((await page(kari)).logo).not.toBeNull()
  })

  it('admins kan endre logoen til alle selskaper, og det logges', async () => {
    const logo = await setCompanyLogo(db, storage, admin, syrlig, await png())
    expect((await editable(admin)).logo).toEqual(logo)
    await setCompanyLogo(db, storage, admin, syrlig, await png())
    await removeCompanyLogo(db, storage, admin, syrlig)
    expect(await stored()).toEqual([])

    const uploads = await audit('company.admin_logo_upload')
    expect(uploads.map((e) => e.details)).toEqual([
      { companyId: syrlig, slug: 'syrlig', name: 'Syrlig', replaced: false },
      { companyId: syrlig, slug: 'syrlig', name: 'Syrlig', replaced: true },
    ])
    expect(uploads.every((e) => e.actorPersonId === admin!.personId)).toBe(true)
    expect(await audit('company.admin_logo_remove')).toMatchObject([
      { actorPersonId: admin!.personId, details: { companyId: syrlig } },
    ])
    expect(await denial(removeCompanyLogo(db, storage, admin, randomUUID()))).toBe('not_found')
  })

  it('logoene vises bare for aktive medlemmer, og bare så lenge de er i bruk', async () => {
    const logo = await setCompanyLogo(db, storage, ola, syrlig, await png())
    const name = fileOf(logo.small)
    expect(await denial(readCompanyLogo(db, storage, null, name))).toBe('unauthenticated')
    expect(await denial(readCompanyLogo(db, storage, pending, name))).toBe('not_member')
    expect(await denial(readCompanyLogo(db, storage, kari, name))).toBe('allowed')

    const key = name.slice(0, 22)
    for (const bad of [
      'x',
      `../${name}`,
      `${key}-999.webp`,
      `${key}-192.webp`,
      `${key}-64.png`,
      `${key}-64.webp.tmp`,
      `${'A'.repeat(22)}-64.webp`,
    ]) {
      expect(await denial(readCompanyLogo(db, storage, kari, bad))).toBe('not_found')
    }

    // En fil som ligger igjen i lagringen uten at noe selskap bruker den, serveres ikke.
    const orphan = 'B'.repeat(22)
    await storage.put(`logoer/${orphan}-64.webp`, await png(), 'image/webp')
    expect(await denial(readCompanyLogo(db, storage, kari, `${orphan}-64.webp`))).toBe('not_found')

    // Deaktiverte medlemmer ser ikke logoene lenger.
    await db
      .update(schema.membership)
      .set({ status: 'inactive' })
      .where(eq(schema.membership.personId, kari!.personId!))
    const deactivated = await loadViewer(db, kari!.userId)
    expect(await denial(readCompanyLogo(db, storage, deactivated, name))).toBe('not_member')
  })

  it('logoen følger med overalt der selskapet vises', async () => {
    const logo = await setCompanyLogo(db, storage, ola, syrlig, await png())
    const [cohort] = await db.insert(schema.cohort).values({ graduationYear: 2015 }).returning()
    await db.insert(schema.personCohort).values({ personId: ola!.personId!, cohortId: cohort!.id })
    await work(ola, [job('Syrlig', { founder: true, startYear: 2016 })], 'Syrlig')

    const profile = await getProfile(db, kari, ola!.personId!)
    const all: (CompanyLogoUrls | null | undefined)[] = [
      (await listCompanies(db, kari)).find((c) => c.slug === 'syrlig')?.logo,
      (await page(kari)).logo,
      (await editable(ola)).logo,
      (await searchCompanies(db, kari, 'syrl'))[0]?.logo,
      profile.experience[0]?.companyLogo,
      profile.esCompanyLogo,
      (await getCohortPage(db, kari, 2015)).companies.find((c) => c.slug === 'syrlig')?.logo,
    ]
    expect(all).toEqual(all.map(() => logo))

    // Uten logo er det `null`, så appen viser bokstavflisen.
    await work(kari, [job('Fjordflow')])
    expect((await getProfile(db, ola, kari!.personId!)).experience[0]?.companyLogo).toBeNull()
    expect((await listCompanies(db, kari)).find((c) => c.slug === 'fjordflow')?.logo).toBeNull()
  })

  it('ved sammenslåing flyttes logoen, eller duplikatets slettes når begge har', async () => {
    await work(kari, [job('Syrlig AS')])
    await work(tidligere, [job('Syrlig Group')])
    const duplicate = await companyId('syrlig-as')
    const other = await companyId('syrlig-group')
    const moved = await setCompanyLogo(db, storage, kari, duplicate, await png())

    // Bare duplikatet har logo: den flyttes.
    await mergeCompanies(db, storage, admin, { sourceId: duplicate, targetId: syrlig })
    expect((await page(kari)).logo).toEqual(moved)
    expect(await stored()).toHaveLength(2)

    // Begge har logo: målets beholdes, og duplikatets filer slettes.
    await setCompanyLogo(db, storage, tidligere, other, await png())
    await mergeCompanies(db, storage, admin, { sourceId: other, targetId: syrlig })
    expect((await page(kari)).logo).toEqual(moved)
    expect(await stored()).toEqual([fileOf(moved.small), fileOf(moved.large)].sort())
  })

  it('feil i lagringen gir verken halve logoer eller døde lenker', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // Den store størrelsen feiler: den lille som rakk å bli lagret, ryddes bort.
      const failingPut: ObjectStorage = {
        ...storage,
        put: (key, body, type) =>
          key.endsWith('-256.webp')
            ? Promise.reject(new Error('lagringen er nede'))
            : storage.put(key, body, type),
      }
      await expect(setCompanyLogo(db, failingPut, ola, syrlig, await png())).rejects.toThrow(
        'lagringen er nede',
      )
      expect(await stored()).toEqual([])
      expect((await page(kari)).logo).toBeNull()

      // Gründeren slutter mens logoen behandles: filene ryddes bort.
      const raced: ObjectStorage = {
        ...storage,
        put: async (key, body, type) => {
          await db.delete(schema.experience).where(eq(schema.experience.personId, ola!.personId!))
          await storage.put(key, body, type)
        },
      }
      expect(await denial(setCompanyLogo(db, raced, ola, syrlig, await png()))).toBe('forbidden')
      expect(await stored()).toEqual([])
      await work(ola, [job('Syrlig', { founder: true })])

      // Sletting av den gamle logoen feiler: byttet går likevel gjennom, og den
      // gamle serveres ikke lenger, selv om fila ligger igjen.
      const old = await setCompanyLogo(db, storage, ola, syrlig, await png())
      const stuck: ObjectStorage = {
        ...storage,
        delete: () => Promise.reject(new Error('kunne ikke slette')),
      }
      const replaced = await setCompanyLogo(db, stuck, ola, syrlig, await png())
      expect((await page(kari)).logo).toEqual(replaced)
      expect(await stored()).toHaveLength(4)
      expect(await denial(readCompanyLogo(db, storage, kari, fileOf(old.small)))).toBe('not_found')
      expect(errors).toHaveBeenCalled()
    } finally {
      errors.mockRestore()
    }
  })

  it('ugyldige filer avvises før noe lagres, også SVG', async () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100"/></svg>',
    )
    await expect(setCompanyLogo(db, storage, ola, syrlig, svg)).rejects.toThrow(
      'JPEG, PNG eller WebP',
    )
    expect(await stored()).toEqual([])
    expect((await page(kari)).logo).toBeNull()
  })
})
