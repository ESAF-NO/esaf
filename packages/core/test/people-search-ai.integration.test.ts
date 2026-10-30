import { randomUUID } from 'node:crypto'
import { createDb, loadRootEnv, runMigrations, schema, type Db } from '@esaf/db'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ASK_PER_HOUR,
  askPeople,
  createCompany,
  createProfileBatch,
  decideMembership,
  DomainError,
  grantRoleAsOperator,
  interpretQuery,
  listPeopleForTopics,
  loadViewer,
  refreshAiTopics,
  resetSearchAiState,
  searchPeopleByTopic,
  searchPeopleInterpreted,
  setSearchTopics,
  tidyPlan,
  type ObjectStorage,
  type QueryPlan,
  type SearchAi,
  type Viewer,
} from '../src/index.ts'

loadRootEnv()
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

const storage: ObjectStorage = {
  put: async () => {},
  get: async () => null,
  delete: async () => {},
}

const plan = (p: Partial<QueryPlan>): QueryPlan => ({
  topics: [],
  cities: [],
  cohortFrom: null,
  cohortTo: null,
  founder: false,
  ...p,
})

/** En Claude til testene: svarene bestemmes av testen, og kallene telles. */
function fakeAi(overrides: Partial<SearchAi> = {}) {
  const calls = { tag: [] as string[][], interpret: [] as string[], rank: [] as string[] }
  const ai: SearchAi = {
    model: 'test-claude',
    async tagProfiles(people) {
      calls.tag.push(people.map((p) => p.personId))
      return new Map(
        people.map((p) => [
          p.personId,
          p.text.join(' ').includes('Rakettverket')
            ? ['romfart', 'space', 'aerospace', 'x'.repeat(60)]
            : [],
        ]),
      )
    },
    async interpretQuery(query) {
      calls.interpret.push(query)
      return plan({ topics: [{ term: query, related: [] }] })
    },
    async rankCandidates(question, candidates) {
      calls.rank.push(question)
      return {
        summary: 'Fant én som passer.',
        matches: candidates.slice(0, 1).map((c) => ({
          personId: c.personId,
          why: 'Grunnla et romfartsselskap.',
          strong: true,
        })),
      }
    },
    ...overrides,
  }
  return { ai, calls }
}

