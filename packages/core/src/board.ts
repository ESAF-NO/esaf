import { schema, type BoardRole, type Db, type MembershipStatus } from '@esaf/db'
import { and, asc, eq, ilike, inArray, isNull, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import { assertCan, assertMember, can, type Viewer } from './access.ts'
import { endedPeriods, span } from './cohort-reps.ts'
import { DomainError, NotFoundError } from './errors.ts'
import type { Tx } from './members.ts'
import type { AdminPerson } from './people-admin.ts'
import { photoUrls, type ProfilePhoto } from './photos.ts'
import { optionalText } from './validation.ts'

const { auditEvent, boardMember, cohort, membership, person, personCohort } = schema

/**
 * Styret i ESAF. Reglene:
 *
 * - Et verv er én person i én rolle fra et år til et år. Uten sluttår sitter
 *   personen i styret nå. Avsluttede verv blir stående, så historikken står.
 * - En person sitter bare én gang i styret om gangen, og styret har én leder
 *   og én nestleder om gangen. Bytter noen rolle, avsluttes det gamle vervet og
 *   et nytt startes samme år (`changeBoardRole`).
 * - Admins med `members.manage` (sterkt innlogget) setter, retter, avslutter og
 *   sletter verv, og alt logges (`board.add`, `board.edit`, `board.role_change`,
 *   `board.end`, `board.remove`).
 * - Medlemmer ser styret og tidligere styremedlemmer som er aktive medlemmer.
 *   Notatet vises bare for admins.
 */

export const boardRoles = ['chair', 'vice_chair', 'member', 'deputy'] as const satisfies BoardRole[]

/** Rollene slik de vises: «Leder», «Nestleder», «Styremedlem», «Varamedlem». */
export const boardRoleNames: Record<BoardRole, string> = {
  chair: 'Leder',
  vice_chair: 'Nestleder',
  member: 'Styremedlem',
  deputy: 'Varamedlem',
}

/** Rollene det bare kan være én av i styret om gangen. */
const singleSeat = (role: BoardRole) => role === 'chair' || role === 'vice_chair'

const roleOrder = (role: BoardRole) => boardRoles.indexOf(role)

/** Et verv slik det lagres: rollen og årene. */
export type BoardTerm = {
  role: BoardRole
  responsibility: string | null
  startYear: number | null
  endYear: number | null
}

/** Merket på profilen: «Leder i styret siden 2025», eller «Styret 2019–2022» for tidligere. */
export type BoardBadge =
  | {
      current: true
      role: BoardRole
      responsibility: string | null
      /** «siden 2023», eller null når det ikke er kjent. */
      period: string | null
    }
  | {
      current: false
      /** Rollene personen har hatt, i rekkefølgen leder, nestleder, styremedlem, vara. */
      roles: BoardRole[]
      /** «2019–2022» eller «2023–2024, 2019». */
      period: string
    }

const distinctRoles = (terms: BoardTerm[]) =>
  [...new Set(terms.map((t) => t.role))].sort((a, b) => roleOrder(a) - roleOrder(b))

/**
 * Hvordan vervene til én person vises på profilen: det nåværende vervet, ellers
 * tidligere verv samlet med årene. Perioder som henger sammen, slås sammen.
 */
export function boardBadge(terms: BoardTerm[] | undefined): BoardBadge | null {
  if (!terms?.length) return null
  const ongoing = terms.find((t) => t.endYear === null)
  if (ongoing) {
    return {
      current: true,
      role: ongoing.role,
      responsibility: ongoing.responsibility,
      period: span(sittingSince(terms), null),
    }
  }
  return {
    current: false,
    roles: distinctRoles(terms),
    period: endedPeriods(terms as (BoardTerm & { endYear: number })[]).period,
  }
}

/**
 * Året personen kom inn i styret og har sittet sammenhengende siden, også når
 * hen har byttet rolle underveis. Null når starten ikke er kjent.
 */
export function sittingSince(terms: Pick<BoardTerm, 'startYear' | 'endYear'>[]): number | null {
  const ongoing = terms.find((t) => t.endYear === null)
  let since = ongoing?.startYear ?? null
  if (since === null) return null
  const ended = terms.filter((t) => t.endYear !== null)
  for (;;) {
    const before = ended.find(
      (t) => t.endYear! >= since! - 1 && (t.startYear === null || t.startYear < since!),
    )
    if (!before) return since
    if (before.startYear === null) return null
    since = before.startYear
  }
}

/** Rollen personen har i styret nå, til små merker i lister og søk. */
export const currentBoardRole = (terms: BoardTerm[] | undefined): BoardRole | null =>
  terms?.find((t) => t.endYear === null)?.role ?? null

/** Vervene til personene, for profiler, katalogen og søk. */
export async function loadBoardTerms(
  db: Db,
  personIds: string[],
): Promise<Map<string, BoardTerm[]>> {
  const byPerson = new Map<string, BoardTerm[]>()
  if (!personIds.length) return byPerson
  const rows = await db
    .select({
      personId: boardMember.personId,
      role: boardMember.role,
      responsibility: boardMember.responsibility,
      startYear: boardMember.startYear,
      endYear: boardMember.endYear,
    })
    .from(boardMember)
    .where(inArray(boardMember.personId, [...new Set(personIds)]))
  for (const { personId, ...term } of rows) {
    byPerson.set(personId, [...(byPerson.get(personId) ?? []), term])
  }
  return byPerson
}

export type BoardSeat = {
  id: string
  personId: string
  fullName: string
  photo: ProfilePhoto | null
  claimed: boolean
  role: BoardRole
  responsibility: string | null
  startYear: number | null
  endYear: number | null
  /** Bare for admins med `members.manage`. */
  note: string | null
}

/** En i styret nå, med året hen kom inn (se `sittingSince`). */
export type CurrentBoardSeat = BoardSeat & { since: number | null }

/** En som har sittet i styret, med alle vervene samlet. */
export type FormerBoardMember = {
  personId: string
  fullName: string
  photo: ProfilePhoto | null
  claimed: boolean
  roles: BoardRole[]
  /** «2019–2022» eller «2023–2024, 2019». */
  period: string
}

export type Board = {
  /** Styret nå: leder, nestleder, styremedlemmer og vara, så etter navn. */
  current: CurrentBoardSeat[]
  /** Tidligere styremedlemmer som ikke sitter nå, sist ute først. */
  former: FormerBoardMember[]
}

const seatColumns = {
  id: boardMember.id,
  personId: person.id,
  fullName: person.fullName,
  photoKey: person.photoKey,
  userId: person.userId,
  role: boardMember.role,
  responsibility: boardMember.responsibility,
  startYear: boardMember.startYear,
  endYear: boardMember.endYear,
  note: boardMember.note,
}

type SeatRow = {
  id: string
  personId: string
  fullName: string
  photoKey: string | null
  userId: string | null
  role: BoardRole
  responsibility: string | null
  startYear: number | null
  endYear: number | null
  note: string | null
}

function toSeat(row: SeatRow, showNote: boolean): BoardSeat {
  return {
    id: row.id,
    personId: row.personId,
    fullName: row.fullName,
    photo: photoUrls(row.photoKey),
    claimed: row.userId !== null,
    role: row.role,
    responsibility: row.responsibility,
    startYear: row.startYear,
    endYear: row.endYear,
    note: showNote ? row.note : null,
  }
}

const byName = (a: { fullName: string }, b: { fullName: string }) =>
  a.fullName.localeCompare(b.fullName, 'nb')
const bySeat = (a: BoardSeat, b: BoardSeat) => roleOrder(a.role) - roleOrder(b.role) || byName(a, b)
const byEnd = (a: BoardSeat, b: BoardSeat) =>
  (b.endYear ?? 0) - (a.endYear ?? 0) || (b.startYear ?? 0) - (a.startYear ?? 0) || bySeat(a, b)

/** Styret nå og tidligere, til styresiden. Bare aktive medlemmer vises. */
export async function getBoard(db: Db, viewer: Viewer): Promise<Board> {
  assertMember(viewer)
  const rows = await db
    .select(seatColumns)
    .from(boardMember)
    .innerJoin(person, eq(person.id, boardMember.personId))
    .innerJoin(membership, and(eq(membership.personId, person.id), eq(membership.status, 'active')))
  const showNote = can(viewer, 'members.manage')
  const seats = rows.map((r) => toSeat(r, showNote))
  const current = seats
    .filter((s) => s.endYear === null)
    .sort(bySeat)
    .map((s) => ({ ...s, since: sittingSince(seats.filter((o) => o.personId === s.personId)) }))
  const sitting = new Set(current.map((s) => s.personId))

  const pastByPerson = new Map<string, BoardSeat[]>()
  for (const s of seats) {
    if (s.endYear === null || sitting.has(s.personId)) continue
    pastByPerson.set(s.personId, [...(pastByPerson.get(s.personId) ?? []), s])
  }
  const former = [...pastByPerson.values()]
    .map((terms) => {
      const { period, lastEnd } = endedPeriods(terms as (BoardSeat & { endYear: number })[])
      const [first] = terms
      return {
        personId: first!.personId,
        fullName: first!.fullName,
        photo: first!.photo,
        claimed: first!.claimed,
        roles: distinctRoles(terms),
        period,
        lastEnd,
      }
    })
    .sort((a, b) => b.lastEnd - a.lastEnd || byName(a, b))
    .map(({ lastEnd: _lastEnd, ...f }) => f)
  return { current, former }
}

export type AdminBoardSeat = BoardSeat & {
  /** Medlemskapet til personen; verv til dem som ikke er aktive, vises ikke for medlemmer. */
  status: MembershipStatus | null
}

export type BoardOverview = {
  current: AdminBoardSeat[]
  /** Avsluttede verv, sist avsluttet først. */
  past: AdminBoardSeat[]
}

/** Alle verv, også for personer som ikke er aktive medlemmer, til Admin → Styret. */
export async function listBoardOverview(db: Db, viewer: Viewer): Promise<BoardOverview> {
  assertCan(viewer, 'members.manage')
  const rows = await db
    .select({ ...seatColumns, status: membership.status })
    .from(boardMember)
    .innerJoin(person, eq(person.id, boardMember.personId))
    .leftJoin(membership, eq(membership.personId, person.id))
  const seats = rows.map((r) => ({ ...toSeat(r, true), status: r.status }))
  return {
    current: seats.filter((s) => s.endYear === null).sort(bySeat),
    past: seats.filter((s) => s.endYear !== null).sort(byEnd),
  }
}

export type BoardCandidate = AdminPerson & {
  /** Sitter i styret nå, og kan ikke legges til på nytt. */
  onBoard: boolean
}

/** Søk på navn blant alle personer, til å velge hvem som skal inn i styret. Aktive medlemmer først. */
export async function listBoardCandidates(
  db: Db,
  viewer: Viewer,
  query: string,
): Promise<BoardCandidate[]> {
  assertCan(viewer, 'members.manage')
  const q = query.trim()
  if (q.length < 2) return []
  const rows = await db
    .select({
      personId: person.id,
      fullName: person.fullName,
      photoKey: person.photoKey,
      userId: person.userId,
      source: person.source,
      status: membership.status,
      createdAt: person.createdAt,
      onBoard: sql<boolean>`exists (select 1 from ${boardMember} where ${boardMember.personId} = ${person.id} and ${boardMember.endYear} is null)`,
    })
    .from(person)
    .leftJoin(membership, eq(membership.personId, person.id))
    .where(ilike(person.fullName, `%${q.replace(/[%_\\]/g, '\\$&')}%`))
    .orderBy(sql`${membership.status} is distinct from 'active'`, asc(person.fullName))
    .limit(20)
  const years = rows.length
    ? await db
        .select({ personId: personCohort.personId, year: cohort.graduationYear })
        .from(personCohort)
        .innerJoin(cohort, eq(cohort.id, personCohort.cohortId))
        .where(
          inArray(
            personCohort.personId,
            rows.map((r) => r.personId),
          ),
        )
        .orderBy(asc(cohort.graduationYear))
    : []
  return rows.map(({ photoKey, userId, ...r }) => ({
    ...r,
    photo: photoUrls(photoKey),
    claimed: userId !== null,
    cohortYears: years.filter((y) => y.personId === r.personId).map((y) => y.year),
  }))
}

const year = z
  .number()
  .int()
  .min(1990, 'Ugyldig årstall.')
  .refine((y) => y <= new Date().getFullYear() + 1, 'Årstallet kan ikke være så langt fram i tid.')
  .nullable()

const role = z.enum(boardRoles, 'Ugyldig rolle.')

export const boardMemberInput = z.object({
  personId: z.uuid(),
  role: role.default('member'),
  responsibility: optionalText(80).default(null),
  /** Standard i år. */
  startYear: year.default(null),
  note: optionalText(300).default(null),
})

const boardTermInput = z
  .object({
    role,
    responsibility: optionalText(80),
    startYear: year,
    endYear: year,
    note: optionalText(300),
  })
  .refine((t) => t.startYear === null || t.endYear === null || t.endYear >= t.startYear, {
    message: 'Sluttåret kan ikke være før startåret.',
  })

const roleChangeInput = z.object({
  role,
  /** Uten ansvarsområde har det nye vervet ikke noe. */
  responsibility: optionalText(80).default(null),
  /** Året det gamle vervet slutter og det nye starter. Standard i år. */
  year: year.default(null),
})

export type BoardMemberInput = z.input<typeof boardMemberInput>
export type BoardTermInput = z.input<typeof boardTermInput>
export type BoardRoleChangeInput = z.input<typeof roleChangeInput>

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new DomainError(parsed.error.issues[0]?.message ?? 'Ugyldige felt.')
  return parsed.data
}

