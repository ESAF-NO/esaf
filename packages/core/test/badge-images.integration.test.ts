import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb, loadRootEnv, runMigrations, schema, type Db } from '@esaf/db'
import { eq, sql } from 'drizzle-orm'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AccessDeniedError,
  assertCanChangeBadgeImage,
  createBadge,
  createDiskStorage,
  decideMembership,
  deleteBadge,
  DomainError,
  getBadgeForAdmin,
  grantRoleAsOperator,
  listBadgesForAdmin,
  loadProfileBadges,
  loadViewer,
  NotFoundError,
  processBadgeImage,
  readBadgeImage,
  removeBadgeImage,
  setBadgeImage,
  awardBadge,
  type BadgeImage,
  type ObjectStorage,
  type Viewer,
} from '../src/index.ts'

loadRootEnv()
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

/** Et gyldig bilde å laste opp: bredt, med en gjennomsiktig venstre halvdel. */
const png = async (width = 600, height = 300) => {
  const half = await sharp({
    create: {
      width: Math.ceil(width / 2),
      height,
      channels: 4,
      background: { r: 240, g: 120, b: 20, alpha: 1 },
    },
  })
    .png()
    .toBuffer()
  return sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: half, left: Math.floor(width / 2), top: 0 }])
    .png()
    .toBuffer()
}

/** Filnavnet i adressen, slik bilderuten i appen får det. */
const fileOf = (url: string) => url.replace('/api/merkebilder/', '')

describe('behandlingen av merkebilder', () => {
  it('beskjærer til kvadrat fra midten, beholder gjennomsiktighet og lagrer WebP', async () => {
    const { small, large } = await processBadgeImage(await png())
    const [big, little] = await Promise.all([sharp(large).metadata(), sharp(small).metadata()])
    expect(big).toMatchObject({ format: 'webp', width: 256, height: 256, hasAlpha: true })
    expect(little).toMatchObject({ format: 'webp', width: 96, height: 96 })
    // Midten av et bredt bilde: venstre del er gjennomsiktig, høyre er farget.
    const { data, info } = await sharp(large).raw().toBuffer({ resolveWithObject: true })
    const alphaAt = (x: number) => data[(128 * info.width + x) * info.channels + 3]
    expect(alphaAt(20)).toBe(0)
    expect(alphaAt(236)).toBe(255)
  })

  it('skalerer ikke opp, og avviser for små bilder og andre filer', async () => {
    const { large } = await processBadgeImage(await png(120, 100))
    expect(await sharp(large).metadata()).toMatchObject({ width: 100, height: 100 })
    await expect(processBadgeImage(await png(400, 95))).rejects.toThrow(DomainError)
    await expect(processBadgeImage(Buffer.from('<svg></svg>'))).rejects.toThrow(
      'Bildet må være JPEG, PNG eller WebP.',
    )
  })
})

