import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb, loadRootEnv, runMigrations, schema, type Db, type MemberRole } from '@esaf/db'
import { and, eq, isNull, sql } from 'drizzle-orm'
import sharp from 'sharp'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AccessDeniedError,
  addComment,
  ASSET_MAX_BYTES,
  cleanupAssets,
  createDiskStorage,
  createPost,
  deleteComment,
  deleteCompany,
  deleteEvent,
  deletePost,
  DomainError,
  getCompany,
  getEditablePost,
  getEvent,
  getPost,
  grantRoleAsOperator,
  listPosts,
  loadViewer,
  mergeCompanies,
  NotFoundError,
  readAsset,
  removeAsset,
  setOwnParticipation,
  updateComment,
  updatePost,
  uploadAsset,
  UploadLimitError,
  UPLOAD_LIMITS,
  type AssetTarget,
  type AssetView,
  type CompanyDetails,
  type ObjectStorage,
  type PostInput,
  type Viewer,
} from '../src/index.ts'

loadRootEnv()
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

/**
 * Som et bilde fra en mobil tatt på høykant: lagret liggende (2000 × 1000) med
 * EXIF-orientering 6, GPS-posisjon, opphavsrett og XMP.
 */
const phoneJpeg = () =>
  sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#2a6' } })
    .withMetadata({ orientation: 6 })
    .withExif({
      IFD0: { Copyright: 'Hemmelig hytte', Make: 'Testkamera' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '63/1 25/1 1234/100',
        GPSLongitudeRef: 'E',
        GPSLongitude: '10/1 23/1 0/1',
      },
    })
    .withXmp(
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Hemmelig fotograf</dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>',
    )
    .jpeg({ quality: 85 })
    .toBuffer()

const smallPng = () =>
  sharp({ create: { width: 64, height: 48, channels: 4, background: '#c33a' } })
    .png()
    .toBuffer()

const pdf = () => Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n')

/** Filnavnet i adressen, slik vedleggsruten i appen får det. */
const nameOf = (url: string) => url.replace('/api/vedlegg/', '')

