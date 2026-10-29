import { randomUUID } from 'node:crypto'
import {
  createDb,
  loadRootEnv,
  runMigrations,
  schema,
  type CohortRelation,
  type Db,
} from '@esaf/db'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccessDeniedError,
  createPost,
  deletePost,
  getCohortPage,
  grantRoleAsOperator,
  listCohorts,
  loadViewer,
  NotFoundError,
  type Viewer,
  resolveCompanies,
} from '../src/index.ts'

loadRootEnv()
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

describe.skipIf(!url)('kullsiden', () => {
  let db: Db
  let ola: Viewer
  let kari: Viewer
  let mona: Viewer
  let nils: Viewer
  let pending: Viewer
  let profileId: string
  const cohortId = new Map<number, string>()

  beforeAll(async () => {
    await runMigrations(url!)
    db = createDb(url!)
  })
  afterAll(() => db?.close())

  async function joinCohort(personId: string, year: number, relation: CohortRelation = 'student') {
    await db
      .insert(schema.personCohort)
      .values({ personId, cohortId: cohortId.get(year)!, relation })
  }

  /** Et aktivt medlem med konto, i kullene som er oppgitt. */
  async function member(name: string, cohorts: [number, CohortRelation?][]) {
    const id = randomUUID()
    const email = `${name.toLowerCase()}@example.test`
    await db.insert(schema.user).values({ id, name, email, emailVerified: true })
    const { personId } = await grantRoleAsOperator(db, { email, reason: 'test', role: 'member' })
    for (const [year, relation] of cohorts) await joinCohort(personId, year, relation)
    return loadViewer(db, id)
  }

  beforeEach(async () => {
    await db.execute(
      sql`truncate ${schema.postVote}, ${schema.comment}, ${schema.post}, ${schema.auditEvent}, ${schema.experience}, ${schema.company}, ${schema.membership}, ${schema.personCohort}, ${schema.personEmail}, ${schema.person}, ${schema.cohort}, ${schema.user} cascade`,
    )
    const rows = await db
      .insert(schema.cohort)
      .values([2014, 2016, 2017].map((graduationYear) => ({ graduationYear })))
      .returning()
    for (const row of rows) cohortId.set(row.graduationYear, row.id)

    ola = await member('Ola', [[2016]])
    kari = await member('Kari', [[2016]])
    // Mentor for ES 2016, men student i ES 2014.
    mona = await member('Mona', [[2014], [2016, 'mentor']])
    nils = await member('Nils', [[2017]])

    // En profil fra kullisten som ingen har tatt i bruk, og en som venter på godkjenning.
    const [profile] = await db
      .insert(schema.person)
      .values({ fullName: 'Per Profil', source: 'import' })
      .returning({ id: schema.person.id })
    profileId = profile!.id
    await db.insert(schema.membership).values({ personId: profileId, status: 'active' })
    await joinCohort(profileId, 2016)
    const pendingId = randomUUID()
    await db.insert(schema.user).values({
      id: pendingId,
      name: 'Ventende',
      email: 'ventende@example.test',
      emailVerified: true,
    })
    pending = await loadViewer(db, pendingId)
    await joinCohort(pending!.personId!, 2016)

    // To skrivemåter av samme ES-selskap havner på samme selskap, som i appen.
    const [syrlig, syrlig2, fjordflow, equinor, havkraft] = await resolveCompanies(db, [
      { name: 'Syrlig AS' },
      { name: ' syrlig as ' },
      { name: 'Fjordflow' },
      { name: 'Equinor' },
      { name: 'Havkraft' },
    ])
    await db
      .update(schema.person)
      .set({ esCompanyId: syrlig })
      .where(eq(schema.person.id, ola!.personId!))
    await db
      .update(schema.person)
      .set({ esCompanyId: syrlig2 })
      .where(eq(schema.person.id, kari!.personId!))
    await db.insert(schema.experience).values([
      { personId: ola!.personId!, companyId: fjordflow!, startYear: 2017, founder: true },
      { personId: kari!.personId!, companyId: equinor!, title: 'Analytiker', startYear: 2018 },
      { personId: nils!.personId!, companyId: havkraft!, startYear: 2018, founder: true },
    ])
  })

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

  it('bare aktive medlemmer ser kullsider, og ukjente kull finnes ikke', async () => {
    expect(await denial(getCohortPage(db, null, 2016))).toBe('unauthenticated')
    expect(await denial(getCohortPage(db, pending, 2016))).toBe('not_member')
    expect(await denial(getCohortPage(db, ola, 2031))).toBe('not_found')
    expect(await denial(getCohortPage(db, ola, Number.NaN))).toBe('not_found')
    expect(await denial(getCohortPage(db, ola, 2016.5))).toBe('not_found')
  })

  it('viser alle med aktivt medlemskap i kullet, med de samme tallene som kulloversikten', async () => {
    const page = await getCohortPage(db, ola, 2016)
    expect(page).toMatchObject({ graduationYear: 2016, name: null, members: 4, claimed: 3 })
    expect(page.people.map((p) => p.fullName).sort()).toEqual(['Kari', 'Mona', 'Ola', 'Per Profil'])
    expect(page.people.find((p) => p.fullName === 'Mona')?.cohorts).toEqual([
      { graduationYear: 2014, relation: 'student' },
      { graduationYear: 2016, relation: 'mentor' },
    ])
    expect(page.people.find((p) => p.personId === profileId)).toMatchObject({ claimed: false })

    const summary = (await listCohorts(db, ola)).find((c) => c.graduationYear === 2016)
    expect(summary).toMatchObject({ members: page.members, claimed: page.claimed })

    expect((await getCohortPage(db, ola, 2016)).isOwn).toBe(true)
    expect((await getCohortPage(db, nils, 2016)).isOwn).toBe(false)
    // Et kull uten aktive medlemmer finnes, men er tomt.
    await db
      .delete(schema.personCohort)
      .where(eq(schema.personCohort.cohortId, cohortId.get(2017)!))
    expect(await getCohortPage(db, ola, 2017)).toMatchObject({
      members: 0,
      claimed: 0,
      people: [],
      companies: [],
      posts: [],
    })
  })

  it('viser selskaper folk i kullet har grunnlagt eller hadde på ES', async () => {
    const { companies } = await getCohortPage(db, kari, 2016)
    expect(companies).toEqual([
      {
        slug: 'syrlig-as',
        name: expect.stringMatching(/^(Syrlig AS|syrlig as)$/),
        logo: null,
        esCompany: true,
        people: [
          { personId: kari!.personId, fullName: 'Kari', photo: null, claimed: true, role: 'es' },
          { personId: ola!.personId, fullName: 'Ola', photo: null, claimed: true, role: 'es' },
        ],
      },
      {
        slug: 'fjordflow',
        name: 'Fjordflow',
        logo: null,
        esCompany: false,
        people: [
          { personId: ola!.personId, fullName: 'Ola', photo: null, claimed: true, role: 'founder' },
        ],
      },
    ])
    // Arbeidsgivere og selskaper fra andre kull er ikke med.
    expect(companies.map((c) => c.name)).not.toContain('Equinor')
    expect(companies.map((c) => c.name)).not.toContain('Havkraft')
  })

  it('viser de nyeste innleggene fra folk i kullet', async () => {
    const post = (title: string) => ({ channel: 'generelt' as const, title, body: '', url: '' })
    const first = await createPost(db, ola, post('Første fra Ola'))
    await createPost(db, nils, post('Fra et annet kull'))
    const removed = await createPost(db, kari, post('Slettet'))
    await deletePost(db, kari, removed)
    const fromMentor = await createPost(db, mona, post('Fra mentoren'))
    for (let i = 0; i < 4; i++) await createPost(db, kari, post(`Kari nr. ${i + 1}`))

    const { posts } = await getCohortPage(db, nils, 2016)
    expect(posts.map((p) => p.title)).toEqual([
      'Kari nr. 4',
      'Kari nr. 3',
      'Kari nr. 2',
      'Kari nr. 1',
      'Fra mentoren',
    ])
    expect(posts.map((p) => p.id)).toContain(fromMentor)
    expect(posts.map((p) => p.id)).not.toContain(first)
  })
})
