import { randomUUID } from 'node:crypto'
import { createDb, loadRootEnv, runMigrations, schema, type Db } from '@esaf/db'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccessDeniedError,
  addBoardMember,
  changeBoardRole,
  createProfile,
  decideMembership,
  endBoardMember,
  getBoard,
  getProfile,
  grantRoleAsOperator,
  listActiveMembers,
  listBoardCandidates,
  listBoardOverview,
  loadViewer,
  mergePeople,
  removeBoardMember,
  searchPeople,
  setPersonCohorts,
  updateBoardMember,
  type ObjectStorage,
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

describe.skipIf(!url)('styret', () => {
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

  async function member(name: string, year: number) {
    const v = await loadViewer(db, await account(name))
    await decideMembership(db, admin, { personId: v!.personId!, decision: 'approve' })
    await setPersonCohorts(db, admin, v!.personId!, [{ graduationYear: year, relation: 'student' }])
    return loadViewer(db, v!.userId)
  }

  async function profile(fullName: string, status: 'active' | 'pending' = 'active') {
    const { personId } = await createProfile(db, admin, {
      fullName,
      cohorts: [{ graduationYear: 2018, relation: 'student' }],
      emails: [],
      status,
    })
    return personId
  }

  beforeEach(async () => {
    await db.execute(
      sql`truncate ${schema.boardMember}, ${schema.auditEvent}, ${schema.membership}, ${schema.personCohort}, ${schema.person}, ${schema.cohort}, ${schema.user} cascade`,
    )
    await account('Admin')
    await grantRoleAsOperator(db, { email: 'admin@example.test', reason: 'test', role: 'admin' })
    await db
      .update(schema.user)
      .set({ twoFactorEnabled: true })
      .where(eq(schema.user.email, 'admin@example.test'))
    admin = await loadViewer(db, (await db.select().from(schema.user))[0]!.id)
    weakAdmin = { ...admin!, twoFactorEnabled: false, passkeySession: false }
    ola = await member('Ola', 2018)
    kari = await member('Kari', 2019)
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

  it('bare admins med sterk innlogging styrer vervene; medlemmer ser styret', async () => {
    const { id } = await addBoardMember(db, admin, { personId: ola!.personId!, role: 'chair' })
    const calls: [string, (v: Viewer) => Promise<unknown>][] = [
      ['listBoardOverview', (v) => listBoardOverview(db, v)],
      ['listBoardCandidates', (v) => listBoardCandidates(db, v, 'Ka')],
      ['addBoardMember', (v) => addBoardMember(db, v, { personId: kari!.personId! })],
      [
        'updateBoardMember',
        (v) =>
          updateBoardMember(db, v, id, {
            role: 'chair',
            responsibility: null,
            startYear: 2020,
            endYear: null,
            note: null,
          }),
      ],
      ['changeBoardRole', (v) => changeBoardRole(db, v, id, { role: 'member' })],
      ['endBoardMember', (v) => endBoardMember(db, v, id)],
      ['removeBoardMember', (v) => removeBoardMember(db, v, id)],
    ]
    for (const [name, call] of calls) {
      expect([name, await denial(call(kari))]).toEqual([name, 'forbidden'])
      expect([name, await denial(call(weakAdmin))]).toEqual([name, 'strong_auth_required'])
    }
    expect(await denial(getBoard(db, null))).toBe('unauthenticated')
    expect((await getBoard(db, kari)).current.map((s) => s.fullName)).toEqual(['Ola'])
  })

  it('én gang i styret om gangen, én leder og én nestleder, og alt logges', async () => {
    const { id: chair } = await addBoardMember(db, admin, {
      personId: ola!.personId!,
      role: 'chair',
      startYear: 2024,
      note: 'Valgt for to år',
    })
    await expect(addBoardMember(db, admin, { personId: ola!.personId! })).rejects.toThrow(
      /sitter allerede i styret/,
    )
    await expect(
      addBoardMember(db, admin, { personId: kari!.personId!, role: 'chair' }),
    ).rejects.toThrow(/Ola er leder nå/)
    const { id: kariSeat } = await addBoardMember(db, admin, {
      personId: kari!.personId!,
      role: 'vice_chair',
      responsibility: 'Økonomi',
    })
    expect((await audit('board.add')).map((e) => e.details)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ boardMemberId: chair, role: 'chair', startYear: 2024 }),
        expect.objectContaining({
          boardMemberId: kariSeat,
          role: 'vice_chair',
          responsibility: 'Økonomi',
          startYear: new Date().getFullYear(),
        }),
      ]),
    )

    // Rette et verv til en rolle som er tatt, går ikke.
    await expect(
      updateBoardMember(db, admin, kariSeat, {
        role: 'chair',
        responsibility: 'Økonomi',
        startYear: 2025,
        endYear: null,
        note: null,
      }),
    ).rejects.toThrow(/Ola er leder nå/)
    await updateBoardMember(db, admin, kariSeat, {
      role: 'vice_chair',
      responsibility: 'Økonomi',
      startYear: 2025,
      endYear: null,
      note: null,
    })
    expect((await audit('board.edit'))[0]!.details).toMatchObject({
      from: { startYear: new Date().getFullYear() },
      to: { startYear: 2025 },
    })

    // Lederen går over til styremedlem; da kan nestlederen bli leder.
    await expect(changeBoardRole(db, admin, chair, { role: 'chair' })).rejects.toThrow(
      /annen rolle/,
    )
    await expect(changeBoardRole(db, admin, chair, { role: 'member', year: 2023 })).rejects.toThrow(
      /før vervet startet/,
    )
    const { id: olaMember } = await changeBoardRole(db, admin, chair, {
      role: 'member',
      year: 2026,
    })
    await changeBoardRole(db, admin, kariSeat, { role: 'chair', responsibility: null, year: 2026 })
    expect(await audit('board.role_change')).toHaveLength(2)

    const overview = await listBoardOverview(db, admin)
    expect(overview.current.map((s) => [s.fullName, s.role, s.startYear, s.note])).toEqual([
      ['Kari', 'chair', 2026, null],
      ['Ola', 'member', 2026, 'Valgt for to år'],
    ])
    expect(overview.past.map((s) => [s.fullName, s.role, s.startYear, s.endYear])).toEqual([
      ['Kari', 'vice_chair', 2025, 2026],
      ['Ola', 'chair', 2024, 2026],
    ])

    await expect(endBoardMember(db, admin, olaMember, { endYear: 2025 })).rejects.toThrow(
      /før startåret/,
    )
    await endBoardMember(db, admin, olaMember, { endYear: 2026 })
    await expect(endBoardMember(db, admin, olaMember)).rejects.toThrow(/allerede avsluttet/)
    expect((await audit('board.end'))[0]).toMatchObject({
      subjectPersonId: ola!.personId,
      details: { role: 'member', endYear: 2026 },
    })

    // Et avsluttet verv kan ikke bli nåværende igjen når personen allerede sitter.
    const [kariPast] = overview.past.filter((s) => s.fullName === 'Kari')
    await expect(
      updateBoardMember(db, admin, kariPast!.id, {
        role: 'vice_chair',
        responsibility: null,
        startYear: 2025,
        endYear: null,
        note: null,
      }),
    ).rejects.toThrow(/Kari sitter allerede i styret/)

    await removeBoardMember(db, admin, olaMember)
    expect(await audit('board.remove')).toHaveLength(1)
  })

  it('databasen holder på én leder selv om to admins lagrer samtidig', async () => {
    const results = await Promise.allSettled([
      addBoardMember(db, admin, { personId: ola!.personId!, role: 'chair' }),
      addBoardMember(db, admin, { personId: kari!.personId!, role: 'chair' }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect((await listBoardOverview(db, admin)).current).toHaveLength(1)
  })

  it('styresiden, profilen, katalogen og søket viser vervene', async () => {
    const pending = await profile('Gunnar Borte', 'pending')
    const former = await profile('Siri Berg')
    await addBoardMember(db, admin, {
      personId: ola!.personId!,
      role: 'chair',
      responsibility: 'Strategi',
      startYear: 2024,
      note: 'Hemmelig notat',
    })
    await addBoardMember(db, admin, { personId: pending, startYear: 2024 })
    const { id: s1 } = await addBoardMember(db, admin, {
      personId: former,
      role: 'member',
      startYear: 2019,
    })
    const { id: s2 } = await changeBoardRole(db, admin, s1, { role: 'vice_chair', year: 2021 })
    await endBoardMember(db, admin, s2, { endYear: 2022 })

    const board = await getBoard(db, kari)
    // Bare aktive medlemmer, og notatet bare for admins.
    expect(board.current.map((s) => [s.fullName, s.role, s.responsibility, s.note])).toEqual([
      ['Ola', 'chair', 'Strategi', null],
    ])
    expect((await getBoard(db, admin)).current[0]!.note).toBe('Hemmelig notat')
    expect(board.former).toEqual([
      expect.objectContaining({
        fullName: 'Siri Berg',
        roles: ['vice_chair', 'member'],
        period: '2019–2022',
      }),
    ])
    expect((await listBoardOverview(db, admin)).current.map((s) => [s.fullName, s.status])).toEqual(
      [
        ['Ola', 'active'],
        ['Gunnar Borte', 'pending'],
      ],
    )

    expect((await getProfile(db, kari, ola!.personId!)).board).toEqual({
      current: true,
      role: 'chair',
      responsibility: 'Strategi',
      period: 'siden 2024',
    })
    expect((await getProfile(db, kari, former)).board).toEqual({
      current: false,
      roles: ['vice_chair', 'member'],
      period: '2019–2022',
    })
    expect((await getProfile(db, kari, kari!.personId!)).board).toBeNull()

    const members = await listActiveMembers(db, kari)
    expect(members.find((m) => m.personId === ola!.personId)!.boardRole).toBe('chair')
    expect(members.find((m) => m.personId === former)!.boardRole).toBeNull()
    expect((await searchPeople(db, kari, 'Ola'))[0]!.boardRole).toBe('chair')

    const candidates = await listBoardCandidates(db, admin, 'o')
    expect(candidates).toEqual([])
    expect(
      (await listBoardCandidates(db, admin, 'ol')).map((c) => [c.fullName, c.onBoard]),
    ).toEqual([['Ola', true]])
  })

  it('sammenslåing flytter vervene, og målets nåværende verv gjelder', async () => {
    const dup = await profile('Ola')
    const { id: past } = await addBoardMember(db, admin, { personId: dup, startYear: 2015 })
    await endBoardMember(db, admin, past, { endYear: 2017 })
    await addBoardMember(db, admin, { personId: dup, role: 'deputy', startYear: 2024 })
    await addBoardMember(db, admin, { personId: ola!.personId!, role: 'chair', startYear: 2024 })

    const { personId } = await mergePeople(db, storage, admin, {
      sourceId: dup,
      targetId: ola!.personId!,
    })
    const overview = await listBoardOverview(db, admin)
    expect(overview.current.map((s) => [s.personId, s.role])).toEqual([[personId, 'chair']])
    expect(overview.past.map((s) => [s.personId, s.startYear, s.endYear])).toEqual([
      [personId, 2015, 2017],
    ])
    expect((await audit('person.merge'))[0]!.details).toMatchObject({ board: 1 })
  })
})