describe.skipIf(!url)('vedlegg', () => {
  let db: Db
  let dir: string
  let storage: ObjectStorage
  let admin: Viewer
  let weakAdmin: Viewer
  let moderator: Viewer
  let ola: Viewer
  let kari: Viewer
  let pending: Viewer
  let typeId: string

  beforeAll(async () => {
    await runMigrations(url!)
    db = createDb(url!)
    typeId = (
      await db
        .select({ id: schema.eventType.id })
        .from(schema.eventType)
        .where(eq(schema.eventType.slug, 'esaf-helgen'))
    )[0]!.id
  })
  afterAll(() => db?.close())

  async function account(name: string, twoFactorEnabled: boolean) {
    const id = randomUUID()
    await db.insert(schema.user).values({
      id,
      name,
      email: `${name.toLowerCase()}@example.test`,
      emailVerified: true,
      twoFactorEnabled,
    })
    return id
  }

  async function withRole(name: string, role: MemberRole, twoFactorEnabled = role !== 'member') {
    const id = await account(name, twoFactorEnabled)
    await grantRoleAsOperator(db, {
      email: `${name.toLowerCase()}@example.test`,
      reason: 'test',
      role,
    })
    return loadViewer(db, id)
  }

  beforeEach(async () => {
    await db.execute(
      sql`truncate ${schema.asset}, ${schema.postVote}, ${schema.comment}, ${schema.post}, ${schema.event}, ${schema.auditEvent}, ${schema.experience}, ${schema.membership}, ${schema.personCohort}, ${schema.personEmail}, ${schema.person}, ${schema.cohort}, ${schema.user}, ${schema.company} cascade`,
    )
    dir = await mkdtemp(join(tmpdir(), 'esaf-vedlegg-'))
    storage = createDiskStorage(dir)
    admin = await withRole('Admin', 'admin')
    weakAdmin = await withRole('Svakadmin', 'admin', false)
    moderator = await withRole('Moderator', 'moderator')
    ola = await withRole('Ola', 'member')
    kari = await withRole('Kari', 'member')
    pending = await loadViewer(db, await account('Ventende', false))
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  /** Filene som ligger i lagringen nå, med mappe. */
  const stored = async () =>
    (await readdir(dir, { recursive: true, withFileTypes: true }))
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name).slice(dir.length + 1))
      .sort()

  const upload = (viewer: Viewer, target: AssetTarget, file: Uint8Array, name = 'fil.pdf') =>
    uploadAsset(db, storage, viewer, target, file, name)
  const read = (viewer: Viewer, view: AssetView, variant: 'small' | 'large' = 'large') =>
    readAsset(db, storage, viewer, nameOf(view.image ? view.image[variant] : view.url))

  async function denial(promise: Promise<unknown>) {
    try {
      await promise
      return 'allowed'
    } catch (error) {
      if (error instanceof AccessDeniedError) return error.reason
      if (error instanceof NotFoundError) return 'not_found'
      if (error instanceof UploadLimitError) return 'limit'
      if (error instanceof DomainError) return 'domain'
      throw error
    }
  }

  const audit = (action: string) =>
    db.select().from(schema.auditEvent).where(eq(schema.auditEvent.action, action))

  const rowOf = async (id: string) =>
    (await db.select().from(schema.asset).where(eq(schema.asset.id, id)))[0]!

  const question: PostInput = {
    channel: 'sporsmal',
    title: 'Hvem kan B2B-salg?',
    body: 'Hei',
    url: '',
  }

  async function pastEvent(startDate = '2020-09-04') {
    const [row] = await db
      .insert(schema.event)
      .values({ typeId, name: `ESAF-helgen ${randomUUID().slice(0, 4)}`, startDate })
      .returning({ id: schema.event.id })
    return row!.id
  }

  async function company(name = 'Acme') {
    const [row] = await db
      .insert(schema.company)
      .values({ slug: name.toLowerCase(), name, editedAt: new Date() })
      .returning({ id: schema.company.id, slug: schema.company.slug })
    return row!
  }

  describe('bilder', () => {
    it('roteres etter EXIF, mister all metadata (også GPS) og lagres i to størrelser uten beskjæring', async () => {
      const input = await phoneJpeg()
      const before = await sharp(input).metadata()
      expect(before.orientation).toBe(6)
      expect(before.exif?.includes(Buffer.from([0x25, 0x88]))).toBe(true) // GPS-IFD (0x8825)

      const view = await upload(ola, { purpose: 'post' }, input, 'IMG_1234.JPG')
      expect(view).toMatchObject({
        kind: 'image',
        name: 'IMG_1234.webp',
        contentType: 'image/webp',
        byteSize: input.byteLength,
        // Står på høykant etter rotering, og den lengste siden er 1600.
        width: 800,
        height: 1600,
        documentType: null,
        own: true,
      })
      expect(view.image!.small).toMatch(/^\/api\/vedlegg\/[A-Za-z0-9_-]{22}-400\.webp$/)
      expect(view.image!.large).toMatch(/^\/api\/vedlegg\/[A-Za-z0-9_-]{22}-1600\.webp$/)
      expect(await stored()).toHaveLength(2)
      expect((await stored()).every((f) => f.startsWith('vedlegg/'))).toBe(true)

      for (const [variant, size] of [
        ['large', [800, 1600]],
        ['small', [200, 400]],
      ] as const) {
        const file = await read(ola, view, variant)
        expect(file).toMatchObject({ kind: 'image', contentType: 'image/webp' })
        const meta = await sharp(file.body).metadata()
        expect([meta.width, meta.height]).toEqual(size)
        expect(meta.format).toBe('webp')
        expect(meta.exif).toBeUndefined()
        expect(meta.xmp).toBeUndefined()
        expect(meta.icc).toBeUndefined()
        expect(meta.orientation).toBeUndefined()
        expect(Buffer.from(file.body).includes('Hemmelig')).toBe(false)
      }
      const row = await rowOf(view.id)
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(Object.keys(row.storageKeys).sort()).toEqual(['1600', '400'])
    })

    it('skaleres aldri opp, og gjennomsiktighet beholdes', async () => {
      const view = await upload(ola, { purpose: 'post' }, await smallPng(), 'logo.png')
      expect([view.width, view.height]).toEqual([64, 48])
      const meta = await sharp((await read(ola, view, 'small')).body).metadata()
      expect(meta).toMatchObject({ width: 64, height: 48, hasAlpha: true })
    })

    it('albumet tar bare bilder', async () => {
      const eventId = await pastEvent()
      await setOwnParticipation(db, ola, eventId, true)
      expect(
        await denial(upload(ola, { purpose: 'event_photo', eventId }, pdf(), 'program.pdf')),
      ).toBe('domain')
    })
  })

  describe('grenser', () => {
    it('avviser filer over 25 MB og tomme filer', async () => {
      const big = Buffer.alloc(ASSET_MAX_BYTES + 1, 'a')
      await expect(upload(ola, { purpose: 'post' }, big, 'stor.txt')).rejects.toThrow(/for stor/)
      await expect(upload(ola, { purpose: 'post' }, Buffer.alloc(0), 'tom.txt')).rejects.toThrow(
        /tom/,
      )
      expect(await stored()).toEqual([])
    })

    it('teller filer og bytes per person og døgn, også slettede, og admins har høyere grense', async () => {
      const fake = (owner: string, n: number, byteSize = 1) =>
        db.insert(schema.asset).values(
          Array.from({ length: n }, () => ({
            fileKey: randomUUID().replaceAll('-', '').slice(0, 22),
            ownerPersonId: owner,
            purpose: 'post' as const,
            kind: 'document' as const,
            originalName: 'x.txt',
            contentType: 'text/plain; charset=utf-8',
            byteSize,
            storageKeys: { original: 'vedlegg/x.txt' },
            sha256: '0'.repeat(64),
            deletedAt: new Date(),
          })),
        )
      await fake(ola!.personId!, UPLOAD_LIMITS.member.files - 1)
      await upload(ola, { purpose: 'post' }, Buffer.from('hei'), 'a.txt')
      expect(await denial(upload(ola, { purpose: 'post' }, Buffer.from('hei'), 'b.txt'))).toBe(
        'limit',
      )
      // Gamle opplastinger teller ikke.
      await db
        .update(schema.asset)
        .set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
        .where(eq(schema.asset.ownerPersonId, ola!.personId!))
      await upload(ola, { purpose: 'post' }, Buffer.from('hei'), 'c.txt')

      // Bytes: 500 MB per døgn for medlemmer.
      await fake(kari!.personId!, 1, UPLOAD_LIMITS.member.bytes - 2)
      expect(await denial(upload(kari, { purpose: 'post' }, Buffer.from('hei'), 'd.txt'))).toBe(
        'limit',
      )

      await fake(admin!.personId!, UPLOAD_LIMITS.member.files + 5)
      await upload(admin, { purpose: 'post' }, Buffer.from('hei'), 'e.txt')
    })

    it('høyst 10 vedlegg per innlegg', async () => {
      const ids: string[] = []
      for (let i = 0; i < 11; i++) {
        ids.push((await upload(ola, { purpose: 'post' }, Buffer.from(`fil ${i}`), `${i}.txt`)).id)
      }
      await expect(createPost(db, ola, { ...question, attachmentIds: ids })).rejects.toThrow(
        /Maks 10 vedlegg/,
      )
      await createPost(db, ola, { ...question, attachmentIds: ids.slice(0, 10) })
    })

    it('rydder bort filene når databasen feiler', async () => {
      const spy = vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('nede'))
      await expect(upload(ola, { purpose: 'post' }, pdf())).rejects.toThrow('nede')
      spy.mockRestore()
      expect(await stored()).toEqual([])
    })
  })

  describe('innlegg og kommentarer', () => {
    it('vedlegg festes når innlegget lagres, i rekkefølgen forfatteren valgte', async () => {
      const image = await upload(ola, { purpose: 'post' }, await phoneJpeg(), 'bilde.jpg')
      const doc = await upload(ola, { purpose: 'post' }, pdf(), 'Pitch deck.pdf')
      expect(doc).toMatchObject({
        kind: 'document',
        name: 'Pitch deck.pdf',
        documentType: 'pdf',
        image: null,
      })
      // Før innlegget er lagret, ser bare den som lastet opp fila.
      expect(await denial(read(kari, doc))).toBe('not_found')
      expect((await read(ola, doc)).fileName).toBe('Pitch deck.pdf')

      const postId = await createPost(db, ola, { ...question, attachmentIds: [doc.id, image.id] })
      const post = await getPost(db, kari, postId)
      expect(post.attachments.map((a) => a.id)).toEqual([doc.id, image.id])
      expect(post.attachments.map((a) => a.canRemove)).toEqual([false, false])
      expect((await read(kari, doc)).body.byteLength).toBe(pdf().byteLength)
      expect((await getPost(db, moderator, postId)).attachments.every((a) => a.canRemove)).toBe(
        true,
      )
      const [summary] = await listPosts(db, kari)
      expect(summary!.attachments).toEqual({
        images: 1,
        documents: 1,
        thumbnail: image.image!.small,
      })
      expect((await getEditablePost(db, ola, postId)).attachments).toHaveLength(2)

      // Andres filer, filer til kommentarer og filer som er festet andre steder kan ikke brukes.
      const karis = await upload(kari, { purpose: 'post' }, pdf())
      await expect(createPost(db, ola, { ...question, attachmentIds: [karis.id] })).rejects.toThrow(
        /finnes ikke lenger/,
      )
      const forComment = await upload(ola, { purpose: 'comment' }, pdf())
      await expect(
        createPost(db, ola, { ...question, attachmentIds: [forComment.id] }),
      ).rejects.toThrow(/finnes ikke lenger/)
      await expect(createPost(db, ola, { ...question, attachmentIds: [doc.id] })).rejects.toThrow(
        /finnes ikke lenger/,
      )
    })

    it('redigering bytter, sorterer og fjerner vedlegg, og merker innlegget som redigert', async () => {
      const a = await upload(ola, { purpose: 'post' }, pdf(), 'a.pdf')
      const b = await upload(ola, { purpose: 'post' }, Buffer.from('tekst'), 'b.txt')
      const postId = await createPost(db, ola, { ...question, attachmentIds: [a.id, b.id] })
      expect(await stored()).toHaveLength(2)

      // Uten feltet beholdes vedleggene.
      await updatePost(db, ola, postId, question, storage)
      expect((await getPost(db, ola, postId)).editedAt).toBeNull()
      // Ny rekkefølge er en endring.
      await updatePost(db, ola, postId, { ...question, attachmentIds: [b.id, a.id] }, storage)
      const reordered = await getPost(db, ola, postId)
      expect(reordered.attachments.map((x) => x.id)).toEqual([b.id, a.id])
      expect(reordered.editedAt).not.toBeNull()

      // Tatt bort: slettet, og fila fjernet fra lagringen.
      const c = await upload(ola, { purpose: 'post' }, pdf(), 'c.pdf')
      await updatePost(db, ola, postId, { ...question, attachmentIds: [c.id, b.id] }, storage)
      expect((await getPost(db, kari, postId)).attachments.map((x) => x.id)).toEqual([c.id, b.id])
      expect((await rowOf(a.id)).deletedAt).not.toBeNull()
      expect((await rowOf(a.id)).purgedAt).not.toBeNull()
      expect(await denial(read(ola, a))).toBe('not_found')
      expect(await stored()).toHaveLength(2)
    })

    it('en kommentar kan være bare et bilde, og redigeres med vedlegg', async () => {
      const postId = await createPost(db, ola, question)
      await expect(addComment(db, kari, postId, { body: '  ' })).rejects.toThrow(/Skriv noe først/)
      const image = await upload(kari, { purpose: 'comment' }, await smallPng(), 'skjerm.png')
      const commentId = await addComment(db, kari, postId, { body: '', attachmentIds: [image.id] })
      const [comment] = (await getPost(db, ola, postId)).commentList
      expect(comment!.attachments.map((a) => a.id)).toEqual([image.id])
      expect((await read(ola, image)).kind).toBe('image')

      const doc = await upload(kari, { purpose: 'comment' }, pdf())
      await updateComment(
        db,
        kari,
        commentId,
        { body: 'Se vedlegg', attachmentIds: [doc.id] },
        storage,
      )
      const [edited] = (await getPost(db, ola, postId)).commentList
      expect(edited!.attachments.map((a) => a.id)).toEqual([doc.id])
      expect(edited!.editedAt).not.toBeNull()
      expect((await rowOf(image.id)).purgedAt).not.toBeNull()
    })

    it('sletting av innlegg og kommentarer sletter vedleggene og fjerner filene', async () => {
      const postFile = await upload(ola, { purpose: 'post' }, pdf())
      const postId = await createPost(db, ola, { ...question, attachmentIds: [postFile.id] })
      const commentFile = await upload(kari, { purpose: 'comment' }, pdf())
      const commentId = await addComment(db, kari, postId, {
        body: 'Hei',
        attachmentIds: [commentFile.id],
      })
      const other = await upload(kari, { purpose: 'comment' }, pdf())
      const otherComment = await addComment(db, kari, postId, {
        body: 'Hei igjen',
        attachmentIds: [other.id],
      })

      await deleteComment(db, kari, commentId, storage)
      expect(await denial(read(ola, commentFile))).toBe('not_found')
      expect((await rowOf(commentFile.id)).purgedAt).not.toBeNull()

      // En moderator fjerner innlegget: alt i tråden forsvinner, og det logges.
      await deletePost(db, moderator, postId, storage)
      for (const f of [postFile, other]) {
        expect(await denial(read(ola, f))).toBe('not_found')
        expect((await rowOf(f.id)).purgedAt).not.toBeNull()
      }
      expect(await stored()).toEqual([])
      const [entry] = await audit('content.remove_post')
      expect(entry!.details).toMatchObject({ postId, attachments: 2 })
      expect(otherComment).toBeTruthy()
    })

    it('uten lagring merkes vedleggene som slettet, og oppryddingen fjerner filene', async () => {
      const file = await upload(ola, { purpose: 'post' }, pdf())
      const postId = await createPost(db, ola, { ...question, attachmentIds: [file.id] })
      await deletePost(db, ola, postId)
      expect(await denial(read(ola, file))).toBe('not_found')
      expect(await stored()).toHaveLength(1)
      expect(await cleanupAssets(db, storage)).toEqual({ deleted: 0, purged: 1 })
      expect(await stored()).toEqual([])
    })

    it('moderatorer kan fjerne ett vedlegg, og det logges; andre medlemmer kan ikke', async () => {
      const file = await upload(ola, { purpose: 'post' }, pdf())
      const postId = await createPost(db, ola, { ...question, attachmentIds: [file.id] })
      expect(await denial(removeAsset(db, storage, kari, file.id))).toBe('forbidden')
      expect(await denial(removeAsset(db, storage, weakAdmin, file.id))).toBe(
        'strong_auth_required',
      )
      await removeAsset(db, storage, moderator, file.id)
      expect((await getPost(db, ola, postId)).attachments).toEqual([])
      const [entry] = await audit('content.remove_attachment')
      expect(entry).toMatchObject({
        actorPersonId: moderator!.personId,
        subjectPersonId: ola!.personId,
      })
      expect(entry!.details).toMatchObject({ assetId: file.id, purpose: 'post', postId })
      expect(await stored()).toEqual([])
    })
  })

  describe('lesing', () => {
    it('bare aktive medlemmer, og bare gyldige adresser', async () => {
      const image = await upload(ola, { purpose: 'post' }, await smallPng())
      const doc = await upload(ola, { purpose: 'post' }, pdf())
      await createPost(db, ola, { ...question, attachmentIds: [image.id, doc.id] })
      expect(await denial(read(null, doc))).toBe('unauthenticated')
      expect(await denial(read(pending, doc))).toBe('not_member')
      const key = nameOf(doc.url)
      for (const name of [
        `${key}-400.webp`, // et dokument har ingen bildestørrelser
        `${nameOf(image.url).replace('-1600.webp', '')}`, // et bilde har ingen original
        `${nameOf(image.url).replace('-1600', '-800')}`,
        '../../etc/passwd',
        `${key}.pdf`,
        'A'.repeat(22),
      ]) {
        expect(await denial(readAsset(db, storage, kari, name))).toBe('not_found')
      }
      expect((await readAsset(db, storage, kari, key)).contentType).toBe('application/pdf')
    })
  })

  describe('arrangementer', () => {
    it('de som var der og admins legger inn bilder; uploaderen og moderatorer fjerner', async () => {
      const eventId = await pastEvent()
      const target = { purpose: 'event_photo', eventId } as const
      const photo = await smallPng()
      expect(await denial(upload(kari, target, photo))).toBe('domain')
      expect(await denial(upload(weakAdmin, target, photo))).toBe('strong_auth_required')
      expect(await denial(upload(pending, target, photo))).toBe('not_member')
      await setOwnParticipation(db, kari, eventId, true)
      const karis = await upload(kari, target, photo, 'helgen.png')
      const admins = await upload(admin, target, photo)
      expect(await stored()).toEqual(expect.arrayContaining([expect.stringMatching(/^album\//)]))

      const seen = await getEvent(db, ola, eventId)
      expect(seen.photos.map((p) => p.id)).toEqual([karis.id, admins.id])
      expect(seen.photos[0]!.uploadedBy).toEqual({ personId: kari!.personId, fullName: 'Kari' })
      expect(seen).toMatchObject({ canUploadPhotos: false, canUploadDocuments: false })
      expect(seen.photos.every((p) => !p.canRemove)).toBe(true)
      expect((await getEvent(db, kari, eventId)).canUploadPhotos).toBe(true)
      expect((await read(ola, karis)).kind).toBe('image')

      expect(await denial(removeAsset(db, storage, ola, karis.id))).toBe('forbidden')
      await removeAsset(db, storage, kari, karis.id)
      expect(await audit('content.remove_attachment')).toEqual([])
      await removeAsset(db, storage, moderator, admins.id)
      expect(await audit('content.remove_attachment')).toHaveLength(1)
      expect((await getEvent(db, ola, eventId)).photos).toEqual([])
      expect(await stored()).toEqual([])
    })

    it('bilder kan ikke legges inn før arrangementet har startet', async () => {
      const eventId = await pastEvent('2999-01-01')
      expect(
        await denial(upload(admin, { purpose: 'event_photo', eventId }, await smallPng())),
      ).toBe('domain')
      expect((await getEvent(db, admin, eventId)).canUploadPhotos).toBe(false)
    })

    it('arrangørene og admins laster opp dokumenter; admins logges', async () => {
      const eventId = await pastEvent()
      const target = { purpose: 'event_document', eventId } as const
      await setOwnParticipation(db, kari, eventId, true)
      expect(await denial(upload(kari, target, pdf()))).toBe('forbidden')
      await db
        .update(schema.eventParticipation)
        .set({ role: 'organizer' })
        .where(eq(schema.eventParticipation.personId, kari!.personId!))
      const program = await upload(kari, target, pdf(), 'Program.pdf')
      expect(await audit('event.admin_document_add')).toEqual([])
      const referat = await upload(admin, target, Buffer.from('Referat'), 'referat.txt')
      expect(await audit('event.admin_document_add')).toHaveLength(1)
      expect((await stored()).every((f) => f.startsWith('dokumenter/'))).toBe(true)

      const seen = await getEvent(db, ola, eventId)
      expect(seen.documents.map((d) => d.name)).toEqual(['Program.pdf', 'referat.txt'])
      expect((await getEvent(db, kari, eventId)).canUploadDocuments).toBe(true)
      // Arrangøren kan fjerne andres dokumenter på arrangementet; det logges.
      expect((await getEvent(db, kari, eventId)).documents.every((d) => d.canRemove)).toBe(true)
      await removeAsset(db, storage, kari, referat.id)
      expect(await audit('content.remove_attachment')).toHaveLength(1)
      expect(program.own).toBe(true)
    })

    it('sletting av arrangementet sletter bildene og dokumentene', async () => {
      const eventId = await pastEvent()
      const photo = await upload(admin, { purpose: 'event_photo', eventId }, await smallPng())
      const doc = await upload(admin, { purpose: 'event_document', eventId }, pdf())
      await deleteEvent(db, admin, eventId, storage)
      for (const f of [photo, doc]) {
        expect(await rowOf(f.id)).toMatchObject({ eventId: null })
        expect((await rowOf(f.id)).purgedAt).not.toBeNull()
      }
      expect(await stored()).toEqual([])
      const [entry] = await audit('event.delete')
      expect(entry!.details).toMatchObject({ files: 2 })
    })
  })

  describe('selskaper', () => {
    it('de som kan redigere selskapet laster opp; alle medlemmer laster ned', async () => {
      const acme = await company()
      const target = { purpose: 'company_document', companyId: acme.id } as const
      expect(await denial(upload(ola, target, pdf()))).toBe('forbidden')
      await db
        .insert(schema.experience)
        .values({ personId: ola!.personId!, companyId: acme.id, founder: true })
      const deck = await upload(ola, target, pdf(), 'Pitch deck.pdf')
      expect(await audit('company.admin_document_add')).toEqual([])
      await upload(admin, target, Buffer.from('a;b\n1;2\n'), 'tall.csv')
      expect(await audit('company.admin_document_add')).toHaveLength(1)

      const seen = (await getCompany(db, kari, acme.slug)) as CompanyDetails
      expect(seen.documents.map((d) => [d.name, d.documentType, d.canRemove])).toEqual([
        ['Pitch deck.pdf', 'pdf', false],
        ['tall.csv', 'csv', false],
      ])
      expect((await read(kari, deck)).contentType).toBe('application/pdf')
      const asFounder = (await getCompany(db, ola, acme.slug)) as CompanyDetails
      expect(asFounder.documents.every((d) => d.canRemove)).toBe(true)
      expect(await denial(removeAsset(db, storage, kari, deck.id))).toBe('forbidden')
    })

    it('sammenslåing flytter dokumentene, og sletting fjerner dem', async () => {
      const a = await company('Alfa')
      const b = await company('Beta')
      const doc = await upload(admin, { purpose: 'company_document', companyId: a.id }, pdf())
      await mergeCompanies(db, storage, admin, { sourceId: a.id, targetId: b.id })
      expect(await rowOf(doc.id)).toMatchObject({ companyId: b.id, deletedAt: null })
      expect(((await getCompany(db, ola, b.slug)) as CompanyDetails).documents).toHaveLength(1)

      await deleteCompany(db, storage, admin, { companyId: b.id, unlink: false })
      expect((await rowOf(doc.id)).purgedAt).not.toBeNull()
      expect(await stored()).toEqual([])
    })
  })

  describe('opprydding', () => {
    it('filer som aldri ble festet, slettes etter et døgn', async () => {
      const old = await upload(ola, { purpose: 'post' }, pdf())
      const fresh = await upload(ola, { purpose: 'comment' }, pdf())
      const attached = await upload(ola, { purpose: 'post' }, pdf())
      await createPost(db, ola, { ...question, attachmentIds: [attached.id] })
      await db
        .update(schema.asset)
        .set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
        .where(eq(schema.asset.id, old.id))
      expect(await cleanupAssets(db, storage)).toEqual({ deleted: 1, purged: 1 })
      expect((await rowOf(old.id)).deletedAt).not.toBeNull()
      expect((await rowOf(fresh.id)).deletedAt).toBeNull()
      expect((await rowOf(attached.id)).deletedAt).toBeNull()
      expect(await stored()).toHaveLength(2)
      // En gang til: ingenting å gjøre.
      expect(await cleanupAssets(db, storage)).toEqual({ deleted: 0, purged: 0 })
    })

    it('filer der forelderen er slettet direkte i databasen, ryddes bort med en gang', async () => {
      const eventId = await pastEvent()
      const photo = await upload(admin, { purpose: 'event_photo', eventId }, await smallPng())
      await db.delete(schema.event).where(eq(schema.event.id, eventId))
      expect(await rowOf(photo.id)).toMatchObject({ eventId: null, deletedAt: null })
      expect(await denial(read(admin, photo))).toBe('not_found')
      expect(await cleanupAssets(db, storage)).toEqual({ deleted: 1, purged: 1 })
      expect(await stored()).toEqual([])
    })

    it('det som ikke lot seg slette fra lagringen, prøves igjen', async () => {
      const file = await upload(ola, { purpose: 'post' }, pdf())
      const postId = await createPost(db, ola, { ...question, attachmentIds: [file.id] })
      const failing: ObjectStorage = {
        ...storage,
        delete: () => Promise.reject(new Error('lagringen er nede')),
      }
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      await deletePost(db, ola, postId, failing)
      log.mockRestore()
      expect((await rowOf(file.id)).purgedAt).toBeNull()
      expect(await stored()).toHaveLength(1)
      expect(await cleanupAssets(db, storage)).toEqual({ deleted: 0, purged: 1 })
      expect(await stored()).toEqual([])
      const unpurged = await db
        .select()
        .from(schema.asset)
        .where(and(isNull(schema.asset.purgedAt)))
      expect(unpurged).toEqual([])
    })
  })
})