describe.skipIf(!url)('merkebilder', () => {
  let db: Db
  let dir: string
  let storage: ObjectStorage
  let admin: Viewer
  let weakAdmin: Viewer
  let ola: Viewer
  let pending: Viewer

  const files = async () => {
    try {
      return await readdir(join(dir, 'merkebilder'))
    } catch {
      return []
    }
  }

  async function account(name: string) {
    const id = randomUUID()
    await db
      .insert(schema.user)
      .values({ id, name, email: `${name.toLowerCase()}@example.test`, emailVerified: true })
    return id
  }

  const newBadge = (name = 'Ildsjel', publish = false) =>
    createBadge(
      db,
      admin,
      {
        name,
        description: 'Gjorde en ekstra innsats.',
        icon: 'flame',
        color: 'brand',
        rule: { kind: 'manual' },
      },
      { publish },
    )

  beforeAll(async () => {
    await runMigrations(url!)
    db = createDb(url!)
    dir = await mkdtemp(join(tmpdir(), 'esaf-merkebilder-'))
    storage = createDiskStorage(dir)
  })
  afterAll(async () => {
    await db?.close()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    await db.execute(
      sql`truncate ${schema.badge}, ${schema.notification}, ${schema.auditEvent}, ${schema.membership}, ${schema.person}, ${schema.user} cascade`,
    )
    await rm(join(dir, 'merkebilder'), { recursive: true, force: true })
    await account('Admin')
    await grantRoleAsOperator(db, { email: 'admin@example.test', reason: 'test', role: 'admin' })
    await db
      .update(schema.user)
      .set({ twoFactorEnabled: true })
      .where(eq(schema.user.email, 'admin@example.test'))
    admin = await loadViewer(db, (await db.select().from(schema.user))[0]!.id)
    weakAdmin = { ...admin!, twoFactorEnabled: false, passkeySession: false }
    const member = await loadViewer(db, await account('Ola'))
    await decideMembership(db, admin, { personId: member!.personId!, decision: 'approve' })
    ola = await loadViewer(db, member!.userId)
    pending = await loadViewer(db, await account('Kari'))
  })

  async function denial(promise: Promise<unknown>) {
    try {
      await promise
    } catch (error) {
      if (error instanceof AccessDeniedError) return error.reason
      throw error
    }
    return 'ingen feil'
  }

  it('vises på merket for medlemmene, og ikonet beholdes', async () => {
    const { id } = await newBadge('Ildsjel', true)
    await awardBadge(db, admin, id, { personIds: [ola!.personId!] })
    const image = await setBadgeImage(db, storage, admin, id, await png())
    expect(image.small).toMatch(/^\/api\/merkebilder\/[\w-]{22}-96\.webp$/)
    expect(image.large).toMatch(/^\/api\/merkebilder\/[\w-]{22}-256\.webp$/)

    const { badges } = await loadProfileBadges(db, ola, ola!.personId!)
    expect(badges[0]).toMatchObject({ icon: 'flame', image })
    // Adressene er nok: verken nøkkelen eller regelen skal til medlemmene.
    expect(badges[0]).not.toHaveProperty('imageKey')
    expect(badges[0]).not.toHaveProperty('rule')

    const [listed] = await listBadgesForAdmin(db, admin)
    expect(listed).toMatchObject({ image })
    expect(listed).not.toHaveProperty('imageKey')
    expect((await getBadgeForAdmin(db, admin, id)).image).toEqual(image)
  })

  it('bare aktive medlemmer får bildet, og bare så lenge nøkkelen står på et merke', async () => {
    const { id } = await newBadge()
    const image = await setBadgeImage(db, storage, admin, id, await png())
    const body = await readBadgeImage(db, storage, ola, fileOf(image.large))
    expect(await sharp(body).metadata()).toMatchObject({ format: 'webp', width: 256 })

    for (const viewer of [null, pending]) {
      await expect(readBadgeImage(db, storage, viewer, fileOf(image.small))).rejects.toThrow(
        AccessDeniedError,
      )
    }
    for (const name of [
      'nei.webp',
      '../../hemmelig.webp',
      fileOf(image.small).replace('96', '97'),
    ]) {
      await expect(readBadgeImage(db, storage, ola, name)).rejects.toThrow(NotFoundError)
    }

    // Filen kan ligge igjen hvis slettingen feilet, men serveres likevel ikke.
    vi.spyOn(storage, 'delete').mockResolvedValueOnce().mockResolvedValueOnce()
    await removeBadgeImage(db, storage, admin, id)
    vi.restoreAllMocks()
    await expect(readBadgeImage(db, storage, ola, fileOf(image.small))).rejects.toThrow(
      NotFoundError,
    )
  })

  it('sletter de gamle filene når bildet byttes, fjernes eller merket slettes', async () => {
    const { id } = await newBadge()
    const first = await setBadgeImage(db, storage, admin, id, await png())
    expect(await files()).toHaveLength(2)

    const second: BadgeImage = await setBadgeImage(db, storage, admin, id, await png(500, 500))
    expect(second.small).not.toBe(first.small)
    expect((await files()).sort()).toEqual([fileOf(second.large), fileOf(second.small)].sort())

    await removeBadgeImage(db, storage, admin, id)
    expect(await files()).toEqual([])
    expect((await getBadgeForAdmin(db, admin, id)).image).toBeNull()
    // Å fjerne et bilde som ikke finnes, gjør ingenting og logges ikke.
    await removeBadgeImage(db, storage, admin, id)

    await setBadgeImage(db, storage, admin, id, await png())
    await deleteBadge(db, storage, admin, id)
    expect(await files()).toEqual([])

    const actions = await db
      .select({ action: schema.auditEvent.action, details: schema.auditEvent.details })
      .from(schema.auditEvent)
      .where(sql`${schema.auditEvent.action} like 'badge.image_%'`)
    expect(actions.map((a) => a.action).sort()).toEqual([
      'badge.image_remove',
      'badge.image_upload',
      'badge.image_upload',
      'badge.image_upload',
    ])
    expect(actions.filter((a) => a.details?.replaced === true)).toHaveLength(1)
  })

  it('rydder opp filene hvis merket forsvinner mens bildet behandles', async () => {
    const { id } = await newBadge()
    const file = await png()
    const put = storage.put.bind(storage)
    vi.spyOn(storage, 'put').mockImplementation(async (...args) => {
      await put(...args)
      await db.delete(schema.badge).where(eq(schema.badge.id, id))
    })
    await expect(setBadgeImage(db, storage, admin, id, file)).rejects.toThrow(NotFoundError)
    vi.restoreAllMocks()
    expect(await files()).toEqual([])
  })

  it('krever badges.manage og sterk innlogging, før fila behandles', async () => {
    const { id } = await newBadge()
    const file = await png()
    const calls: [string, (v: Viewer) => Promise<unknown>][] = [
      ['assertCanChangeBadgeImage', (v) => assertCanChangeBadgeImage(db, v, id)],
      ['setBadgeImage', (v) => setBadgeImage(db, storage, v, id, file)],
      ['removeBadgeImage', (v) => removeBadgeImage(db, storage, v, id)],
    ]
    for (const [name, call] of calls) {
      expect([name, await denial(call(ola))]).toEqual([name, 'forbidden'])
      expect([name, await denial(call(weakAdmin))]).toEqual([name, 'strong_auth_required'])
      expect([name, await denial(call(null))]).toEqual([name, 'unauthenticated'])
    }
    expect(await files()).toEqual([])

    for (const missing of [randomUUID(), 'ikke-en-id']) {
      await expect(assertCanChangeBadgeImage(db, admin, missing)).rejects.toThrow(NotFoundError)
      await expect(setBadgeImage(db, storage, admin, missing, file)).rejects.toThrow(NotFoundError)
    }
  })
})
