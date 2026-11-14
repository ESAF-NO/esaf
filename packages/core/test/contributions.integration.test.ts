import { randomUUID } from 'node:crypto'
import { createDb, loadRootEnv, runMigrations, schema, type Db } from '@esaf/db'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccessDeniedError,
  addCompanyEvent,
  addSelfToCompany,
  companiesToFill,
  createProfile,
  decideCompanyLink,
  deleteCompanyEvent,
  decideMembership,
  decideSuggestion,
  getCompany,
  getProfile,
  grantRoleAsOperator,
  listMyLinkRequests,
  listNotifications,
  removeAddedCompanyLink,
  loadViewer,
  mergeCompanies,
  listReview,
  removeSelfFromCompany,
  requestCompanyLink,
  searchCompanies,
  startCompany,
  suggestCompanyInfo,
  updateCompany,
  updateCompanyEvent,
  updateProfile,
  withdrawCompanyLink,
  withdrawSuggestion,
  type CompanyDetails,
  type CompanyEventInput,
  type CompanyInput,
  type ObjectStorage,
  type ProfileInput,
  type Viewer,
} from '../src/index.ts'

loadRootEnv()
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

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

const info: CompanyInput = {
  name: 'Syrlig',
  tagline: '',
  description: '',
  website: '',
  foundedYear: null,
  location: '',
  industries: [],
  status: 'active',
}

const event: CompanyEventInput = {
  year: 2019,
  month: 6,
  day: null,
  type: 'funding',
  text: 'Hentet 4 MNOK.',
  sourceUrl: '',
  sourceLabel: '',
}

