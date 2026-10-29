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
  addComment,
  createDiskStorage,
  createPost,
  decideMembership,
  getEditableProfile,
  getPost,
  getProfile,
  grantRoleAsOperator,
  listActiveMembers,
  listCohorts,
  listCompanies,
  listPosts,
  loadViewer,
  NotFoundError,
  readProfilePhoto,
  removeProfilePhoto,
  searchPeople,
  setProfilePhoto,
  updateProfile,
  viewerCard,
  type ObjectStorage,
  type ProfilePhoto,
  type Viewer,
} from '../src/index.ts'

loadRootEnv()
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

/** Et gyldig bilde å laste opp. */
const jpeg = (colour = { r: 240, g: 120, b: 20 }) =>
  sharp({ create: { width: 640, height: 480, channels: 3, background: colour } })
    .jpeg()
    .toBuffer()

/** Filnavnet i adressen, slik bilderuten i appen får det. */
const fileOf = (url: string) => url.replace('/api/bilder/', '')

describe.skipIf(!url)('profilbilder', () => {
  let db: Db
  let dir: string
  let storage: ObjectStorage
  let admin: Viewer
  let adminWithout2fa: Viewer
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
      sql`truncate ${schema.postVote}, ${schema.comment}, ${schema.post}, ${schema.auditEvent}, ${schema.experience}, ${schema.membership}, ${schema.personCohort}, ${schema.personEmail}, ${schema.person}, ${schema.cohort}, ${schema.user} cascade`,
    )
    dir = await mkdtemp(join(tmpdir(), 'esaf-bilder-'))
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
  afterEach(() => rm(dir, { recursive: true, force: true }))

  /** Filene som ligger i lagringen nå. */
  const stored = async () =>
    (await readdir(join(dir, 'profilbilder')).catch(() => [] as string[])).sort()

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

  it('medlemmer kan laste opp, bytte og fjerne sitt eget bilde', async () => {
    const first = await setProfilePhoto(db, storage, ola, ola!.personId!, await jpeg())
    expect(first.small).toMatch(/^\/api\/bilder\/[A-Za-z0-9_-]{22}-192\.webp$/)
    expect(first.large).toMatch(/^\/api\/bilder\/[A-Za-z0-9_-]{22}-512\.webp$/)
    expect(await stored()).toEqual([fileOf(first.small), fileOf(first.large)].sort())
    expect((await getProfile(db, kari, ola!.personId!)).photo).toEqual(first)
    const served = await readProfilePhoto(db, storage, kari, fileOf(first.large))
    expect(await sharp(served).metadata()).toMatchObject({ format: 'webp', width: 480 })

    // Nytt bilde får ny adresse, og det gamle slettes.
    const second = await setProfilePhoto(db, storage, ola, ola!.personId!, await jpeg())
    expect(second.small).not.toBe(first.small)
    expect(await stored()).toEqual([fileOf(second.small), fileOf(second.large)].sort())
    expect(await denial(readProfilePhoto(db, storage, kari, fileOf(first.small)))).toBe('not_found')

    await removeProfilePhoto(db, storage, ola, ola!.personId!)
    expect(await stored()).toEqual([])
    expect((await getProfile(db, kari, ola!.personId!)).photo).toBeNull()
    expect(await denial(readProfilePhoto(db, storage, kari, fileOf(second.small)))).toBe(
      'not_found',
    )
    // Å fjerne noe som ikke finnes, er ingen feil.
    await removeProfilePhoto(db, storage, ola, ola!.personId!)

    // Egne endringer logges ikke, på samme måte som egne profilendringer.
    expect(
      await db
        .select()
        .from(schema.auditEvent)
        .where(sql`action like 'profile.%'`),
    ).toEqual([])
  })

  it('bare eieren og admins med tofaktor kan endre bildet', async () => {
    const file = await jpeg()
    expect(await denial(setProfilePhoto(db, storage, kari, ola!.personId!, file))).toBe('forbidden')
    expect(await denial(setProfilePhoto(db, storage, adminWithout2fa, ola!.personId!, file))).toBe(
      'strong_auth_required',
    )
    expect(await denial(setProfilePhoto(db, storage, null, ola!.personId!, file))).toBe(
      'unauthenticated',
    )
    expect(await denial(setProfilePhoto(db, storage, pending, pending!.personId!, file))).toBe(
      'not_member',
    )
    expect(await stored()).toEqual([])

    await setProfilePhoto(db, storage, ola, ola!.personId!, file)
    expect(await denial(removeProfilePhoto(db, storage, kari, ola!.personId!))).toBe('forbidden')
    expect(await denial(removeProfilePhoto(db, storage, adminWithout2fa, ola!.personId!))).toBe(
      'strong_auth_required',
    )
    expect(await stored()).toHaveLength(2)
  })

  it('admin kan endre bildet til andre, og det logges', async () => {
    const photo = await setProfilePhoto(db, storage, admin, ola!.personId!, await jpeg())
    expect((await getProfile(db, kari, ola!.personId!)).photo).toEqual(photo)
    await setProfilePhoto(db, storage, admin, ola!.personId!, await jpeg())
    await removeProfilePhoto(db, storage, admin, ola!.personId!)
    expect(await stored()).toEqual([])

    const uploads = await audit('profile.admin_photo_upload')
    expect(uploads.map((e) => e.details)).toEqual([{ replaced: false }, { replaced: true }])
    expect(uploads.every((e) => e.subjectPersonId === ola!.personId)).toBe(true)
    expect(uploads.every((e) => e.actorPersonId === admin!.personId)).toBe(true)
    expect(await audit('profile.admin_photo_remove')).toMatchObject([
      { actorPersonId: admin!.personId, subjectPersonId: ola!.personId },
    ])

    // Søkere som ikke er godkjent, og personer som ikke finnes, får ikke bilde.
    expect(
      await denial(setProfilePhoto(db, storage, admin, pending!.personId!, await jpeg())),
    ).toBe('not_found')
    expect(await denial(setProfilePhoto(db, storage, admin, randomUUID(), await jpeg()))).toBe(
      'not_found',
    )
    expect(await denial(removeProfilePhoto(db, storage, admin, randomUUID()))).toBe('not_found')
    expect(await stored()).toEqual([])
  })

  it('bildene vises bare for aktive medlemmer, og bare så lenge de er i bruk', async () => {
    const photo = await setProfilePhoto(db, storage, ola, ola!.personId!, await jpeg())
    const name = fileOf(photo.small)
    expect(await denial(readProfilePhoto(db, storage, null, name))).toBe('unauthenticated')
    expect(await denial(readProfilePhoto(db, storage, pending, name))).toBe('not_member')
    expect(await denial(readProfilePhoto(db, storage, kari, name))).toBe('allowed')

    const key = name.slice(0, 22)
    for (const bad of [
      'x',
      `../${name}`,
      `${key}-999.webp`,
      `${key}-192.png`,
      `${key}-192.webp.tmp`,
      `${'A'.repeat(22)}-192.webp`,
    ]) {
      expect(await denial(readProfilePhoto(db, storage, kari, bad))).toBe('not_found')
    }

    // En fil som ligger igjen i lagringen uten at noen bruker den, serveres ikke.
    const orphan = 'B'.repeat(22)
    await storage.put(`profilbilder/${orphan}-192.webp`, await jpeg(), 'image/webp')
    expect(await denial(readProfilePhoto(db, storage, kari, `${orphan}-192.webp`))).toBe(
      'not_found',
    )

    // Deaktiverte medlemmer ser ikke bildene lenger.
    await db
      .update(schema.membership)
      .set({ status: 'inactive' })
      .where(eq(schema.membership.personId, kari!.personId!))
    const deactivated = await loadViewer(db, kari!.userId)
    expect(await denial(readProfilePhoto(db, storage, deactivated, name))).toBe('not_member')
  })

  it('bildet følger med overalt der personen vises', async () => {
    const photo = await setProfilePhoto(db, storage, ola, ola!.personId!, await jpeg())
    const [cohort] = await db.insert(schema.cohort).values({ graduationYear: 2015 }).returning()
    await db.insert(schema.personCohort).values({ personId: ola!.personId!, cohortId: cohort!.id })
    await updateProfile(db, ola, ola!.personId!, {
      fullName: 'Ola Nordmann',
      city: '',
      studyBackground: '',
      esCompany: 'Fjordflow',
      bio: '',
      expertise: [],
      industries: [],
      experience: [
        { company: 'Acme', title: 'CTO', startYear: 2020, endYear: null, founder: true },
      ],
      linkedinUrl: '',
      contactEmail: '',
      contactEmailVisible: false,
      phone: '',
      phoneVisible: false,
    })
    const postId = await createPost(db, ola, {
      channel: 'generelt',
      title: 'Hei alle',
      body: '',
      url: '',
    })
    await addComment(db, ola, postId, { body: 'Første!' })

    const all: (ProfilePhoto | null | undefined)[] = [
      (await listActiveMembers(db, kari)).find((m) => m.personId === ola!.personId)?.photo,
      (await searchPeople(db, kari, 'Ola'))[0]?.photo,
      (await listPosts(db, kari))[0]?.author.photo,
      (await getPost(db, kari, postId)).commentList[0]?.author.photo,
      (await listCohorts(db, kari)).find((c) => c.graduationYear === 2015)?.preview[0]?.photo,
      (await listCompanies(db, kari)).find((c) => c.name === 'Acme')?.people[0]?.photo,
      (await listCompanies(db, kari)).find((c) => c.name === 'Fjordflow')?.people[0]?.photo,
      (await viewerCard(db, ola))?.photo,
      (await getEditableProfile(db, ola, ola!.personId!)).photo,
    ]
    expect(all).toEqual(all.map(() => photo))
    // Uten bilde er det `null`, så appen viser initialer.
    expect((await getProfile(db, ola, kari!.personId!)).photo).toBeNull()
  })

  it('feil i lagringen gir verken halve bilder eller døde lenker', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // Den store størrelsen feiler: den lille som rakk å bli lagret, ryddes bort.
      const failingPut: ObjectStorage = {
        ...storage,
        put: (key, body, type) =>
          key.endsWith('-512.webp')
            ? Promise.reject(new Error('lagringen er nede'))
            : storage.put(key, body, type),
      }
      await expect(
        setProfilePhoto(db, failingPut, ola, ola!.personId!, await jpeg()),
      ).rejects.toThrow('lagringen er nede')
      expect(await stored()).toEqual([])
      expect((await getProfile(db, kari, ola!.personId!)).photo).toBeNull()

      // Medlemmet blir deaktivert mens en admin laster opp: filene ryddes bort.
      const raced: ObjectStorage = {
        ...storage,
        put: async (key, body, type) => {
          await db
            .update(schema.membership)
            .set({ status: 'inactive' })
            .where(eq(schema.membership.personId, ola!.personId!))
          await storage.put(key, body, type)
        },
      }
      expect(await denial(setProfilePhoto(db, raced, admin, ola!.personId!, await jpeg()))).toBe(
        'not_found',
      )
      expect(await stored()).toEqual([])
      await db
        .update(schema.membership)
        .set({ status: 'active' })
        .where(eq(schema.membership.personId, ola!.personId!))

      // Sletting av det gamle bildet feiler: byttet går likevel gjennom, og det
      // gamle serveres ikke lenger, selv om fila ligger igjen.
      const old = await setProfilePhoto(db, storage, ola, ola!.personId!, await jpeg())
      const stuck: ObjectStorage = {
        ...storage,
        delete: () => Promise.reject(new Error('kunne ikke slette')),
      }
      const replaced = await setProfilePhoto(db, stuck, ola, ola!.personId!, await jpeg())
      expect((await getProfile(db, kari, ola!.personId!)).photo).toEqual(replaced)
      expect(await stored()).toHaveLength(4)
      expect(await denial(readProfilePhoto(db, storage, kari, fileOf(old.small)))).toBe('not_found')
      expect(errors).toHaveBeenCalled()
    } finally {
      errors.mockRestore()
    }
  })

  it('ugyldige filer avvises før noe lagres', async () => {
    await expect(
      setProfilePhoto(db, storage, ola, ola!.personId!, new TextEncoder().encode('<svg/>')),
    ).rejects.toThrow('JPEG, PNG eller WebP')
    expect(await stored()).toEqual([])
    expect((await getProfile(db, kari, ola!.personId!)).photo).toBeNull()
  })
})