describe.skipIf(!url)('personsøk med Claude', () => {
  let db: Db
  let admin: Viewer
  let member: Viewer

  beforeAll(async () => {
    await runMigrations(url!)
    db = createDb(url!)
  })
  afterAll(() => db?.close())

  async function account(name: string, twoFactor = false) {
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

  beforeEach(async () => {
    resetSearchAiState()
    await db.execute(
      sql`truncate ${schema.personSearchIndex}, ${schema.personAiTopics}, ${schema.auditEvent}, ${schema.membership}, ${schema.personCohort}, ${schema.experience}, ${schema.person}, ${schema.cohort}, ${schema.user}, ${schema.company} cascade`,
    )
    await account('Admin', true)
    await grantRoleAsOperator(db, { email: 'admin@example.test', reason: 'test', role: 'admin' })
    admin = await loadViewer(db, (await db.select().from(schema.user))[0]!.id)
    const id = await account('Medlem')
    const v = await loadViewer(db, id)
    await decideMembership(db, admin, { personId: v!.personId!, decision: 'approve' })
    member = await loadViewer(db, id)
  })

  async function seed() {
    const { id: rocketId } = await createCompany(db, admin, {
      name: 'Rakettverket',
      tagline: 'Motorer for små fartøy',
      description: null,
      website: null,
      foundedYear: 2015,
      location: null,
      industries: [],
      status: 'active',
    })
    const result = await createProfileBatch(db, storage, admin, [
      {
        fullName: 'Kari Rakett',
        city: 'Oslo',
        cohorts: [{ graduationYear: 2014 }],
        experience: [{ companyId: rocketId, company: 'Rakettverket', title: 'CTO', founder: true }],
      },
      {
        fullName: 'Ola Laks',
        city: 'Bergen',
        cohorts: [{ graduationYear: 2016 }],
        bio: 'Ola har jobbet med oppdrett av laks i ti år, og startet sitt eget selskap.',
      },
      {
        fullName: 'Siri Nord',
        city: 'Oslo',
        cohorts: [{ graduationYear: 2016 }],
        bio: 'Siri jobber med salg av medisinsk utstyr til sykehus over hele Norden.',
      },
      { fullName: 'Per Uten', cohorts: [{ graduationYear: 2016 }] },
    ])
    const id = (name: string) => result.rows.find((r) => r.fullName === name)!.personId!
    return {
      kari: id('Kari Rakett'),
      ola: id('Ola Laks'),
      siri: id('Siri Nord'),
      per: id('Per Uten'),
    }
  }

  it('Claude skriver søkeord for endrede profiler, og admins sine går foran', async () => {
    const { kari, ola, siri, per } = await seed()
    const { ai, calls } = fakeAi()
    // «space» står ingen steder hos Kari før Claude har skrevet søkeord.
    expect((await searchPeopleByTopic(db, member, 'aerospace')).map((h) => h.personId)).toEqual([])

    const first = await refreshAiTopics(db, ai, { groupSize: 2 })
    expect(first).toMatchObject({ tagged: 3, pending: 0 }) // Per har ingen tekst.
    expect(calls.tag.flat()).not.toContain(per)
    expect(calls.tag.every((g) => g.length <= 2)).toBe(true)
    const [row] = await db
      .select()
      .from(schema.personAiTopics)
      .where(eq(schema.personAiTopics.personId, kari))
    // Ryddet som admins sine: for lange droppes, stor forbokstav.
    expect(row).toMatchObject({ topics: ['Romfart', 'Space', 'Aerospace'], model: 'test-claude' })

    const hits = await searchPeopleByTopic(db, member, 'aerospace')
    expect(hits[0]).toMatchObject({ personId: kari, matchedBy: 'text' })
    expect(hits[0]!.reason).toContain('Aerospace')

    // Ingenting endret: ingen nye kall. Ny tekst: bare den personen.
    calls.tag.length = 0
    expect(await refreshAiTopics(db, ai)).toMatchObject({ tagged: 0 })
    await db
      .update(schema.person)
      .set({ bio: 'Ola driver nå med havbruk.' })
      .where(eq(schema.person.id, ola))
    expect(await refreshAiTopics(db, ai)).toMatchObject({ tagged: 1 })
    expect(calls.tag.flat()).toEqual([ola])

    // Søkeord fra en admin erstatter Claudes, og da spørres ikke Claude om personen.
    await setSearchTopics(db, admin, [{ personId: kari, topics: ['motorer'] }])
    expect(await refreshAiTopics(db, ai)).toMatchObject({ tagged: 0, removed: 1 })
    expect(await searchPeopleByTopic(db, member, 'aerospace')).toEqual([])
    const listed = await listPeopleForTopics(db, admin, { missingOnly: false })
    expect(listed.items.find((p) => p.personId === siri)).toMatchObject({ aiTopics: [] })
    expect(listed.items.find((p) => p.personId === kari)).toMatchObject({
      currentTopics: ['Motorer'],
    })
  })

  it('en feil fra Claude stopper runden uten å lagre noe', async () => {
    await seed()
    const { ai } = fakeAi({
      tagProfiles: async () => {
        throw new Error('nede')
      },
    })
    await expect(refreshAiTopics(db, ai)).rejects.toThrow('nede')
    expect(await db.select().from(schema.personAiTopics)).toEqual([])
  })

  it('tolkningen gir emner og filtre: by, kull og gründer', async () => {
    const { kari, ola, siri } = await seed()
    const health = plan({
      topics: [{ term: 'helse', related: ['sykehus', 'medisinsk', 'healthcare'] }],
    })
    // «helse» står ikke hos Siri; de beslektede ordene gjør.
    expect((await searchPeopleByTopic(db, member, 'helse', { plan: health }))[0]!.personId).toBe(
      siri,
    )
    const oslo = await searchPeopleByTopic(db, member, 'noen i oslo', {
      plan: plan({ cities: ['Oslo'] }),
    })
    expect(oslo.map((h) => h.personId).sort()).toEqual([kari, siri].sort())
    expect(oslo[0]).toMatchObject({ matchedBy: 'filter', reason: 'Oslo' })

    const cohort = await searchPeopleByTopic(db, member, 'es 2016 i bergen', {
      plan: plan({ cities: ['bergen'], cohortFrom: 2016, cohortTo: 2016 }),
    })
    expect(cohort.map((h) => [h.personId, h.reason])).toEqual([[ola, 'bergen · ES 2016']])

    const founders = await searchPeopleByTopic(db, member, 'gründere', {
      plan: plan({ founder: true }),
    })
    expect(founders.map((h) => h.personId)).toEqual([kari])

    // Emne og filter sammen: salg i Bergen finner ikke Siri i Oslo.
    expect(
      await searchPeopleByTopic(db, member, 'salg i bergen', {
        plan: plan({ topics: [{ term: 'salg', related: [] }], cities: ['Bergen'] }),
      }),
    ).toEqual([])

    // En tolkning uten emner og filtre (et navn) gir vanlig søk.
    expect((await searchPeopleByTopic(db, member, 'siri', { plan: plan({}) }))[0]).toMatchObject({
      personId: siri,
      matchedBy: 'name',
    })
    expect(
      tidyPlan(plan({ cohortFrom: 2020, cohortTo: 2010, cities: [' Oslo ', 'Oslo'] })),
    ).toEqual(plan({ cohortFrom: 2010, cohortTo: 2020, cities: ['Oslo'] }))
  })

  it('samme søk tolkes én gang; feil gir vanlig søk', async () => {
    const { siri } = await seed()
    const { ai, calls } = fakeAi({
      interpretQuery: async (q) => {
        calls.interpret.push(q)
        return plan({ topics: [{ term: 'helse', related: ['sykehus'] }], cities: ['Oslo'] })
      },
    })
    const first = await searchPeopleInterpreted(db, member, 'Helse i Oslo', { ai })
    expect(first.hits[0]!.personId).toBe(siri)
    expect(first.interpreted).toEqual({ topics: ['helse'], filters: 'Oslo' })
    await searchPeopleInterpreted(db, member, '  helse   i oslo ', { ai })
    expect(calls.interpret).toHaveLength(1)

    const failing = fakeAi({
      interpretQuery: async () => {
        throw new Error('tidsavbrudd')
      },
    }).ai
    const fallback = await searchPeopleInterpreted(db, member, 'sykehus', { ai: failing })
    expect(fallback).toMatchObject({ interpreted: null, hits: [{ personId: siri }] })
    expect(await interpretQuery(null, 'sykehus', 'x')).toBeNull()
    // Ikke-medlemmer kommer ikke så langt at noe sendes til Claude.
    await expect(searchPeopleInterpreted(db, null, 'helse', { ai })).rejects.toThrow()
  })

  it('Spør ESAF: Claude velger blant kandidatene, med grunnen, og har en kvote', async () => {
    const { kari } = await seed()
    const { ai, calls } = fakeAi({
      interpretQuery: async () =>
        plan({ topics: [{ term: 'romfart', related: ['rakett', 'Rakettverket'] }] }),
    })
    const seen: string[][] = []
    const rank = ai.rankCandidates
    ai.rankCandidates = async (q, candidates) => {
      seen.push(candidates.flatMap((c) => c.text))
      return rank(q, candidates)
    }
    const answer = await askPeople(db, member, 'Hvem kan noe om romfart?', { ai })
    expect(answer).toMatchObject({
      summary: 'Fant én som passer.',
      filters: null,
      hits: [{ personId: kari, why: 'Grunnla et romfartsselskap.', strong: true }],
    })
    expect(seen[0]!.join(' ')).toContain('Rakettverket')
    expect(seen[0]!.join(' ')).not.toContain('Kari') // navn sendes ikke
    expect(calls.rank).toEqual(['Hvem kan noe om romfart?'])

    await expect(askPeople(db, member, 'romfart', { ai: null })).rejects.toBeInstanceOf(DomainError)
    await expect(askPeople(db, null, 'romfart', { ai })).rejects.toThrow()
    for (let i = 1; i < ASK_PER_HOUR; i++) await askPeople(db, member, 'romfart', { ai })
    await expect(askPeople(db, member, 'romfart', { ai })).rejects.toThrow('mange ganger')
  })
})
