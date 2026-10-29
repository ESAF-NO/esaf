import { randomUUID } from 'node:crypto'
import { createDb, loadRootEnv, runMigrations, schema, type Db } from '@esaf/db'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccessDeniedError,
  addCompanyArticle,
  articleUrlKey,
  companyArticleInput,
  decideMembership,
  decideSuggestion,
  deleteCompanyArticle,
  getCompany,
  grantRoleAsOperator,
  listNotifications,
  listReview,
  loadViewer,
  mergeCompanies,
  normalizeArticleUrl,
  suggestCompanyArticle,
  updateCompanyArticle,
  updateProfile,
  withdrawSuggestion,
  type CompanyArticleInput,
  type CompanyDetails,
  type ObjectStorage,
  type ProfileInput,
  type Viewer,
} from '../src/index.ts'

loadRootEnv()
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

describe('lenker til saker', () => {
  it('normaliserer lenker og godtar bare http og https', () => {
    expect(normalizeArticleUrl('https://WWW.Adressa.no/sak?utm_source=x&id=4#kommentarer')).toBe(
      'https://www.adressa.no/sak?id=4',
    )
    expect(normalizeArticleUrl('e24.no/sak')).toBe('https://e24.no/sak')
    for (const bad of [
      'javascript:alert(1)',
      'ftp://example.test/a',
      'https://localhost/a',
      'ikke en lenke',
      'https://kari:hemmelig@example.test/',
    ]) {
      expect(normalizeArticleUrl(bad)).toBeNull()
    }
  })

  it('kjenner igjen samme sak skrevet litt ulikt', () => {
    const key = articleUrlKey('https://www.adressa.no/sak/?b=2&a=1')
    expect(articleUrlKey('http://adressa.no/sak?a=1&b=2&utm_medium=e')).toBe(key)
    expect(articleUrlKey('https://adressa.no/sak#x')).not.toBe(key)
  })

  it('validerer tittel og dato', () => {
    const base = {
      url: 'https://avis.example/sak',
      title: '  Syrlig   vokser ',
      publisher: '',
      year: 2021,
      month: 2,
      day: 29,
      paywall: false,
      mentionsEs: false,
    }
    expect(companyArticleInput.safeParse(base).error?.issues[0]?.message).toBe(
      'Datoen finnes ikke.',
    )
    const ok = companyArticleInput.parse({ ...base, day: 28 })
    expect(ok).toMatchObject({ title: 'Syrlig vokser', publisher: null })
    expect(companyArticleInput.safeParse({ ...base, year: null }).success).toBe(false)
    expect(companyArticleInput.safeParse({ ...base, title: ' ' }).success).toBe(false)
    expect(
      companyArticleInput.safeParse({ ...base, year: null, month: null, day: null }).success,
    ).toBe(true)
  })
})

const storage: ObjectStorage = {
  put: () => Promise.resolve(),
  get: () => Promise.resolve(null),
  delete: () => Promise.resolve(),
}

const emptyProfile: ProfileInput = {
  fullName: 'Navn',
  city: '',
  studyBackground: '',
  esCompany: '',
  bio: '',
  expertise: [],
  industries: [],
  experience: [],
  linkedinUrl: '',
  contactEmail: '',
  contactEmailVisible: false,
  phone: '',
  phoneVisible: false,
}

const article: CompanyArticleInput = {
  url: 'https://www.adressa.no/syrlig?utm_source=deling',
  title: 'Syrlig vil erobre Europa',
  publisher: 'Adresseavisen',
  year: 2021,
  month: 5,
  day: null,
  paywall: true,
  mentionsEs: true,
}