/**
 * Alle endringer i styret går etter hverandre, så to admins ikke kan sette to
 * ledere samtidig. Den unike indeksen i databasen er siste skanse.
 */
const lockBoard = (tx: Tx) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext('board_member'))`)

/** Kaster hvis rollen allerede er tatt av en annen nå. */
async function assertSeatFree(tx: Tx, seat: BoardRole, except?: string) {
  if (!singleSeat(seat)) return
  const [taken] = await tx
    .select({ fullName: person.fullName })
    .from(boardMember)
    .innerJoin(person, eq(person.id, boardMember.personId))
    .where(
      and(
        eq(boardMember.role, seat),
        isNull(boardMember.endYear),
        except ? ne(boardMember.id, except) : undefined,
      ),
    )
  if (taken) {
    throw new DomainError(
      `${taken.fullName} er ${boardRoleNames[seat].toLocaleLowerCase('nb')} nå. Bytt rollen eller avslutt vervet først.`,
    )
  }
}

/** Kaster hvis personen allerede sitter i styret nå. */
async function assertNotSitting(tx: Tx, personId: string, fullName: string, except?: string) {
  const [sitting] = await tx
    .select({ id: boardMember.id })
    .from(boardMember)
    .where(
      and(
        eq(boardMember.personId, personId),
        isNull(boardMember.endYear),
        except ? ne(boardMember.id, except) : undefined,
      ),
    )
  if (sitting) throw new DomainError(`${fullName} sitter allerede i styret.`)
}

/** Setter en person inn i styret fra `startYear` (standard i år). */
export async function addBoardMember(
  db: Db,
  viewer: Viewer,
  input: BoardMemberInput,
): Promise<{ id: string }> {
  assertCan(viewer, 'members.manage')
  const values = parse(boardMemberInput, input)
  return db.transaction(async (tx) => {
    await lockBoard(tx)
    const [who] = await tx
      .select({ id: person.id, fullName: person.fullName })
      .from(person)
      .where(eq(person.id, values.personId))
      .for('update')
    if (!who) throw new NotFoundError('Fant ikke personen.')
    await assertNotSitting(tx, who.id, who.fullName)
    await assertSeatFree(tx, values.role)
    const startYear = values.startYear ?? new Date().getFullYear()
    const [row] = await tx
      .insert(boardMember)
      .values({
        personId: who.id,
        role: values.role,
        responsibility: values.responsibility,
        startYear,
        note: values.note,
      })
      .returning({ id: boardMember.id })
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'board.add',
      subjectPersonId: who.id,
      details: {
        boardMemberId: row!.id,
        role: values.role,
        responsibility: values.responsibility,
        startYear,
      },
    })
    return row!
  })
}

async function lockTerm(tx: Tx, id: string) {
  const [row] = await tx
    .select({
      id: boardMember.id,
      personId: boardMember.personId,
      fullName: person.fullName,
      role: boardMember.role,
      responsibility: boardMember.responsibility,
      startYear: boardMember.startYear,
      endYear: boardMember.endYear,
      note: boardMember.note,
    })
    .from(boardMember)
    .innerJoin(person, eq(person.id, boardMember.personId))
    .where(eq(boardMember.id, id))
    .for('update', { of: boardMember })
  if (!row) throw new NotFoundError('Fant ikke vervet.')
  return row
}

/**
 * Retter rollen, ansvarsområdet, årene og notatet for et verv, for feil som ble
 * lagt inn. Uten sluttår er vervet nåværende igjen. Når noen faktisk bytter
 * rolle, bruk `changeBoardRole`, så historikken står.
 */
export async function updateBoardMember(
  db: Db,
  viewer: Viewer,
  id: string,
  input: BoardTermInput,
): Promise<void> {
  assertCan(viewer, 'members.manage')
  const values = parse(boardTermInput, input)
  await db.transaction(async (tx) => {
    await lockBoard(tx)
    const before = await lockTerm(tx, id)
    if (
      before.role === values.role &&
      before.responsibility === values.responsibility &&
      before.startYear === values.startYear &&
      before.endYear === values.endYear &&
      before.note === values.note
    ) {
      return
    }
    if (values.endYear === null) {
      await assertNotSitting(tx, before.personId, before.fullName, id)
      await assertSeatFree(tx, values.role, id)
    }
    await tx.update(boardMember).set(values).where(eq(boardMember.id, id))
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'board.edit',
      subjectPersonId: before.personId,
      details: {
        boardMemberId: id,
        from: {
          role: before.role,
          responsibility: before.responsibility,
          startYear: before.startYear,
          endYear: before.endYear,
        },
        to: {
          role: values.role,
          responsibility: values.responsibility,
          startYear: values.startYear,
          endYear: values.endYear,
        },
        noteChanged: before.note !== values.note,
      },
    })
  })
}

/**
 * Noen bytter rolle i styret, f.eks. fra styremedlem til leder etter
 * generalforsamlingen. Det nåværende vervet avsluttes i `year` (standard i år),
 * og et nytt starter samme år. Notatet følger med.
 */
export async function changeBoardRole(
  db: Db,
  viewer: Viewer,
  id: string,
  input: BoardRoleChangeInput,
): Promise<{ id: string }> {
  assertCan(viewer, 'members.manage')
  const values = parse(roleChangeInput, input)
  const at = values.year ?? new Date().getFullYear()
  return db.transaction(async (tx) => {
    await lockBoard(tx)
    const term = await lockTerm(tx, id)
    if (term.endYear !== null) throw new DomainError('Vervet er allerede avsluttet.')
    if (term.role === values.role && term.responsibility === values.responsibility) {
      throw new DomainError('Velg en annen rolle eller et annet ansvarsområde.')
    }
    if (term.startYear !== null && at < term.startYear) {
      throw new DomainError('Byttet kan ikke være før vervet startet.')
    }
    await assertSeatFree(tx, values.role, id)
    await tx.update(boardMember).set({ endYear: at }).where(eq(boardMember.id, id))
    const [row] = await tx
      .insert(boardMember)
      .values({
        personId: term.personId,
        role: values.role,
        responsibility: values.responsibility,
        startYear: at,
        note: term.note,
      })
      .returning({ id: boardMember.id })
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'board.role_change',
      subjectPersonId: term.personId,
      details: {
        endedId: id,
        boardMemberId: row!.id,
        year: at,
        from: { role: term.role, responsibility: term.responsibility },
        to: { role: values.role, responsibility: values.responsibility },
      },
    })
    return row!
  })
}

/** Avslutter et nåværende verv i `endYear` (standard i år). */
export async function endBoardMember(
  db: Db,
  viewer: Viewer,
  id: string,
  input: { endYear?: number | null } = {},
): Promise<void> {
  assertCan(viewer, 'members.manage')
  const endYear = parse(year, input.endYear ?? new Date().getFullYear())!
  await db.transaction(async (tx) => {
    const term = await lockTerm(tx, id)
    if (term.endYear !== null) throw new DomainError('Vervet er allerede avsluttet.')
    if (term.startYear !== null && endYear < term.startYear) {
      throw new DomainError('Sluttåret kan ikke være før startåret.')
    }
    await tx.update(boardMember).set({ endYear }).where(eq(boardMember.id, id))
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'board.end',
      subjectPersonId: term.personId,
      details: { boardMemberId: id, role: term.role, startYear: term.startYear, endYear },
    })
  })
}

/** Sletter et verv som ble lagt inn ved en feil. Avsluttede verv bør heller stå. */
export async function removeBoardMember(db: Db, viewer: Viewer, id: string): Promise<void> {
  assertCan(viewer, 'members.manage')
  await db.transaction(async (tx) => {
    const term = await lockTerm(tx, id)
    await tx.delete(boardMember).where(eq(boardMember.id, id))
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'board.remove',
      subjectPersonId: term.personId,
      details: {
        boardMemberId: id,
        role: term.role,
        startYear: term.startYear,
        endYear: term.endYear,
      },
    })
  })
}
