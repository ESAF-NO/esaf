import { randomUUID } from 'node:crypto'
import { createDb, loadRootEnv, runMigrations, schema, type Db } from '@esaf/db'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccessDeniedError,
  createCompany,
  createProfileBatch,
  decideMembership,
  getUniverse,
  grantRoleAsOperator,
  listPeopleForTopics,
  loadViewer,
  reindexPeople,
  searchPeopleByTopic,
  setSearchTopics,
  type Embedder,
  type ObjectStorage,
  type Viewer,
} from '../src/index.ts'
import { redact } from '../src/people-search.ts'

loadRootEnv()
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

const storage: ObjectStorage = {
  put: async () => {},
  get: async () => null,
  delete: async () => {},
}

/**
 * En forutsigbar modell til testene: hvert «begrep» er én dimensjon, og ord som
 * hører til samme begrep (space, romfart, rakett, NASA) havner der. Tekst uten
 * begreper ligner nesten ikke på noe.
 */
const concepts: Record<string, string[]> = {
  space: ['space', 'romfart', 'rakett', 'rocket', 'satellitt', 'nasa', 'aerospace'],
  fish: ['fisk', 'oppdrett', 'salmon', 'laks', 'aquaculture'],
  music: ['musikk', 'music', 'band', 'jazz'],
  // Ord som ikke står i begrepslisten, så bare «modellen» kan koble dem.
  cosmos: ['kosmos', 'univers', 'galakse'],
}
const names = Object.keys(concepts)
const fakeEmbedder = (calls: string[][] = []): Embedder => ({
  model: 'test-model',
  async embed(texts) {
    calls.push(texts)
    return texts.map((t) => {
      // Begrepene, og en svak «ordsekk» så tekster uten begreper ikke blir like.
      const v = new Float32Array(names.length + 1 + 32)
      v[0] = 0.3
      const words = t
        .toLowerCase()
        .split(/[^a-zæøå]+/)
        .filter(Boolean)
      names.forEach((n, i) => {
        v[i + 1] = words.filter((w) => concepts[n]!.some((c) => w.startsWith(c))).length * 3
      })
      for (const w of words) {
        let h = 0
        for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0
        v[names.length + 1 + (h % 32)]! += 0.3
      }
      const len = Math.hypot(...v)
      return v.map((x) => x / len)
    })
  },
})

