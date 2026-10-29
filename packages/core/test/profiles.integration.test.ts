import { randomUUID } from 'node:crypto'
import { createDb, loadRootEnv, runMigrations, schema, type Db } from '@esaf/db'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccessDeniedError,
  applyProfileImport,
  decideMembership,
  getEditableProfile,
  getProfile,
  grantRoleAsOperator,
  listActiveMembers,
  loadViewer,
  parseProfileSheet,
  planProfileImport,
  updateProfile,
  type ProfileInput,
  type Viewer,
} from '../src/index.ts'

loadRootEnv()
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

const empty: ProfileInput = {
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

describe.skipIf(!url)('profiler', () => {
  let db: Db
  let admin: Viewer
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

  beforeEach(async () => {
    await db.execute(
      sql`truncate ${schema.auditEvent}, ${schema.membership}, ${schema.personCohort}, ${schema.person}, ${schema.cohort}, ${schema.user} cascade`,
    )
    await account('Admin')
    await grantRoleAsOperator(db, { email: 'admin@example.test', reason: 'test', role: 'admin' })
    await db
      .update(schema.user)
      .set({ twoFactorEnabled: true })
      .where(eq(schema.user.email, 'admin@example.test'))
    admin = await loadViewer(db, (await db.select().from(schema.user))[0]!.id)
    const olaId = await account('Ola')
    const kariId = await account('Kari')
    for (const id of [olaId, kariId]) {
      const v = await loadViewer(db, id)
      await decideMembership(db, admin, { personId: v!.personId!, decision: 'approve' })
    }
    ola = await loadViewer(db, olaId)
    kari = await loadViewer(db, kariId)
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

  it('eieren kan redigere egen profil, andre medlemmer kan ikke', async () => {
    await updateProfile(db, ola, ola!.personId!, {
      ...empty,
      fullName: 'Ola Nordmann',
      expertise: ['B2B-salg', 'b2b-salg', 'Fundraising', 'iOS'],
      industries: ['energi', 'Energi', 'Telekom'],
      experience: [
        { company: 'Acme', title: 'Daglig leder', startYear: 2021, endYear: null, founder: true },
      ],
      linkedinUrl: 'https://www.linkedin.com/in/ola',
    })
    const profile = await getProfile(db, kari, ola!.personId!)
    expect(profile).toMatchObject({
      fullName: 'Ola Nordmann',
      jobTitle: 'Daglig leder',
      currentCompany: 'Acme',
      expertise: ['B2B-salg', 'Fundraising', 'iOS'],
      industries: ['Energi', 'Telekom'],
      isOwn: false,
      canEdit: false,
    })

    expect(await denial(updateProfile(db, kari, ola!.personId!, empty))).toBe('forbidden')
    expect(await denial(getEditableProfile(db, kari, ola!.personId!))).toBe('forbidden')
    expect(await denial(getProfile(db, null, ola!.personId!))).toBe('unauthenticated')
  })

  it('erfaring vises med nåværende først, og lagres som en helhet', async () => {
    const job = (company: string, startYear: number | null, endYear: number | null) => ({
      company,
      title: null,
      startYear,
      endYear,
      founder: false,
    })
    await updateProfile(db, ola, ola!.personId!, {
      ...empty,
      experience: [
        job('Gammel', 2010, 2014),
        job('Nåværende', 2020, null),
        job('Forrige', 2014, 2020),
      ],
    })
    const first = await getProfile(db, kari, ola!.personId!)
    expect(first.experience.map((e) => e.company)).toEqual(['Nåværende', 'Forrige', 'Gammel'])
    expect(first).toMatchObject({ currentCompany: 'Nåværende', jobTitle: null })

    await updateProfile(db, ola, ola!.personId!, { ...empty, experience: [job('Ny', 2024, null)] })
    expect((await getProfile(db, kari, ola!.personId!)).experience).toMatchObject([
      { company: 'Ny' },
    ])

    await expect(
      updateProfile(db, ola, ola!.personId!, { ...empty, experience: [job('Feil', 2020, 2018)] }),
    ).rejects.toThrow('Sluttåret')
    await expect(
      updateProfile(db, ola, ola!.personId!, { ...empty, experience: [job(' ', 2020, null)] }),
    ).rejects.toThrow('selskapet')
  })

  it('kontaktinfo vises som standard, skjult viser bare at den er skjult, tom viser ingenting', async () => {
    const withContact = {
      ...empty,
      fullName: 'Ola',
      contactEmail: 'ola.privat@example.test',
      contactEmailVisible: true,
      phone: '+47 900 00 000',
      phoneVisible: true,
    }
    // Ny person: synlig som standard.
    const [fresh] = await db
      .select({ e: schema.person.contactEmailVisible, p: schema.person.phoneVisible })
      .from(schema.person)
      .where(eq(schema.person.id, ola!.personId!))
    expect(fresh).toEqual({ e: true, p: true })

    await updateProfile(db, ola, ola!.personId!, withContact)
    expect(await getProfile(db, kari, ola!.personId!)).toMatchObject({
      contactEmail: { value: 'ola.privat@example.test' },
      phone: { value: '+47 900 00 000' },
    })

    // Skjult: medlemmer ser at det er skjult, men verdien sendes aldri, heller ikke til eieren eller admin.
    await updateProfile(db, ola, ola!.personId!, { ...withContact, contactEmailVisible: false })
    for (const viewer of [kari, ola, admin]) {
      const profile = await getProfile(db, viewer, ola!.personId!)
      expect(profile.contactEmail).toEqual({ hidden: true })
      expect(profile.phone).toEqual({ value: '+47 900 00 000' })
      expect(JSON.stringify(profile)).not.toContain('ola.privat')
    }
    // Katalogen viser ikke kontaktinfo i det hele tatt.
    expect(JSON.stringify(await listActiveMembers(db, kari))).not.toMatch(/ola\.privat|900 00 000/)

    // Uten verdi vises ingenting, uansett synlighet.
    await updateProfile(db, ola, ola!.personId!, {
      ...withContact,
      contactEmail: '',
      contactEmailVisible: false,
      phone: '',
    })
    expect(await getProfile(db, kari, ola!.personId!)).toMatchObject({
      contactEmail: null,
      phone: null,
    })
  })

  it('admin kan fylle ut profiler, men ikke se eller endre kontaktinfoen til en med konto', async () => {
    await updateProfile(db, ola, ola!.personId!, {
      ...empty,
      fullName: 'Ola',
      contactEmail: 'ola.privat@example.test',
      phone: '+47 911 11 111',
      phoneVisible: false,
    })
    const forAdmin = await getEditableProfile(db, admin, ola!.personId!)
    expect(forAdmin).toMatchObject({
      contactEmail: null,
      phone: null,
      isOwn: false,
      contactAccess: 'none',
    })
    expect(JSON.stringify(forAdmin)).not.toContain('911')

    await updateProfile(db, admin, ola!.personId!, {
      ...empty,
      fullName: 'Ola',
      city: 'Bergen',
      contactEmail: 'admin@example.test',
      phone: '+47 900 00 000',
      phoneVisible: true,
    })
    const editable = await getEditableProfile(db, ola, ola!.personId!)
    expect(editable).toMatchObject({
      city: 'Bergen',
      contactEmail: 'ola.privat@example.test',
      contactEmailVisible: false,
      phone: '+47 911 11 111',
      phoneVisible: false,
      contactAccess: 'own',
    })
    expect((await getProfile(db, kari, ola!.personId!)).phone).toEqual({ hidden: true })

    const audit = await db
      .select()
      .from(schema.auditEvent)
      .where(eq(schema.auditEvent.action, 'profile.admin_edit'))
    expect(audit).toHaveLength(1)
    expect(audit[0]!.details).toEqual({})
  })

  it('admin kan skjule og vise kontaktinfo fra kullisten på profiler uten konto, og det logges', async () => {
    const sheet = parseProfileSheet(
      'navn,kull,epost,telefon\nUten Konto,2015,uten@example.test,412 34 567',
      { yearKind: 'graduation' },
    )
    await applyProfileImport(db, await planProfileImport(db, sheet.rows), {
      membershipStatus: 'active',
      sourceLabel: 'test.csv',
    })
    const [row] = await db
      .select({ id: schema.person.id })
      .from(schema.person)
      .where(eq(schema.person.fullName, 'Uten Konto'))
    const id = row!.id

    // Admin ser verdiene fra kullisten i redigeringen; andre medlemmer kan ikke redigere.
    const editable = await getEditableProfile(db, admin, id)
    expect(editable).toMatchObject({
      contactAccess: 'visibility',
      contactEmail: 'uten@example.test',
      contactEmailVisible: true,
      phone: '+47 412 34 567',
      phoneVisible: true,
    })
    await expect(getEditableProfile(db, kari, id)).rejects.toThrow()

    // Admin skjuler e-posten. Verdiene kan ikke endres herfra.
    const {
      experience: _e,
      esCompanyId: _c,
      photo: _p,
      isOwn: _o,
      contactAccess: _a,
      personId: _i,
      ...fields
    } = editable
    await updateProfile(db, admin, id, {
      ...fields,
      city: fields.city ?? '',
      studyBackground: fields.studyBackground ?? '',
      esCompany: fields.esCompany ?? '',
      bio: fields.bio ?? '',
      linkedinUrl: fields.linkedinUrl ?? '',
      experience: [],
      contactEmail: '',
      contactEmailVisible: false,
      phone: '',
      phoneVisible: true,
    })
    const [after] = await db.select().from(schema.person).where(eq(schema.person.id, id))
    expect(after).toMatchObject({
      contactEmail: 'uten@example.test',
      contactEmailVisible: false,
      phone: '+47 412 34 567',
      phoneVisible: true,
    })
    const profile = await getProfile(db, kari, id)
    expect(profile).toMatchObject({
      claimed: false,
      contactEmail: { hidden: true },
      phone: { value: '+47 412 34 567' },
    })
    expect(JSON.stringify(profile)).not.toContain('uten@example')
    // Admin ser den fortsatt i redigeringen, merket som skjult.
    expect(await getEditableProfile(db, admin, id)).toMatchObject({
      contactEmail: 'uten@example.test',
      contactEmailVisible: false,
    })

    const audit = await db
      .select()
      .from(schema.auditEvent)
      .where(eq(schema.auditEvent.action, 'profile.admin_edit'))
    expect(audit).toMatchObject([
      {
        actorPersonId: admin!.personId,
        subjectPersonId: id,
        details: { visibility: { contactEmailVisible: false } },
      },
    ])

    // En ny import med kontaktinfo for samme person overstyrer ikke valget.
    const again = parseProfileSheet(
      'navn,kull,epost,telefon\nUten Konto,2015,uten@example.test,412 34 567',
      { yearKind: 'graduation' },
    )
    await applyProfileImport(db, await planProfileImport(db, again.rows), {
      membershipStatus: 'active',
      sourceLabel: 'test.csv',
    })
    expect((await getProfile(db, kari, id)).contactEmail).toEqual({ hidden: true })
  })

  it('ugyldige felt avvises', async () => {
    await expect(
      updateProfile(db, ola, ola!.personId!, { ...empty, linkedinUrl: 'https://evil.test/in/x' }),
    ).rejects.toThrow('LinkedIn')
    await expect(
      updateProfile(db, ola, ola!.personId!, { ...empty, fullName: ' ' }),
    ).rejects.toThrow('Navn')
  })

  it('profiler fra kullisten viser kontaktinfoen for medlemmer, og ventende personer er skjult', async () => {
    const sheet = parseProfileSheet(
      'navn,kull,by,epost,telefon\nFra Arket,2015,Oslo,arket@example.test,412 34 567\nUten Tlf,2015,Oslo,,',
      { yearKind: 'graduation' },
    )
    await applyProfileImport(db, await planProfileImport(db, sheet.rows), {
      membershipStatus: 'active',
      sourceLabel: 'test.csv',
    })
    const [imported] = await db
      .select()
      .from(schema.person)
      .where(eq(schema.person.fullName, 'Fra Arket'))
    // Telefon og e-post fra arket er det alumni fylte ut for å dele, og vises som standard.
    expect(imported).toMatchObject({
      phone: '+47 412 34 567',
      phoneVisible: true,
      contactEmail: 'arket@example.test',
      contactEmailVisible: true,
    })
    expect(await getProfile(db, kari, imported!.id)).toMatchObject({
      city: 'Oslo',
      claimed: false,
      phone: { value: '+47 412 34 567' },
      contactEmail: { value: 'arket@example.test' },
    })
    const [without] = await db
      .select({ id: schema.person.id })
      .from(schema.person)
      .where(eq(schema.person.fullName, 'Uten Tlf'))
    expect(await getProfile(db, kari, without!.id)).toMatchObject({
      phone: null,
      contactEmail: null,
    })

    const pending = await loadViewer(db, await account('Ventende'))
    await expect(getProfile(db, kari, pending!.personId!)).rejects.toThrow('Fant ikke')
    expect((await listActiveMembers(db, kari)).map((m) => m.fullName)).not.toContain('Ventende')
  })

  it('import fyller bare tomme felt på profiler ingen har tatt i bruk', async () => {
    const run = async (csv: string) => {
      const sheet = parseProfileSheet(csv, { yearKind: 'graduation' })
      await applyProfileImport(db, await planProfileImport(db, sheet.rows), {
        membershipStatus: 'active',
        sourceLabel: 'test.csv',
      })
    }
    await run('navn,epost,kull\nOla,ola@example.test,2015\nPer,per@example.test,2015')
    await run('navn,epost,kull,by\nOla,ola@example.test,2015,Oslo\nPer,per@example.test,2015,Oslo')
    const cityOf = async (email: string) =>
      (
        await db
          .select({ city: schema.person.city })
          .from(schema.personEmail)
          .innerJoin(schema.person, eq(schema.person.id, schema.personEmail.personId))
          .where(eq(schema.personEmail.email, email))
      )[0]?.city
    // Ola har tatt i bruk profilen sin og endres ikke; Per er en ubrukt profil og får by.
    expect(await cityOf('ola@example.test')).toBeNull()
    expect(await cityOf('per@example.test')).toBe('Oslo')
  })
})
