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

  it('kontaktinfo vises bare når eieren har slått det på', async () => {
    const withContact = {
      ...empty,
      fullName: 'Ola',
      contactEmail: 'ola.privat@example.test',
      phone: '+47 900 00 000',
    }
    await updateProfile(db, ola, ola!.personId!, withContact)
    expect(await getProfile(db, kari, ola!.personId!)).toMatchObject({
      contactEmail: null,
      phone: null,
    })

    await updateProfile(db, ola, ola!.personId!, { ...withContact, phoneVisible: true })
    expect(await getProfile(db, kari, ola!.personId!)).toMatchObject({
      contactEmail: null,
      phone: '+47 900 00 000',
    })
  })

  it('admin kan fylle ut profiler, men ikke se eller endre andres kontaktinfo', async () => {
    await updateProfile(db, ola, ola!.personId!, {
      ...empty,
      fullName: 'Ola',
      contactEmail: 'ola.privat@example.test',
      phone: '+47 911 11 111',
    })
    expect(await getEditableProfile(db, admin, ola!.personId!)).toMatchObject({
      contactEmail: null,
      phone: null,
      isOwn: false,
    })

    await updateProfile(db, admin, ola!.personId!, {
      ...empty,
      fullName: 'Ola',
      city: 'Bergen',
      phone: '+47 900 00 000',
      phoneVisible: true,
    })
    const editable = await getEditableProfile(db, ola, ola!.personId!)
    expect(editable).toMatchObject({ city: 'Bergen', phone: '+47 911 11 111', phoneVisible: false })
    expect((await getProfile(db, kari, ola!.personId!)).phone).toBeNull()

    const audit = await db
      .select()
      .from(schema.auditEvent)
      .where(eq(schema.auditEvent.action, 'profile.admin_edit'))
    expect(audit).toHaveLength(1)
  })

  it('ugyldige felt avvises', async () => {
    await expect(
      updateProfile(db, ola, ola!.personId!, { ...empty, linkedinUrl: 'https://evil.test/in/x' }),
    ).rejects.toThrow('LinkedIn')
    await expect(
      updateProfile(db, ola, ola!.personId!, { ...empty, fullName: ' ' }),
    ).rejects.toThrow('Navn')
  })

  it('profiler fra kullisten viser aldri kontaktinfo, og ventende personer er skjult', async () => {
    const sheet = parseProfileSheet(
      'navn,kull,by,epost,telefon\nFra Arket,2015,Oslo,arket@example.test,412 34 567',
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
    // Telefon og e-post fra arket lagres skjult, klare til at personen selv slår dem på.
    expect(imported).toMatchObject({
      phone: '+47 412 34 567',
      phoneVisible: false,
      contactEmail: 'arket@example.test',
      contactEmailVisible: false,
    })
    // Selv om noen skulle ha satt synlighet direkte i databasen, vises ingenting før profilen er tatt i bruk.
    await db
      .update(schema.person)
      .set({ phone: '123456', phoneVisible: true })
      .where(eq(schema.person.id, imported!.id))
    expect(await getProfile(db, kari, imported!.id)).toMatchObject({
      city: 'Oslo',
      claimed: false,
      phone: null,
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