describe.skipIf(!url)('I media', () => {
  let db: Db
  let admin: Viewer
  let weakAdmin: Viewer
  let ola: Viewer
  let kari: Viewer
  let syrligId: string

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

  async function makeAdmin(name: string, strong: boolean) {
    const userId = await account(name)
    await grantRoleAsOperator(db, {
      email: `${name.toLowerCase()}@example.test`,
      reason: 'test',
      role: 'admin',
    })
    if (strong) {
      await db.update(schema.user).set({ twoFactorEnabled: true }).where(eq(schema.user.id, userId))
    }
    return loadViewer(db, userId)
  }

  beforeEach(async () => {
    await db.execute(
      sql`truncate ${schema.fieldSource}, ${schema.auditEvent}, ${schema.membership}, ${schema.personCohort}, ${schema.person}, ${schema.cohort}, ${schema.user}, ${schema.company} cascade`,
    )
    admin = await makeAdmin('Admin', true)
    weakAdmin = await makeAdmin('Svak', false)
    ola = await member('Ola')
    kari = await member('Kari')
    // Ola er gründer av Syrlig; Kari er ikke knyttet til det.
    await updateProfile(db, ola, ola!.personId!, {
      ...emptyProfile,
      fullName: 'Ola',
      experience: [
        { company: 'Syrlig', title: null, startYear: 2016, endYear: null, founder: true },
      ],
    })
    const [row] = await db.select().from(schema.company).where(eq(schema.company.slug, 'syrlig'))
    syrligId = row!.id
  })

  async function page(viewer: Viewer, slug = 'syrlig') {
    const found = await getCompany(db, viewer, slug)
    if ('movedTo' in found) throw new Error(`Flyttet til ${found.movedTo}`)
    return found as CompanyDetails
  }

  async function denial(promise: Promise<unknown>) {
    try {
      await promise
      return 'allowed'
    } catch (error) {
      if (error instanceof AccessDeniedError) return error.reason
      throw error
    }
  }

  const audit = (action: string) =>
    db.select().from(schema.auditEvent).where(eq(schema.auditEvent.action, action))

  it('de som kan redigere selskapet, legger til, retter og fjerner saker; andre kan ikke', async () => {
    const { id } = await addCompanyArticle(db, ola, syrligId, article)
    const [row] = await db
      .select()
      .from(schema.companyArticle)
      .where(eq(schema.companyArticle.id, id))
    expect(row).toMatchObject({
      url: 'https://www.adressa.no/syrlig',
      publishedAt: '2021-05-01',
      publishedPrecision: 'month',
      source: 'member',
      addedByPersonId: ola!.personId,
    })

    // Alle medlemmer ser saken; bare lenken, tittelen, utgiveren og datoen.
    expect((await page(kari)).articles).toEqual([
      {
        id,
        url: 'https://www.adressa.no/syrlig',
        title: 'Syrlig vil erobre Europa',
        publisher: 'Adresseavisen',
        publisherLabel: 'Adresseavisen',
        publishedAt: '2021-05-01',
        publishedPrecision: 'month',
        paywall: true,
        mentionsEs: true,
      },
    ])

    expect(await denial(addCompanyArticle(db, kari, syrligId, article))).toBe('forbidden')
    expect(await denial(updateCompanyArticle(db, kari, id, article))).toBe('forbidden')
    expect(await denial(deleteCompanyArticle(db, kari, id))).toBe('forbidden')
    expect(await denial(addCompanyArticle(db, weakAdmin, syrligId, article))).toBe(
      'strong_auth_required',
    )

    await updateCompanyArticle(db, ola, id, { ...article, publisher: '', paywall: false })
    expect((await page(kari)).articles[0]).toMatchObject({
      publisher: null,
      publisherLabel: 'adressa.no',
      paywall: false,
    })
    await deleteCompanyArticle(db, ola, id)
    expect((await page(kari)).articles).toEqual([])
    // Ola er knyttet til selskapet; ingenting logges.
    const logged = await db
      .select()
      .from(schema.auditEvent)
      .where(sql`${schema.auditEvent.action} like 'company.%'`)
    expect(logged).toHaveLength(0)
  })

  it('samme sak står bare én gang, også når lenken er skrevet litt ulikt', async () => {
    await addCompanyArticle(db, ola, syrligId, article)
    await expect(
      addCompanyArticle(db, ola, syrligId, { ...article, url: 'http://adressa.no/syrlig/#topp' }),
    ).rejects.toThrow(/står allerede/)
    const { id } = await addCompanyArticle(db, ola, syrligId, {
      ...article,
      url: 'https://e24.no/syrlig',
    })
    await expect(
      updateCompanyArticle(db, ola, id, { ...article, url: 'https://adressa.no/syrlig' }),
    ).rejects.toThrow(/står allerede/)
    await expect(
      addCompanyArticle(db, ola, syrligId, { ...article, url: 'javascript:alert(1)' }),
    ).rejects.toThrow(/Ugyldig lenke/)
  })

  it('nyeste først og saker uten dato sist', async () => {
    const add = (title: string, year: number | null, month: number | null = null) =>
      addCompanyArticle(db, ola, syrligId, {
        ...article,
        url: `https://avis.example/${encodeURIComponent(title)}`,
        title,
        year,
        month,
      })
    await add('Uten dato', null)
    await add('Eldst', 2015)
    await add('Nyest', 2023, 3)
    await add('Midt i', 2019)
    expect((await page(kari)).articles.map((a) => a.title)).toEqual([
      'Nyest',
      'Midt i',
      'Eldst',
      'Uten dato',
    ])
  })

  it('admins som ikke er knyttet til selskapet, logges', async () => {
    const { id } = await addCompanyArticle(db, admin, syrligId, article)
    await updateCompanyArticle(db, admin, id, { ...article, title: 'Ny tittel' })
    await deleteCompanyArticle(db, admin, id)
    for (const action of [
      'company.admin_article_add',
      'company.admin_article_edit',
      'company.admin_article_remove',
    ]) {
      const [logged] = await audit(action)
      expect(logged, action).toBeDefined()
      expect(logged!.actorPersonId).toBe(admin!.personId)
      expect(logged!.details).toMatchObject({
        companyId: syrligId,
        slug: 'syrlig',
        articleId: id,
        url: 'https://www.adressa.no/syrlig',
      })
    }
  })

  it('andre medlemmer foreslår saker; godtatt blir den lagt inn med varsel', async () => {
    const { id } = await suggestCompanyArticle(db, kari, syrligId, article, 'Fra i går')
    // Den som kan redigere, kan ikke foreslå, og samme sak kan ikke foreslås når den står der.
    await expect(suggestCompanyArticle(db, ola, syrligId, article)).rejects.toThrow(
      /kan redigere det selv/,
    )
    const [forOla] = (await page(ola)).suggestions
    expect(forOla).toMatchObject({
      kind: 'article',
      note: 'Fra i går',
      article: { url: 'https://www.adressa.no/syrlig', title: 'Syrlig vil erobre Europa' },
    })
    const [notified] = (await listNotifications(db, ola)).items
    expect(notified).toMatchObject({ type: 'company_suggestion', suggestionKind: 'article' })
    // Admins ser forslaget under Gjennomgang.
    const review = await listReview(db, admin, 'suggestions', 1)
    expect(review).toMatchObject({ kind: 'suggestions', total: 1 })

    expect(await denial(decideSuggestion(db, kari, id, 'accept'))).toBe('forbidden')
    await decideSuggestion(db, ola, id, 'accept')
    const after = await page(kari)
    expect(after.articles).toHaveLength(1)
    const [row] = await db.select().from(schema.companyArticle)
    expect(row).toMatchObject({ source: 'member', addedByPersonId: kari!.personId })
    const [note] = (await listNotifications(db, kari)).items
    expect(note).toMatchObject({ type: 'suggestion_accepted', suggestionKind: 'article' })

    await expect(suggestCompanyArticle(db, kari, syrligId, article)).rejects.toThrow(
      /står allerede/,
    )
  })

  it('et forslag om en sak som er lagt inn i mellomtiden, godtas uten duplikat', async () => {
    const { id } = await suggestCompanyArticle(db, kari, syrligId, article)
    await addCompanyArticle(db, ola, syrligId, article)
    await decideSuggestion(db, admin, id, 'accept')
    expect(await db.select().from(schema.companyArticle)).toHaveLength(1)
    const [logged] = await audit('company.admin_suggestion_accept')
    expect(logged!.details).toMatchObject({ kind: 'article' })
  })

  it('forslag kan avslås og trekkes', async () => {
    const first = await suggestCompanyArticle(db, kari, syrligId, article)
    await decideSuggestion(db, ola, first.id, 'reject')
    expect((await page(kari)).articles).toEqual([])
    const second = await suggestCompanyArticle(db, kari, syrligId, article)
    await withdrawSuggestion(db, kari, second.id)
    expect((await page(ola)).suggestions).toEqual([])
    await expect(
      suggestCompanyArticle(db, kari, syrligId, { ...article, url: 'mailto:ola@example.test' }),
    ).rejects.toThrow(/Ugyldig lenke/)
  })

  it('følger med når selskaper slås sammen, uten doble saker', async () => {
    await addCompanyArticle(db, ola, syrligId, article)
    const [dup] = await db
      .insert(schema.company)
      .values({ slug: 'syrlig-as', name: 'Syrlig AS', editedAt: new Date() })
      .returning()
    await addCompanyArticle(db, admin, dup!.id, { ...article, url: 'https://adressa.no/syrlig' })
    await addCompanyArticle(db, admin, dup!.id, {
      ...article,
      url: 'https://e24.no/syrlig',
      title: 'Syrlig henter penger',
    })
    await mergeCompanies(db, storage, admin, { sourceId: dup!.id, targetId: syrligId })
    expect((await page(kari)).articles.map((a) => a.url).sort()).toEqual([
      'https://e24.no/syrlig',
      'https://www.adressa.no/syrlig',
    ])
    const [merged] = await audit('company.merge')
    expect(merged!.details).toMatchObject({ articles: 1 })
  })

  it('slettes sammen med selskapet', async () => {
    await addCompanyArticle(db, ola, syrligId, article)
    await db.delete(schema.experience)
    await db.delete(schema.company).where(eq(schema.company.id, syrligId))
    expect(await db.select().from(schema.companyArticle)).toEqual([])
  })
})