describe.skipIf(!url)('bidrag fra medlemmer', () => {
  let db: Db
  let admin: Viewer
  let weakAdmin: Viewer
  let ola: Viewer
  let kari: Viewer
  let per: Viewer
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

  beforeEach(async () => {
    await db.execute(
      sql`truncate ${schema.fieldSource}, ${schema.auditEvent}, ${schema.membership}, ${schema.personCohort}, ${schema.person}, ${schema.cohort}, ${schema.user}, ${schema.company} cascade`,
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
    per = await member('Per')
    // Ola er gründer av Syrlig. Kari og Per er ikke knyttet til det.
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

  const notifications = async (viewer: Viewer) => (await listNotifications(db, viewer)).items

  describe('«Nytt selskap»', () => {
    const founder = {
      role: 'founder',
      title: 'Daglig leder',
      startYear: 2024,
      endYear: null,
    } as const

    it('et medlem lager et selskap, blir gründer og kan fylle det ut', async () => {
      expect(await companiesToFill(db, kari)).toEqual([])
      const created = await startCompany(db, kari, { name: '  Fjordkraft  Labs ', link: founder })
      expect(created.slug).toBe('fjordkraft-labs')

      const c = await page(kari, created.slug)
      expect(c).toMatchObject({ name: 'Fjordkraft Labs', status: 'active', canEdit: true })
      expect(c.people.find((p) => p.personId === kari!.personId)).toMatchObject({
        role: 'founder',
        title: 'Daglig leder',
      })
      expect(await audit('company.create')).toMatchObject([
        { actorPersonId: kari!.personId, details: { slug: 'fjordkraft-labs', role: 'founder' } },
      ])

      // Påminnelsen på Hjem, til selskapet har fått info.
      expect(await companiesToFill(db, kari)).toMatchObject([
        { slug: 'fjordkraft-labs', role: 'founder' },
      ])
      await updateCompany(db, kari, created.id, {
        ...info,
        name: 'Fjordkraft Labs',
        tagline: 'Strøm',
      })
      expect(await companiesToFill(db, kari)).toEqual([])
    })

    it('et navn som finnes, også som tidligere navn, avvises', async () => {
      await expect(startCompany(db, kari, { name: 'syrlig', link: founder })).rejects.toThrow(
        /finnes allerede: Syrlig/,
      )
      // Søket i «Nytt selskap» sier om du selv er med, så du ikke blir bedt om «Jeg var med her».
      expect(await searchCompanies(db, ola, 'syrlig')).toMatchObject([{ exact: true, mine: true }])
      expect(await searchCompanies(db, kari, 'syrlig')).toMatchObject([
        { exact: true, mine: false },
      ])
      await mergeCompanies(db, storage, admin, {
        sourceId: (await startCompany(db, per, { name: 'Sur AS', link: founder })).id,
        targetId: syrligId,
        formerName: true,
      })
      await expect(startCompany(db, kari, { name: 'Sur AS', link: founder })).rejects.toThrow(
        /finnes allerede/,
      )
    })

    it('ES-team og tidligere ansatt; et tomt selskap ryddes bort når man fjerner seg', async () => {
      const es = await startCompany(db, kari, {
        name: 'Havbris',
        link: { role: 'es', title: 'ignoreres', startYear: 2019, endYear: null },
      })
      expect((await getProfile(db, kari, kari!.personId!)).esCompanySlug).toBe(es.slug)
      expect((await page(kari, es.slug)).canEdit).toBe(true)
      expect(await companiesToFill(db, kari)).toMatchObject([{ slug: es.slug, role: 'es' }])

      const past = await startCompany(db, per, {
        name: 'Gammel Jobb',
        link: { role: 'employee', title: 'Utvikler', startYear: 2015, endYear: 2017 },
      })
      expect((await page(per, past.slug)).canEdit).toBe(true)
      expect(await companiesToFill(db, per)).toEqual([])

      expect(await removeSelfFromCompany(db, per, past.id)).toEqual({ companyDeleted: true })
    })

    it('ansatte og styreverv gir ingen påminnelse, selv om de kan redigere', async () => {
      const job = await startCompany(db, kari, {
        name: 'Storbank',
        link: { role: 'employee', title: 'Styremedlem', startYear: 2022, endYear: null },
      })
      await startCompany(db, kari, {
        name: 'Verksted',
        link: { role: 'employee', title: 'Utvikler', startYear: 2022, endYear: null },
      })
      expect((await page(kari, job.slug)).canEdit).toBe(true)
      expect(await companiesToFill(db, kari)).toEqual([])
    })

    it('høyst fem nye selskaper i døgnet for medlemmer, ingen grense for admins', async () => {
      for (const n of [1, 2, 3, 4, 5]) {
        await startCompany(db, kari, { name: `Selskap ${n}`, link: founder })
      }
      await expect(startCompany(db, kari, { name: 'Selskap 6', link: founder })).rejects.toThrow(
        /5 selskaper det siste døgnet/,
      )
      for (const n of [1, 2, 3, 4, 5, 6]) {
        await startCompany(db, admin, { name: `Admin ${n}`, link: founder })
      }
    })
  })

  describe('«Jeg var med her»', () => {
    it('et medlem legger seg selv til som ansatt, kan da redigere og fjerne seg selv', async () => {
      expect((await page(kari)).canEdit).toBe(false)
      await addSelfToCompany(db, kari, syrligId, {
        role: 'employee',
        title: 'Utvikler',
        startYear: 2020,
        endYear: null,
      })
      const after = await page(kari)
      expect(after.canEdit).toBe(true)
      expect(after.viewerRoles).toEqual({ founder: false, employee: true, es: false })
      expect(after.people.find((p) => p.personId === kari!.personId)).toMatchObject({
        role: 'current',
        title: 'Utvikler',
      })
      await updateCompany(db, kari, syrligId, { ...info, tagline: 'Sur og god' })
      // Kari er knyttet til selskapet, så det logges ikke som adminendring.
      expect(await audit('company.admin_edit')).toHaveLength(0)

      // Samme rolle to ganger avvises.
      await expect(
        addSelfToCompany(db, kari, syrligId, {
          role: 'employee',
          title: null,
          startYear: null,
          endYear: null,
        }),
      ).rejects.toThrow(/allerede som ansatt/)

      expect(await removeSelfFromCompany(db, kari, syrligId)).toEqual({ companyDeleted: false })
      expect((await page(kari)).canEdit).toBe(false)
      expect((await getProfile(db, kari, kari!.personId!)).experience).toHaveLength(0)
      await expect(removeSelfFromCompany(db, kari, syrligId)).rejects.toThrow(/ikke knyttet/)
    })

    it('tidligere ansatte og ES-team kan redigere; ES-selskapet byttes ikke stille', async () => {
      await addSelfToCompany(db, kari, syrligId, {
        role: 'employee',
        title: null,
        startYear: 2015,
        endYear: 2017,
      })
      expect((await page(kari)).canEdit).toBe(true)
      await addSelfToCompany(db, per, syrligId, {
        role: 'es',
        title: 'ignoreres',
        startYear: null,
        endYear: null,
      })
      const p = await page(per)
      expect(p.canEdit).toBe(true)
      expect(p.viewerRoles.es).toBe(true)

      const [other] = await db
        .insert(schema.company)
        .values({ slug: 'annet', name: 'Annet', editedAt: new Date() })
        .returning()
      await expect(
        addSelfToCompany(db, per, other!.id, {
          role: 'es',
          title: null,
          startYear: null,
          endYear: null,
        }),
      ).rejects.toThrow(/har allerede Syrlig/)
    })

    it('et selskap bare laget fra et navn ryddes bort når den siste fjerner seg', async () => {
      await updateProfile(db, kari, kari!.personId!, {
        ...emptyProfile,
        fullName: 'Kari',
        experience: [
          { company: 'Skrivfeil', title: null, startYear: null, endYear: null, founder: false },
        ],
      })
      const [typo] = await db
        .select()
        .from(schema.company)
        .where(eq(schema.company.slug, 'skrivfeil'))
      expect(await removeSelfFromCompany(db, kari, typo!.id)).toEqual({ companyDeleted: true })
    })

    it('importerte kilder for erfaring regnes som bekreftet', async () => {
      await db.insert(schema.fieldSource).values({
        entityType: 'person',
        entityId: kari!.personId!,
        field: 'experience',
        sourceLabel: 'kullisten',
        confidence: 'medium',
      })
      await addSelfToCompany(db, kari, syrligId, {
        role: 'founder',
        title: null,
        startYear: 2016,
        endYear: null,
      })
      const [source] = await db.select().from(schema.fieldSource)
      expect(source!.confirmedAt).not.toBeNull()
    })
  })

  describe('forslag', () => {
    it('medlemmer foreslår, de knyttet til selskapet godtar, og forslagsstilleren får varsel', async () => {
      const { id } = await suggestCompanyInfo(
        db,
        kari,
        syrligId,
        { ...info, tagline: 'Fermentert brus', website: 'syrlig.no' },
        'Sto i Adresseavisen',
      )
      const [row] = await db.select().from(schema.companySuggestion)
      expect(row!.changes).toEqual({
        kind: 'info',
        fields: {
          tagline: { from: null, to: 'Fermentert brus' },
          website: { from: null, to: 'https://syrlig.no' },
        },
      })

      // Kari ser bare sitt eget, Per ser ingenting, Ola ser forslaget og får varsel.
      expect((await page(kari)).suggestions.map((s) => s.own)).toEqual([true])
      expect((await page(per)).suggestions).toHaveLength(0)
      const forOla = (await page(ola)).suggestions
      expect(forOla).toHaveLength(1)
      expect(forOla[0]!.fields.map((f) => f.field).sort()).toEqual(['tagline', 'website'])
      expect((await notifications(ola)).map((n) => n.type)).toEqual(['company_suggestion'])

      // Bare de som kan redigere, behandler; ingen behandler sine egne.
      expect(await denial(decideSuggestion(db, per, id, 'accept'))).toBe('forbidden')
      expect(await denial(decideSuggestion(db, kari, id, 'accept'))).toBe('forbidden')
      await decideSuggestion(db, ola, id, 'accept')
      const after = await page(kari)
      expect(after.tagline).toBe('Fermentert brus')
      expect(after.website).toBe('https://syrlig.no')
      expect(after.suggestions).toHaveLength(0)
      const [note] = await notifications(kari)
      expect(note).toMatchObject({
        type: 'suggestion_accepted',
        company: { slug: 'syrlig', name: 'Syrlig' },
        suggestionKind: 'info',
      })
      // Ola er knyttet til selskapet; det logges ikke.
      expect(await audit('company.admin_suggestion_accept')).toHaveLength(0)
      await expect(decideSuggestion(db, ola, id, 'reject')).rejects.toThrow(/allerede behandlet/)
    })

    /** Forslag om hendelser fantes før alle kunne legge til selv, og kan fortsatt behandles. */
    async function oldEventSuggestion() {
      const [row] = await db
        .insert(schema.companySuggestion)
        .values({
          companyId: syrligId,
          suggestedByPersonId: kari!.personId!,
          kind: 'event',
          changes: { kind: 'event', event } as never,
        })
        .returning({ id: schema.companySuggestion.id })
      return row!
    }

    it('alle medlemmer legger til hendelser med en gang; andres retter bare de som er knyttet', async () => {
      const { id } = await addCompanyEvent(db, kari, syrligId, event)
      expect((await page(per)).events).toMatchObject([{ text: 'Hentet 4 MNOK.', review: false }])
      const [logged] = await audit('company.member_event_add')
      expect(logged).toMatchObject({ actorPersonId: kari!.personId })
      expect(await denial(updateCompanyEvent(db, per, id, event))).toBe('forbidden')
      expect(await denial(deleteCompanyEvent(db, per, id))).toBe('forbidden')

      // Den som er knyttet til selskapet, logges ikke.
      await addCompanyEvent(db, ola, syrligId, event)
      expect(await audit('company.member_event_add')).toHaveLength(1)
      await deleteCompanyEvent(db, ola, id)
    })

    it('medlemmer utenfor selskapet har en grense per døgn', async () => {
      for (let i = 0; i < 20; i++) await addCompanyEvent(db, kari, syrligId, event)
      await expect(addCompanyEvent(db, kari, syrligId, event)).rejects.toThrow(/Prøv igjen/)
      await addCompanyEvent(db, ola, syrligId, event)
    })

    it('admins behandler forslag (logges), men trenger sterk innlogging', async () => {
      const { id } = await oldEventSuggestion()
      expect(await denial(decideSuggestion(db, weakAdmin, id, 'reject'))).toBe(
        'strong_auth_required',
      )
      await decideSuggestion(db, admin, id, 'reject')
      expect((await page(ola)).events).toHaveLength(0)
      const [note] = await notifications(kari)
      expect(note).toMatchObject({ type: 'suggestion_rejected', suggestionKind: 'event' })
      const [logged] = await audit('company.admin_suggestion_reject')
      expect(logged!.details).toMatchObject({ companyId: syrligId, kind: 'event' })
      expect(logged!.subjectPersonId).toBe(kari!.personId)

      const second = await oldEventSuggestion()
      await decideSuggestion(db, admin, second.id, 'accept')
      const events = (await page(per)).events
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ type: 'funding', review: false, text: 'Hentet 4 MNOK.' })
      expect(await audit('company.admin_suggestion_accept')).toHaveLength(1)
    })

    it('navnebytte via forslag gir ny slug og alias', async () => {
      const { id } = await suggestCompanyInfo(db, kari, syrligId, { ...info, name: 'Syrlig Brus' })
      expect(await decideSuggestion(db, ola, id, 'accept')).toEqual({ slug: 'syrlig-brus' })
      expect(await getCompany(db, kari, 'syrlig')).toEqual({ movedTo: 'syrlig-brus' })
    })

    it('de knyttet til selskapet redigerer selv, uendrede forslag og ugyldige felt avvises', async () => {
      await expect(suggestCompanyInfo(db, ola, syrligId, info)).rejects.toThrow(/redigere det selv/)
      await expect(suggestCompanyInfo(db, kari, syrligId, info)).rejects.toThrow(/ikke endret/)
      await expect(
        suggestCompanyInfo(db, kari, syrligId, { ...info, website: 'javascript:alert(1)' }),
      ).rejects.toThrow(/nettadresse/)
    })

    it('forslag kan trekkes av den som sendte, og antallet åpne er begrenset', async () => {
      const ids: string[] = []
      for (const text of ['A', 'B', 'C']) {
        ids.push((await suggestCompanyInfo(db, kari, syrligId, { ...info, tagline: text })).id)
      }
      await expect(
        suggestCompanyInfo(db, kari, syrligId, { ...info, tagline: 'D' }),
      ).rejects.toThrow(/allerede 3/)
      await expect(withdrawSuggestion(db, per, ids[0]!)).rejects.toThrow(/Fant ikke/)
      await withdrawSuggestion(db, kari, ids[0]!)
      await suggestCompanyInfo(db, kari, syrligId, { ...info, tagline: 'D' })
      await expect(decideSuggestion(db, ola, ids[0]!, 'accept')).rejects.toThrow(/allerede/)
    })
  })

  describe('andre personer', () => {
    it('den som er nevnt, må bekrefte før det vises', async () => {
      const { id } = await requestCompanyLink(db, ola, syrligId, {
        personId: kari!.personId!,
        role: 'founder',
        title: 'Medgründer',
        startYear: 2016,
        endYear: null,
      })
      // Ikke synlig før Kari har svart.
      expect((await page(per)).people.map((p) => p.personId)).not.toContain(kari!.personId)
      expect((await page(ola)).requestedLinks).toHaveLength(1)
      expect((await page(kari)).linkRequests).toHaveLength(1)
      expect((await listMyLinkRequests(db, kari)).map((r) => r.company.slug)).toEqual(['syrlig'])
      const [note] = await notifications(kari)
      expect(note).toMatchObject({ type: 'company_link_request', linkRole: 'founder' })

      // Andre medlemmer kan ikke svare for Kari, og en admin heller ikke når hun har konto.
      expect(await denial(decideCompanyLink(db, per, id, 'accept'))).toBe('forbidden')
      await expect(decideCompanyLink(db, admin, id, 'accept')).rejects.toThrow(/må bekrefte selv/)

      await decideCompanyLink(db, kari, id, 'accept')
      const after = await page(per)
      expect(after.people.find((p) => p.personId === kari!.personId)).toMatchObject({
        role: 'founder',
        title: 'Medgründer',
      })
      expect((await notifications(ola)).map((n) => n.type)).toContain('company_link_confirmed')
      expect(await audit('company.admin_link_accept')).toHaveLength(0)
    })

    it('avslag viser ingenting, og den som spurte kan trekke forespørselen', async () => {
      const first = await requestCompanyLink(db, ola, syrligId, {
        personId: kari!.personId!,
        role: 'employee',
        title: null,
        startYear: null,
        endYear: null,
      })
      await expect(
        requestCompanyLink(db, ola, syrligId, {
          personId: kari!.personId!,
          role: 'employee',
          title: null,
          startYear: null,
          endYear: null,
        }),
      ).rejects.toThrow(/venter på svar/)
      await decideCompanyLink(db, kari, first.id, 'reject')
      expect((await page(per)).people.map((p) => p.personId)).not.toContain(kari!.personId)

      const second = await requestCompanyLink(db, ola, syrligId, {
        personId: per!.personId!,
        role: 'es',
        title: null,
        startYear: null,
        endYear: null,
      })
      await expect(withdrawCompanyLink(db, kari, second.id)).rejects.toThrow(/Fant ikke/)
      await withdrawCompanyLink(db, ola, second.id)
      await expect(decideCompanyLink(db, per, second.id, 'accept')).rejects.toThrow(/allerede/)
      await expect(
        requestCompanyLink(db, ola, syrligId, {
          personId: ola!.personId!,
          role: 'employee',
          title: null,
          startYear: null,
          endYear: null,
        }),
      ).rejects.toThrow(/Jeg var med her/)
    })

    it('en profil uten konto legges til med en gang, uten admin, og logges', async () => {
      const { personId } = await createProfile(db, admin, {
        fullName: 'Profil Uten Konto',
        cohorts: [{ graduationYear: 2016, relation: 'student' }],
        emails: [],
        status: 'active',
      })
      const link = {
        personId,
        role: 'founder',
        title: null,
        startYear: 2016,
        endYear: null,
      } as const
      expect(await requestCompanyLink(db, kari, syrligId, link)).toMatchObject({ added: true })

      expect((await page(per)).people.map((p) => p.personId)).toContain(personId)
      expect((await listReview(db, admin, 'links', 1)).total).toBe(0)
      const [logged] = await audit('company.member_link_add')
      expect(logged).toMatchObject({ actorPersonId: kari!.personId, subjectPersonId: personId })
      await expect(requestCompanyLink(db, kari, syrligId, link)).rejects.toThrow(/står allerede/)

      // Gründeren får vite at noen utenfor la til en person.
      expect(
        (await notifications(ola)).map((n) => [n.type, n.additionKind, n.actor?.personId]),
      ).toEqual([['company_addition', 'person', kari!.personId]])
    })

    it('den som la til en profil uten konto, kan fjerne den igjen, til profilen tas i bruk', async () => {
      const { personId } = await createProfile(db, admin, {
        fullName: 'Profil Uten Konto',
        cohorts: [{ graduationYear: 2016, relation: 'student' }],
        emails: [],
        status: 'active',
      })
      const founderLink = {
        personId,
        role: 'founder',
        title: null,
        startYear: 2016,
        endYear: null,
      } as const
      const { id } = await requestCompanyLink(db, kari, syrligId, founderLink)
      const team = await requestCompanyLink(db, kari, syrligId, { ...founderLink, role: 'es' })
      expect((await page(kari)).addedLinks).toEqual([
        { requestId: id, personId, role: 'founder' },
        { requestId: team.id, personId, role: 'es' },
      ])
      expect((await page(per)).addedLinks).toEqual([])

      // Bare den som la til, kan fjerne.
      await expect(removeAddedCompanyLink(db, per, id)).rejects.toThrow(/Fant ikke/)
      await removeAddedCompanyLink(db, kari, id)
      await removeAddedCompanyLink(db, kari, team.id)
      expect((await page(per)).people.map((p) => p.personId)).not.toContain(personId)
      expect((await page(kari)).addedLinks).toEqual([])
      await expect(removeAddedCompanyLink(db, kari, id)).rejects.toThrow(/Fant ikke/)
      const [logged] = await audit('company.member_link_remove')
      expect(logged).toMatchObject({ actorPersonId: kari!.personId, subjectPersonId: personId })
      expect(logged!.details).toMatchObject({ companyId: syrligId, role: 'founder', requestId: id })

      // Når profilen er tatt i bruk, bestemmer personen selv.
      const again = await requestCompanyLink(db, kari, syrligId, founderLink)
      const userId = randomUUID()
      await db.insert(schema.user).values({
        id: userId,
        name: 'Profil',
        email: 'profil@example.test',
        emailVerified: true,
      })
      await db.update(schema.person).set({ userId }).where(eq(schema.person.id, personId))
      expect((await page(kari)).addedLinks).toEqual([])
      await expect(removeAddedCompanyLink(db, kari, again.id)).rejects.toThrow(/tatt i bruk/)
      expect((await page(per)).people.map((p) => p.personId)).toContain(personId)
    })

    it('personer som gründeren legger til, gir ikke varsel', async () => {
      const { personId } = await createProfile(db, admin, {
        fullName: 'Profil Uten Konto',
        cohorts: [{ graduationYear: 2016, relation: 'student' }],
        emails: [],
        status: 'active',
      })
      await requestCompanyLink(db, ola, syrligId, {
        personId,
        role: 'employee',
        title: null,
        startYear: null,
        endYear: null,
      })
      await requestCompanyLink(db, kari, syrligId, {
        personId,
        role: 'founder',
        title: null,
        startYear: null,
        endYear: null,
      })
      // Kari er ikke knyttet til selskapet: Ola får varsel om det Kari la til, ikke om sitt eget.
      expect((await notifications(ola)).map((n) => n.actor?.personId)).toEqual([kari!.personId])
    })

    it('admins avslår forespørsler om personer med konto, og det logges', async () => {
      const { id } = await requestCompanyLink(db, kari, syrligId, {
        personId: per!.personId!,
        role: 'employee',
        title: null,
        startYear: null,
        endYear: null,
      })
      expect(await denial(decideCompanyLink(db, weakAdmin, id, 'reject'))).toBe(
        'strong_auth_required',
      )
      await decideCompanyLink(db, admin, id, 'reject')
      expect(await audit('company.admin_link_reject')).toHaveLength(1)
    })

    it('hvor mange personer et medlem kan legge til, er begrenset per døgn', async () => {
      const people = []
      for (let i = 0; i < 21; i++) {
        people.push(
          (
            await createProfile(db, admin, {
              fullName: `Person ${i}`,
              cohorts: [],
              emails: [],
              status: 'active',
            })
          ).personId,
        )
      }
      for (const personId of people.slice(0, 20)) {
        await requestCompanyLink(db, kari, syrligId, {
          personId,
          role: 'employee',
          title: null,
          startYear: null,
          endYear: null,
        })
      }
      await expect(
        requestCompanyLink(db, kari, syrligId, {
          personId: people[20]!,
          role: 'employee',
          title: null,
          startYear: null,
          endYear: null,
        }),
      ).rejects.toThrow(/Prøv igjen i morgen/)
    })
  })

  it('sammenslåing av selskaper tar med forslag, forespørsler og varsler', async () => {
    const [dup] = await db
      .insert(schema.company)
      .values({ slug: 'syrlig-as', name: 'Syrlig AS', editedAt: new Date() })
      .returning()
    await addSelfToCompany(db, per, dup!.id, {
      role: 'founder',
      title: null,
      startYear: null,
      endYear: null,
    })
    const suggestion = await suggestCompanyInfo(db, kari, dup!.id, { ...info, tagline: 'Brus' })
    const link = await requestCompanyLink(db, per, dup!.id, {
      personId: kari!.personId!,
      role: 'employee',
      title: null,
      startYear: null,
      endYear: null,
    })
    // Samme forespørsel finnes også på målet; den blir én.
    await requestCompanyLink(db, ola, syrligId, {
      personId: kari!.personId!,
      role: 'employee',
      title: null,
      startYear: null,
      endYear: null,
    })
    await mergeCompanies(db, storage, admin, { sourceId: dup!.id, targetId: syrligId })
    const [moved] = await db
      .select()
      .from(schema.companySuggestion)
      .where(eq(schema.companySuggestion.id, suggestion.id))
    expect(moved!.companyId).toBe(syrligId)
    const links = await db
      .select()
      .from(schema.companyLinkRequest)
      .where(
        and(
          eq(schema.companyLinkRequest.companyId, syrligId),
          eq(schema.companyLinkRequest.status, 'pending'),
        ),
      )
    expect(links).toHaveLength(1)
    expect(links[0]!.id).not.toBe(link.id)
    const kariNotes = await notifications(kari)
    expect(kariNotes.every((n) => n.company?.slug === 'syrlig')).toBe(true)
    expect((await page(per)).suggestions).toHaveLength(1)
  })
})
