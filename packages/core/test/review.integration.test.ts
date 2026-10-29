import { randomUUID } from 'node:crypto'
import { createDb, loadRootEnv, runMigrations, schema, type Db } from '@esaf/db'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccessDeniedError,
  addPersonEmail,
  clearImportedField,
  companyCoreKey,
  confirmCompanyEvent,
  confirmQuote,
  createCompany,
  createProfile,
  decideMembership,
  deleteCompany,
  dismissDuplicate,
  findSimilarPeople,
  getCompany,
  getPersonAdmin,
  getProfile,
  grantRoleAsOperator,
  listAdminCompanies,
  listPeopleForAdmin,
  listReview,
  loadViewer,
  markSourcesReviewed,
  mergeCompanies,
  mergePeople,
  removePersonEmail,
  requestCompanyLink,
  reviewCounts,
  setPersonCohorts,
  suggestCompanyEvent,
  updateProfile,
  type CompanyInput,
  type ObjectStorage,
  type ProfileInput,
  type ReviewPage,
  type Viewer,
} from '../src/index.ts'

loadRootEnv()
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

const deleted: string[] = []
const storage: ObjectStorage = {
  put: () => Promise.resolve(),
  get: () => Promise.resolve(null),
  delete: (key: string) => {
    deleted.push(key)
    return Promise.resolve()
  },
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

const info: CompanyInput = {
  name: 'Nytt Selskap',
  tagline: '',
  description: '',
  website: '',
  foundedYear: null,
  location: '',
  industries: [],
  status: 'unknown',
}

describe.skipIf(!url)('gjennomgang og adminverktøy for data', () => {
  let db: Db
  let admin: Viewer
  let weakAdmin: Viewer
  let ola: Viewer
  let kari: Viewer

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

  beforeEach(async () => {
    deleted.length = 0
    await db.execute(
      sql`truncate ${schema.fieldSource}, ${schema.auditEvent}, ${schema.membership}, ${schema.personCohort}, ${schema.person}, ${schema.cohort}, ${schema.user}, ${schema.company}, ${schema.reviewDismissal} cascade`,
    )
    await account('Admin')
    await grantRoleAsOperator(db, { email: 'admin@example.test', reason: 'test', role: 'admin' })
    await db
      .update(schema.user)
      .set({ twoFactorEnabled: true })
      .where(eq(schema.user.email, 'admin@example.test'))
    admin = await loadViewer(db, (await db.select().from(schema.user))[0]!.id)
    weakAdmin = { ...admin!, twoFactorEnabled: false, passkeySession: false }
    ola = await member('Ola')
    kari = await member('Kari')
  })

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

  async function company(name: string, values: Partial<typeof schema.company.$inferInsert> = {}) {
    const { id } = await createCompany(db, admin, { ...info, name })
    if (Object.keys(values).length) {
      await db.update(schema.company).set(values).where(eq(schema.company.id, id))
    }
    return id
  }

  async function review<K extends ReviewPage['kind']>(kind: K, page = 1) {
    return (await listReview(db, admin, kind, page)) as Extract<ReviewPage, { kind: K }>
  }

  it('bare admins med sterk innlogging får bruke verktøyene', async () => {
    const companyId = await company('Syrlig')
    const calls: [string, (v: Viewer) => Promise<unknown>][] = [
      ['reviewCounts', (v) => reviewCounts(db, v)],
      ['listReview', (v) => listReview(db, v, 'sources')],
      ['listAdminCompanies', (v) => listAdminCompanies(db, v)],
      ['createCompany', (v) => createCompany(db, v, { ...info, name: `Ny ${randomUUID()}` })],
      ['listPeopleForAdmin', (v) => listPeopleForAdmin(db, v)],
      [
        'createProfile',
        (v) =>
          createProfile(db, v, {
            fullName: 'Ny Person',
            cohorts: [],
            emails: [],
            status: 'active',
          }),
      ],
      ['setPersonCohorts', (v) => setPersonCohorts(db, v, kari!.personId!, [])],
      ['getPersonAdmin', (v) => getPersonAdmin(db, v, kari!.personId!)],
      [
        'mergePeople',
        (v) => mergePeople(db, storage, v, { sourceId: kari!.personId!, targetId: ola!.personId! }),
      ],
      ['deleteCompany', (v) => deleteCompany(db, storage, v, { companyId, unlink: false })],
    ]
    for (const [name, call] of calls) {
      expect([name, await denial(call(ola))]).toEqual([name, 'forbidden'])
      expect([name, await denial(call(weakAdmin))]).toEqual([name, 'strong_auth_required'])
    }
  })

  describe('kø', () => {
    it('usikre hendelser og sitater godkjennes eller forkastes, og det logges', async () => {
      const companyId = await company('Syrlig')
      const [low, other] = await db
        .insert(schema.companyEvent)
        .values([
          { companyId, date: '2019-01-01', type: 'funding', text: 'Kanskje', confidence: 'low' },
          { companyId, date: '2020-01-01', type: 'award', text: 'Usikker', confidence: 'low' },
        ])
        .returning()
      const [q] = await db
        .insert(schema.quote)
        .values({ text: 'Sitat', speakerName: 'Kari', personId: kari!.personId, confidence: 'low' })
        .returning()

      const counts = await reviewCounts(db, admin)
      expect(counts).toMatchObject({ events: 2, quotes: 1 })
      expect((await review('events')).items.map((e) => e.text)).toEqual(['Kanskje', 'Usikker'])

      await confirmCompanyEvent(db, admin, low!.id)
      expect(await audit('company.admin_event_confirm')).toHaveLength(1)
      await expect(confirmCompanyEvent(db, admin, low!.id)).rejects.toThrow(/allerede/)
      expect((await review('events')).total).toBe(1)
      void other

      expect(await denial(confirmQuote(db, ola, q!.id))).toBe('forbidden')
      await confirmQuote(db, admin, q!.id)
      expect((await getProfile(db, ola, kari!.personId!)).quotes).toHaveLength(1)
      const [logged] = await audit('quote.confirm')
      expect(logged!.subjectPersonId).toBe(kari!.personId)
      expect((await reviewCounts(db, admin)).quotes).toBe(0)
    })

    it('importerte felt per person og selskap: sett over, eller fjern', async () => {
      const companyId = await company('Syrlig', {
        description: 'Fra nettet',
        website: 'https://syrlig.no',
      })
      await updateProfile(db, admin, kari!.personId!, {
        ...emptyProfile,
        fullName: 'Kari',
        bio: 'Importert bio',
        city: 'Trondheim',
      })
      await db.insert(schema.fieldSource).values([
        {
          entityType: 'person',
          entityId: kari!.personId!,
          field: 'bio',
          sourceLabel: 'es.no',
          confidence: 'low',
        },
        {
          entityType: 'person',
          entityId: kari!.personId!,
          field: 'city',
          sourceLabel: 'kullisten',
          confidence: 'high',
        },
        // Kontaktinfo vises aldri i køen.
        {
          entityType: 'person',
          entityId: kari!.personId!,
          field: 'phone',
          sourceLabel: 'kullisten',
          confidence: 'high',
        },
        {
          entityType: 'company',
          entityId: companyId,
          field: 'description',
          sourceLabel: 'es.no',
          confidence: 'medium',
        },
        {
          entityType: 'company',
          entityId: companyId,
          field: 'website',
          sourceLabel: 'es.no',
          confidence: 'medium',
        },
        // Bekreftet av eieren: ikke i køen.
        {
          entityType: 'person',
          entityId: ola!.personId!,
          field: 'bio',
          sourceLabel: 'es.no',
          confidence: 'low',
          confirmedAt: new Date(),
        },
      ])
      const groups = (await review('sources')).items
      expect(groups.map((g) => [g.entityType, g.name])).toEqual([
        ['company', 'Syrlig'],
        ['person', 'Kari'],
      ])
      const kariGroup = groups[1]!
      expect(kariGroup.fields.map((f) => [f.field, f.value])).toEqual([
        ['bio', 'Importert bio'],
        ['city', 'Trondheim'],
      ])
      expect(kariGroup.fields[0]!.sources[0]!.confidence).toBe('low')

      expect(
        await markSourcesReviewed(db, admin, {
          entityType: 'person',
          entityId: kari!.personId!,
          fields: ['city'],
        }),
      ).toBe(1)
      await clearImportedField(db, admin, {
        entityType: 'person',
        entityId: kari!.personId!,
        field: 'bio',
      })
      const profile = await getProfile(db, kari, kari!.personId!)
      expect(profile.bio).toBeNull()
      // Sett over er ikke en bekreftelse fra eieren.
      expect(profile.sources.find((s) => s.field === 'city')!.confirmed).toBe(false)
      expect(await audit('profile.admin_clear_field')).toHaveLength(1)
      expect(await audit('source.review')).toHaveLength(1)

      await expect(
        clearImportedField(db, admin, {
          entityType: 'company',
          entityId: companyId,
          field: 'name',
        }),
      ).rejects.toThrow(/redigeringssiden/)
      await clearImportedField(db, admin, {
        entityType: 'company',
        entityId: companyId,
        field: 'website',
      })
      await markSourcesReviewed(db, admin, { entityType: 'company', entityId: companyId })
      const found = await getCompany(db, kari, 'syrlig')
      expect('website' in found && found.website).toBeNull()
      expect((await review('sources')).total).toBe(0)
      const [cleared] = await audit('company.admin_clear_field')
      expect(cleared!.details).toMatchObject({ companyId, field: 'website' })
    })

    it('forslag og tilknytninger til profiler uten konto står i køen', async () => {
      const companyId = await company('Syrlig')
      await suggestCompanyEvent(db, kari, companyId, {
        year: 2020,
        month: null,
        day: null,
        type: 'launch',
        text: 'Lanserte',
        sourceUrl: '',
        sourceLabel: '',
      })
      const { personId } = await createProfile(db, admin, {
        fullName: 'Uten Konto',
        cohorts: [],
        emails: [],
        status: 'active',
      })
      for (const target of [personId, ola!.personId!]) {
        await requestCompanyLink(db, kari, companyId, {
          personId: target,
          role: 'employee',
          title: null,
          startYear: null,
          endYear: null,
        })
      }
      const counts = await reviewCounts(db, admin)
      expect(counts).toMatchObject({ suggestions: 1, links: 1 })
      expect((await review('links')).items[0]!.person.personId).toBe(personId)
    })

    it('sider på 20', async () => {
      const companyId = await company('Syrlig')
      await db.insert(schema.companyEvent).values(
        Array.from({ length: 25 }, (_, i) => ({
          companyId,
          date: `${2000 + i}-01-01`,
          type: 'other' as const,
          text: `Hendelse ${i}`,
          confidence: 'low' as const,
        })),
      )
      expect((await review('events', 1)).items).toHaveLength(20)
      const second = await review('events', 2)
      expect(second.items).toHaveLength(5)
      expect(second.total).toBe(25)
    })
  })

  describe('duplikater', () => {
    it('finner selskaper med samme navn, nettside eller nesten lik slug, og husker avvisninger', async () => {
      expect(companyCoreKey('Statkraft AS')).toBe('statkraft')
      const a = await company('Statkraft')
      const b = await company('Statkraft AS')
      const c = await company('Kahoot', { website: 'https://www.kahoot.com' })
      const d = await company('Getkahoot', { website: 'https://kahoot.com/' })
      const e = await company('Optoscale')
      const f = await company('OptoScaIe')
      await company('Helt Annet')
      const pairs = (await review('companyDuplicates')).items
      const ids = (p: (typeof pairs)[number]) => [p.first.id, p.second.id].sort()
      expect(pairs.map(ids)).toEqual(
        expect.arrayContaining([[a, b].sort(), [c, d].sort(), [e, f].sort()]),
      )
      expect(pairs).toHaveLength(3)
      expect(pairs.find((p) => ids(p).includes(c))!.reasons).toEqual(['website'])

      await dismissDuplicate(db, admin, { kind: 'company_duplicate', firstId: d, secondId: c })
      expect((await review('companyDuplicates')).total).toBe(2)
      expect(await audit('review.dismiss_duplicate')).toHaveLength(1)

      await mergeCompanies(db, storage, admin, { sourceId: b, targetId: a })
      expect((await reviewCounts(db, admin)).companyDuplicates).toBe(1)
    })

    it('finner personer med samme navn og nære kull, samme e-post eller LinkedIn', async () => {
      const profile = (fullName: string, years: number[], emails: string[] = []) =>
        createProfile(db, admin, {
          fullName,
          cohorts: years.map((graduationYear) => ({
            graduationYear,
            relation: 'student' as const,
          })),
          emails,
          status: 'active',
        }).then((r) => r.personId)
      const a = await profile('Åse Ødegård', [2016])
      const b = await profile('Ase Odegard', [2017])
      await profile('Åse Ødegård', [2010]) // For langt unna i kull.
      const c = await profile('Per Johan Hansen', [2012])
      const d = await profile('Per Hansen', [2012])
      const e = await profile('Lise Lund', [], ['lise.lund@gmail.com'])
      const f = await profile('L. Lund', [], [])
      await db
        .update(schema.person)
        .set({ contactEmail: 'liselund+es@gmail.com' })
        .where(eq(schema.person.id, f))
      const g = await profile('Tor', [])
      await db
        .update(schema.person)
        .set({ linkedinUrl: 'https://www.linkedin.com/in/kari-nordmann' })
        .where(eq(schema.person.id, g))
      await db
        .update(schema.person)
        .set({ linkedinUrl: 'https://no.linkedin.com/in/Kari-Nordmann/' })
        .where(eq(schema.person.id, kari!.personId!))

      const pairs = (await review('personDuplicates')).items
      const reasonsFor = (x: string, y: string) =>
        pairs.find(
          (p) => [p.first.personId, p.second.personId].sort().join() === [x, y].sort().join(),
        )?.reasons
      expect(reasonsFor(a, b)).toEqual(['name'])
      expect(reasonsFor(c, d)).toEqual(['firstLast'])
      expect(reasonsFor(e, f)).toEqual(['email'])
      expect(reasonsFor(g, kari!.personId!)).toEqual(['linkedin'])
      expect(pairs).toHaveLength(4)

      expect(
        (await findSimilarPeople(db, admin, { fullName: 'ase odegard', years: [2015] })).map(
          (p) => p.personId,
        ),
      ).toEqual([a])

      await dismissDuplicate(db, admin, { kind: 'person_duplicate', firstId: a, secondId: b })
      expect((await reviewCounts(db, admin)).personDuplicates).toBe(3)
    })
  })

  describe('selskaper', () => {
    it('lister alle selskaper med det som mangler, oppretter og avviser navn som finnes', async () => {
      await updateProfile(db, ola, ola!.personId!, {
        ...emptyProfile,
        fullName: 'Ola',
        esCompany: 'Syrlig',
        experience: [
          { company: 'Syrlig', title: null, startYear: null, endYear: null, founder: true },
        ],
      })
      await setPersonCohorts(db, admin, ola!.personId!, [
        { graduationYear: 2016, relation: 'student' },
      ])
      await company('Tomt')
      const list = await listAdminCompanies(db, admin)
      expect(
        list.map((c) => [
          c.name,
          c.people,
          c.founders,
          c.esCompany,
          c.cohortYears,
          c.hasDescription,
        ]),
      ).toEqual([
        ['Syrlig', 1, 1, true, [2016], false],
        ['Tomt', 0, 0, false, [], false],
      ])
      await expect(createCompany(db, admin, { ...info, name: 'syrlig' })).rejects.toThrow(
        /finnes allerede/,
      )
      const [created] = await audit('company.create')
      expect(created!.details).toMatchObject({ name: 'Tomt', slug: 'tomt' })
    })

    it('sletter bare med bekreftelse når noen er knyttet til selskapet, og logger det', async () => {
      await updateProfile(db, ola, ola!.personId!, {
        ...emptyProfile,
        fullName: 'Ola',
        esCompany: 'Syrlig',
        experience: [
          { company: 'Syrlig', title: null, startYear: null, endYear: null, founder: true },
        ],
      })
      const [syrlig] = await db
        .select()
        .from(schema.company)
        .where(eq(schema.company.slug, 'syrlig'))
      await db
        .update(schema.company)
        .set({ logoKey: 'logo123' })
        .where(eq(schema.company.id, syrlig!.id))
      await db
        .insert(schema.quote)
        .values({ text: 'Sitat', speakerName: 'Ola', companyId: syrlig!.id })
      await expect(
        deleteCompany(db, storage, admin, { companyId: syrlig!.id, unlink: false }),
      ).rejects.toThrow(/knyttet til 2 profiler/)
      await expect(
        deleteCompany(db, storage, admin, { companyId: syrlig!.id, unlink: true }),
      ).rejects.toThrow(/begrunnelse/)
      await deleteCompany(db, storage, admin, {
        companyId: syrlig!.id,
        unlink: true,
        reason: 'Feil',
      })
      const profile = await getProfile(db, ola, ola!.personId!)
      expect(profile.experience).toHaveLength(0)
      expect(profile.esCompany).toBeNull()
      const [quote] = await db.select().from(schema.quote)
      expect(quote!.companyId).toBeNull()
      expect(deleted.some((key) => key.includes('logo123'))).toBe(true)
      const [logged] = await audit('company.delete')
      expect(logged!.details).toMatchObject({
        name: 'Syrlig',
        reason: 'Feil',
        experience: 1,
        esTeam: 1,
        quotes: 1,
        people: [ola!.personId],
      })

      const empty = await company('Tomt')
      await deleteCompany(db, storage, admin, { companyId: empty, unlink: false })
      expect((await listAdminCompanies(db, admin)).map((c) => c.name)).toEqual([])
    })
  })

  describe('personer', () => {
    it('lager profiler, retter kull og e-post, og logger alt', async () => {
      const { personId } = await createProfile(db, admin, {
        fullName: 'Nina Ny',
        cohorts: [{ graduationYear: 2018, relation: 'student' }],
        emails: ['Nina@Example.test'],
        status: 'active',
      })
      await expect(
        createProfile(db, admin, {
          fullName: 'Kopi',
          cohorts: [],
          emails: ['nina@example.test'],
          status: 'active',
        }),
      ).rejects.toThrow(/hører allerede til Nina Ny/)
      expect((await getProfile(db, kari, personId)).cohorts).toEqual([
        { graduationYear: 2018, relation: 'student' },
      ])

      await setPersonCohorts(db, admin, personId, [
        { graduationYear: 2018, relation: 'student' },
        { graduationYear: 2022, relation: 'mentor' },
      ])
      await addPersonEmail(db, admin, personId, 'nina@ntnu.example.test')
      await expect(addPersonEmail(db, admin, personId, 'kari@example.test')).rejects.toThrow(/Kari/)
      await removePersonEmail(db, admin, personId, 'nina@example.test')
      const details = await getPersonAdmin(db, admin, personId)
      expect(details.cohorts.map((c) => c.graduationYear)).toEqual([2018, 2022])
      expect(details.emails.map((e) => e.email)).toEqual(['nina@ntnu.example.test'])
      expect(details.source).toBe('admin')

      // Adressen kontoen logger inn med, kan ikke fjernes.
      await expect(
        removePersonEmail(db, admin, kari!.personId!, 'kari@example.test'),
      ).rejects.toThrow(/logger inn med/)
      for (const action of [
        'profile.create',
        'profile.admin_cohorts',
        'profile.admin_email_add',
        'profile.admin_email_remove',
      ]) {
        expect([action, (await audit(action)).length]).toEqual([action, 1])
      }
      const [cohorts] = await audit('profile.admin_cohorts')
      expect(cohorts!.details).toEqual({ from: ['2018'], to: ['2018', '2022 (mentor)'] })
    })

    it('slår sammen duplikater og beholder kontoen', async () => {
      // Profilen fra kullisten (uten konto) har det meste; Kari har konto.
      const { personId: profile } = await createProfile(db, admin, {
        fullName: 'Kari Nordmann',
        cohorts: [
          { graduationYear: 2016, relation: 'student' },
          { graduationYear: 2020, relation: 'mentor' },
        ],
        emails: ['kari.nordmann@example.test'],
        status: 'active',
      })
      await setPersonCohorts(db, admin, kari!.personId!, [
        { graduationYear: 2016, relation: 'student' },
      ])
      await updateProfile(db, admin, profile, {
        ...emptyProfile,
        fullName: 'Kari Nordmann',
        bio: 'Fra kullisten',
        city: 'Oslo',
        experience: [
          { company: 'Syrlig', title: 'Gründer', startYear: 2016, endYear: null, founder: true },
          { company: 'Equinor', title: null, startYear: 2010, endYear: 2014, founder: false },
        ],
      })
      await updateProfile(db, kari, kari!.personId!, {
        ...emptyProfile,
        fullName: 'Kari',
        city: 'Trondheim',
        experience: [
          { company: 'Equinor', title: null, startYear: 2010, endYear: 2014, founder: false },
        ],
      })
      await db
        .update(schema.person)
        .set({ photoKey: 'gammelt-bilde', phone: '+47 400 00 000' })
        .where(eq(schema.person.id, profile))
      await db.insert(schema.fieldSource).values([
        {
          entityType: 'person',
          entityId: profile,
          field: 'bio',
          sourceLabel: 'es.no',
          confidence: 'high',
        },
        {
          entityType: 'person',
          entityId: profile,
          field: 'city',
          sourceLabel: 'kullisten',
          confidence: 'high',
        },
      ])
      const [q] = await db
        .insert(schema.quote)
        .values({ text: 'Sitat', speakerName: 'Kari N', personId: profile })
        .returning()
      const [syrlig] = await db
        .select()
        .from(schema.company)
        .where(eq(schema.company.slug, 'syrlig'))
      const link = await requestCompanyLink(db, ola, syrlig!.id, {
        personId: profile,
        role: 'es',
        title: null,
        startYear: null,
        endYear: null,
      })

      // Profilen velges som den som beholdes, men kontoen vinner.
      const result = await mergePeople(db, storage, admin, {
        sourceId: kari!.personId!,
        targetId: profile,
      })
      expect(result.personId).toBe(kari!.personId)
      const [gone] = await db.select().from(schema.person).where(eq(schema.person.id, profile))
      expect(gone).toBeUndefined()

      const merged = await getProfile(db, kari, kari!.personId!)
      expect(merged.fullName).toBe('Kari')
      expect(merged.city).toBe('Trondheim') // Eierens eget felt beholdes.
      expect(merged.bio).toBe('Fra kullisten') // Tomme felt fylles.
      expect(merged.experience.map((e) => e.company).sort()).toEqual(['Equinor', 'Syrlig'])
      expect(merged.cohorts).toEqual([
        { graduationYear: 2016, relation: 'student' },
        { graduationYear: 2020, relation: 'mentor' },
      ])
      expect(merged.quotes.map((x) => x.id)).toEqual([q!.id])
      expect(merged.photo).not.toBeNull()
      expect(merged.sources.map((s) => s.field)).toEqual(['bio']) // Kilden for byen gjaldt ikke Kari.
      const [kariRow] = await db
        .select()
        .from(schema.person)
        .where(eq(schema.person.id, kari!.personId!))
      expect(kariRow!.phone).toBeNull() // Kontaktinfo til en med konto røres ikke.
      expect(
        (await getPersonAdmin(db, admin, kari!.personId!)).emails.map((e) => e.email).sort(),
      ).toEqual(['kari.nordmann@example.test', 'kari@example.test'])
      const [movedLink] = await db
        .select()
        .from(schema.companyLinkRequest)
        .where(eq(schema.companyLinkRequest.id, link.id))
      expect(movedLink!.personId).toBe(kari!.personId)

      const [logged] = await audit('person.merge')
      expect(logged!.subjectPersonId).toBe(kari!.personId)
      expect(logged!.details).toMatchObject({
        from: { personId: profile, claimed: false },
        into: { personId: kari!.personId, claimed: true },
        experience: 1,
        cohorts: 1,
        emails: 1,
        quotes: 1,
      })
      // Tidligere hendelser om profilen peker nå på Kari.
      const [created] = await audit('profile.create')
      expect(created!.subjectPersonId).toBe(kari!.personId)
    })

    it('slår aldri sammen to kontoer', async () => {
      await expect(
        mergePeople(db, storage, admin, { sourceId: kari!.personId!, targetId: ola!.personId! }),
      ).rejects.toThrow(/Begge har egen konto/)
      await expect(
        mergePeople(db, storage, admin, { sourceId: kari!.personId!, targetId: kari!.personId! }),
      ).rejects.toThrow(/annen person/)
    })

    it('en profil uten konto blir aktiv når duplikatet var det', async () => {
      const a = await createProfile(db, admin, {
        fullName: 'Anne',
        cohorts: [],
        emails: [],
        status: 'pending',
      })
      const b = await createProfile(db, admin, {
        fullName: 'Anne',
        cohorts: [],
        emails: [],
        status: 'active',
      })
      await mergePeople(db, storage, admin, { sourceId: b.personId, targetId: a.personId })
      const people = await listPeopleForAdmin(db, admin)
      expect(people.find((p) => p.personId === a.personId)!.status).toBe('active')
      expect(people.find((p) => p.personId === b.personId)).toBeUndefined()
    })

    it('kontaktinfo fylles fra duplikatet, og det som er skjult på en av dem, forblir skjult', async () => {
      const a = await createProfile(db, admin, {
        fullName: 'Berit',
        cohorts: [],
        emails: [],
        status: 'active',
      })
      const b = await createProfile(db, admin, {
        fullName: 'Berit',
        cohorts: [],
        emails: [],
        status: 'active',
      })
      await db
        .update(schema.person)
        .set({ phone: '+47 400 00 001', contactEmail: 'berit@example.test' })
        .where(eq(schema.person.id, a.personId))
      await db
        .update(schema.person)
        .set({ phone: '+47 400 00 002', phoneVisible: false })
        .where(eq(schema.person.id, b.personId))
      await mergePeople(db, storage, admin, { sourceId: b.personId, targetId: a.personId })
      const [row] = await db.select().from(schema.person).where(eq(schema.person.id, a.personId))
      expect(row).toMatchObject({
        phone: '+47 400 00 001',
        phoneVisible: false,
        contactEmail: 'berit@example.test',
        contactEmailVisible: true,
      })
    })
  })
})