describe.skipIf(!url)('personsøk og ES-universet', () => {
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
    await db.execute(
      sql`truncate ${schema.personSearchIndex}, ${schema.auditEvent}, ${schema.membership}, ${schema.personCohort}, ${schema.person}, ${schema.cohort}, ${schema.user}, ${schema.company}, ${schema.companyEvent} cascade`,
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
      tagline: 'Rakettmotorer for små satellitter',
      description: null,
      website: null,
      foundedYear: 2015,
      location: null,
      industries: ['Romfart'],
      status: 'active',
    })
    const result = await createProfileBatch(db, storage, admin, [
      {
        fullName: 'Kari Rakett',
        cohorts: [{ graduationYear: 2014 }],
        experience: [{ companyId: rocketId, company: 'Rakettverket', title: 'CTO', founder: true }],
        bio: 'Kari liker å gå på ski. Ring meg på 412 34 567 eller kari@example.com.',
      },
      {
        fullName: 'Ola Laks',
        cohorts: [{ graduationYear: 2016 }],
        bio: 'Ola har jobbet med oppdrett av laks i ti år. Han er også fascinert av universet.',
      },
      { fullName: 'Per Uten', cohorts: [{ graduationYear: 2016 }] },
      {
        fullName: 'Pia Venter',
        status: 'pending',
        bio: 'Pia lager musikk og spiller i band om kveldene.',
      },
      // Andre i kullene, så treffene kan sammenlignes med et realistisk utvalg.
      ...[
        'Jobber med regnskap og revisjon for små bedrifter i Bergen.',
        'Har bakgrunn fra bygg og anlegg, og leder prosjekter for kommunen.',
        'Driver en nettbutikk med klær og er opptatt av bærekraftig mote.',
        'Underviser i matematikk og utvikler læremidler for videregående.',
        'Jobber som advokat med kontrakter og selskapsrett i Oslo.',
        'Selger forsikring til bedrifter og liker å seile om sommeren.',
        'Er produktsjef i et programvareselskap som lager verktøy for HR.',
        'Har startet et eiendomsselskap som pusser opp gamle bygårder.',
        'Jobber med logistikk og transport i en stor dagligvarekjede.',
        'Er lege på et sykehus og forsker på hjerte og kar.',
      ].map((bio, i) => ({
        fullName: `Annen Person ${i + 1}`,
        cohorts: [{ graduationYear: 2018 }],
        bio,
      })),
    ])
    const id = (name: string) => result.rows.find((r) => r.fullName === name)!.personId!
    return {
      rocketId,
      kari: id('Kari Rakett'),
      ola: id('Ola Laks'),
      per: id('Per Uten'),
      pia: id('Pia Venter'),
    }
  }

  it('indekserer bare det som er endret, og tar ut folk uten tekst', async () => {
    const { ola } = await seed()
    const calls: string[][] = []
    const embedder = fakeEmbedder(calls)
    const first = await reindexPeople(db, embedder)
    expect(first.indexed).toBe(13) // Per har ingen tekst; Medlem og Admin heller ikke.
    expect(await reindexPeople(db, embedder)).toMatchObject({ indexed: 0 })

    await db
      .update(schema.person)
      .set({ bio: 'Ola driver med musikk nå.' })
      .where(eq(schema.person.id, ola))
    calls.length = 0
    expect(await reindexPeople(db, embedder)).toMatchObject({ indexed: 1 })
    expect(calls.flat().join(' ')).toContain('musikk')
    // Ny modell betyr ny indeks for alle.
    expect(await reindexPeople(db, { ...embedder, model: 'annen' })).toMatchObject({ indexed: 13 })
  })

  it('finner folk på mening, med grunnen, og navnetreff først', async () => {
    const { kari, ola } = await seed()
    const embedder = fakeEmbedder()
    await reindexPeople(db, embedder)

    // «space» står ingen steder, men begrepet romfart har «rakett», som står i selskapet.
    const space = await searchPeopleByTopic(db, member, 'space', { embedder })
    expect(space[0]).toMatchObject({ personId: kari, matchedBy: 'text' })
    expect(space[0]!.reason).toContain('Rakettverket')
    expect(space.map((h) => h.personId)).not.toContain(ola)
    // På norsk og som en setning, med stoppord.
    expect(
      (await searchPeopleByTopic(db, member, 'noen som jobber med romfart', { embedder }))[0]!
        .personId,
    ).toBe(kari)
    expect((await searchPeopleByTopic(db, member, 'aquaculture', { embedder }))[0]!.personId).toBe(
      ola,
    )

    // Bare mening: «galakse» står verken i teksten eller i begrepslisten.
    const meaning = await searchPeopleByTopic(db, member, 'galakse', { embedder })
    expect(meaning[0]).toMatchObject({ personId: ola, matchedBy: 'meaning' })
    expect(meaning[0]!.reason).toContain('universet')

    const words = await searchPeopleByTopic(db, member, 'oppdrett', { embedder })
    expect(words[0]).toMatchObject({ personId: ola, matchedBy: 'text' })

    const name = await searchPeopleByTopic(db, member, 'kari', { embedder })
    expect(name[0]).toMatchObject({ personId: kari, matchedBy: 'name', reason: null })

    // Uten modell er det et rent ordsøk, fortsatt med begrepene.
    expect(await searchPeopleByTopic(db, member, 'galakse')).toEqual([])
    expect((await searchPeopleByTopic(db, member, 'space'))[0]!.personId).toBe(kari)
  })

  it('medlemmer finner bare aktive medlemmer; admins finner alle', async () => {
    const { pia } = await seed()
    const embedder = fakeEmbedder()
    await reindexPeople(db, embedder)
    expect(
      (await searchPeopleByTopic(db, member, 'jazz', { embedder })).map((h) => h.personId),
    ).not.toContain(pia)
    expect((await searchPeopleByTopic(db, admin, 'jazz', { embedder }))[0]!.personId).toBe(pia)
  })

  it('kontaktinfo i bioen kommer aldri med i søket', async () => {
    const { kari } = await seed()
    await reindexPeople(db, fakeEmbedder())
    const [row] = await db
      .select()
      .from(schema.personSearchIndex)
      .where(eq(schema.personSearchIndex.personId, kari))
    const text = JSON.stringify(row!.chunks)
    expect(text).not.toContain('412 34 567')
    expect(text).not.toContain('kari@example.com')
    expect(redact('Ring 412 34 567, eller +47 41234567. Født 1990.')).toBe(
      'Ring [telefon], eller [telefon]. Født 1990.',
    )
    expect(await searchPeopleByTopic(db, admin, '41234567')).toEqual([])
  })

  it('søkeord settes av admins, logges, og gjør at personen blir funnet', async () => {
    const { per } = await seed()
    const embedder = fakeEmbedder()
    expect(await searchPeopleByTopic(db, member, 'kvantekryptografi', { embedder })).toEqual([])
    await expect(
      setSearchTopics(db, member, [{ personId: per, topics: ['romfart'] }]),
    ).rejects.toBeInstanceOf(AccessDeniedError)

    const todo = await listPeopleForTopics(db, admin)
    expect(todo.items.map((p) => p.fullName)).toContain('Ola Laks')
    expect(todo.items.map((p) => p.fullName)).not.toContain('Per Uten') // ingenting å skrive ut fra

    expect(
      await setSearchTopics(db, admin, [
        { personId: per, topics: ['kvantekryptografi', 'romfart', 'Space', 'space'] },
      ]),
    ).toEqual({ updated: 1 })
    const [row] = await db
      .select({ t: schema.person.searchTopics })
      .from(schema.person)
      .where(eq(schema.person.id, per))
    expect(row!.t).toEqual(['Kvantekryptografi', 'Romfart', 'Space'])
    expect(
      await setSearchTopics(db, admin, [
        { personId: per, topics: ['kvantekryptografi', 'Romfart', 'space'] },
      ]),
    ).toEqual({
      updated: 0,
    })
    const [logged] = await db
      .select()
      .from(schema.auditEvent)
      .where(eq(schema.auditEvent.action, 'profile.search_topics'))
    expect(logged!.subjectPersonId).toBe(per)

    await reindexPeople(db, embedder)
    const exact = await searchPeopleByTopic(db, member, 'kvantekryptografi', { embedder })
    expect(exact[0]).toMatchObject({ personId: per, matchedBy: 'text' })
    expect(exact[0]!.reason).toContain('Kvantekryptografi')
    // Søkeordet «Romfart» treffer direkte, og står over et treff via et synonym.
    const topic = await searchPeopleByTopic(db, member, 'romfart', { embedder })
    expect(topic[0]!.personId).toBe(per)
  })

  it('søkeord blir utdaterte når profilen endres, og kommer tilbake i lista', async () => {
    const { per, ola } = await seed()
    const statusOf = async (personId: string) =>
      (await listPeopleForTopics(db, admin, { status: 'all', limit: 100 })).items.find(
        (i) => i.personId === personId,
      )?.status

    expect(await statusOf(ola)).toBe('missing')
    expect(await statusOf(per)).toBeUndefined() // bare navn og kull: ingenting å gå på
    const start = await listPeopleForTopics(db, admin)
    expect(start.counts).toMatchObject({ outdated: 0, done: 0 })
    expect(start.total).toBe(start.counts.missing)

    await setSearchTopics(db, admin, [{ personId: ola, topics: ['oppdrett', 'aquaculture'] }])
    expect(await statusOf(ola)).toBe('done')
    expect((await listPeopleForTopics(db, admin)).items.map((i) => i.personId)).not.toContain(ola)

    // Ny tekst på profilen: søkeordene er kanskje ikke riktige lenger.
    await db
      .update(schema.person)
      .set({ bio: 'Ola har startet et selskap som lager programvare for sykehus.' })
      .where(eq(schema.person.id, ola))
    expect(await statusOf(ola)).toBe('outdated')
    const outdated = await listPeopleForTopics(db, admin, { status: 'outdated' })
    expect(outdated.items).toEqual([
      expect.objectContaining({
        personId: ola,
        currentTopics: ['Oppdrett', 'Aquaculture'],
        text: [expect.stringContaining('sykehus')],
      }),
    ])

    // Samme søkeord bekreftes for den nye teksten uten ny hendelse i loggen;
    // en tom liste betyr «vurdert, ingenting å legge til».
    const logged = async () =>
      (
        await db
          .select()
          .from(schema.auditEvent)
          .where(eq(schema.auditEvent.action, 'profile.search_topics'))
      ).length
    expect(
      await setSearchTopics(db, admin, [{ personId: ola, topics: ['Oppdrett', 'Aquaculture'] }]),
    ).toEqual({ updated: 0 })
    expect(await statusOf(ola)).toBe('done')
    expect(await logged()).toBe(1)
    await db
      .update(schema.person)
      .set({ bio: 'Ola er pensjonert og bor på hytta.' })
      .where(eq(schema.person.id, ola))
    expect(await setSearchTopics(db, admin, [{ personId: ola, topics: [] }])).toEqual({
      updated: 1,
    })
    expect(await statusOf(ola)).toBe('done')

    await expect(
      setSearchTopics(db, admin, [
        { personId: ola, topics: ['a1'] },
        { personId: ola, topics: ['b2'] },
      ]),
    ).rejects.toThrow('Samme person')
  })

  it('ES-universet: aktive medlemmer, selskapene og usikre hendelser bare for admins', async () => {
    const { rocketId, kari, pia } = await seed()
    await db.insert(schema.companyEvent).values([
      {
        companyId: rocketId,
        date: '2019-03-01',
        type: 'funding',
        text: 'Hentet 20 MNOK',
        confidence: 'low',
      },
      {
        companyId: rocketId,
        date: '2021-01-01',
        type: 'award',
        text: 'Årets gründer',
        confidence: 'high',
      },
    ])
    const forMember = await getUniverse(db, member)
    expect(forMember.people.map((p) => p.id)).toContain(kari)
    expect(forMember.people.map((p) => p.id)).not.toContain(pia)
    expect(forMember.companies).toEqual([
      expect.objectContaining({
        id: rocketId,
        founded: 2015,
        milestones: [expect.objectContaining({ type: 'award', uncertain: false })],
      }),
    ])
    expect(forMember.links).toEqual([
      { personId: kari, companyId: rocketId, role: 'founder', from: null, to: null },
    ])
    expect(forMember.firstYear).toBe(2012)
    expect(JSON.stringify(forMember)).not.toContain('412 34')

    const forAdmin = await getUniverse(db, admin)
    expect(forAdmin.companies[0]!.milestones.map((m) => [m.type, m.uncertain])).toEqual([
      ['funding', true],
      ['award', false],
    ])
  })
})
