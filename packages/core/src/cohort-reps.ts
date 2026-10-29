import { schema, type Db, type MembershipStatus } from '@esaf/db'
import { and, asc, desc, eq, ilike, inArray, isNull, ne } from 'drizzle-orm'
import { z } from 'zod'
import { assertCan, assertMember, can, type Viewer } from './access.ts'
import { DomainError, NotFoundError } from './errors.ts'
import type { Tx } from './members.ts'
import type { AdminPerson } from './people-admin.ts'
import { photoUrls, type ProfilePhoto } from './photos.ts'
import { optionalText } from './validation.ts'

const { auditEvent, cohort, cohortRepresentative, membership, person, personCohort } = schema

/**
 * Kullrepresentanter: dem styret snakker med, og som sender videre til kullet.
 * Reglene:
 *
 * - Et kull kan ha flere representanter samtidig, og vervet har en historikk.
 *   Uten sluttår er vervet nåværende.
 * - Admins med `members.manage` (sterkt innlogget) setter, retter, avslutter og
 *   sletter verv, og alt logges (`cohort.rep_add`, `cohort.rep_edit`,
 *   `cohort.rep_end`, `cohort.rep_remove`).
 * - Vanligvis er representanten fra kullet selv. En person fra et annet kull kan
 *   bare settes når admin uttrykkelig sier at det er meningen (`otherCohort`).
 * - Medlemmer ser representanter som er aktive medlemmer. Notatet vises bare
 *   for admins.
 */

/** Et verv slik det lagres: kullet og årene. */
export type RepresentativeTerm = {
  graduationYear: number
  startYear: number | null
  endYear: number | null
}

/** Merket på profilen: «Kullrepresentant ES 2024», eller tidligere med årene. */
export type RepresentativeBadge = {
  graduationYear: number
  current: boolean
  /** «2019–2022», «siden 2023» eller «til 2018». Null når det ikke er kjent. */
  period: string | null
}

function span(start: number | null, end: number | null) {
  if (end === null) return start === null ? null : `siden ${start}`
  if (start === null) return `til ${end}`
  return start === end ? String(start) : `${start}–${end}`
}

/**
 * Hvordan vervene til én person vises. Nåværende verv først (ett merke per kull),
 * så tidligere verv per kull med årene, nyeste først. Tidligere verv i et kull
 * personen fortsatt representerer, vises ikke. Perioder som overlapper eller
 * henger sammen, slås sammen: 2019–2020 og 2021–2022 blir 2019–2022.
 */
export function representativeBadges(terms: RepresentativeTerm[]): RepresentativeBadge[] {
  const byCohort = new Map<number, RepresentativeTerm[]>()
  for (const t of terms)
    byCohort.set(t.graduationYear, [...(byCohort.get(t.graduationYear) ?? []), t])

  const current: (RepresentativeBadge & { sort: number })[] = []
  const past: (RepresentativeBadge & { sort: number })[] = []
  for (const [graduationYear, list] of byCohort) {
    const ongoing = list.filter((t) => t.endYear === null)
    if (ongoing.length) {
      const starts = ongoing.map((t) => t.startYear).filter((y): y is number => y !== null)
      current.push({
        graduationYear,
        current: true,
        period: span(starts.length ? Math.min(...starts) : null, null),
        sort: graduationYear,
      })
      continue
    }
    // Sortert på start (ukjent start først), så perioder som henger sammen slås sammen.
    const ended = [...list].sort(
      (a, b) =>
        (a.startYear ?? a.endYear!) - (b.startYear ?? b.endYear!) || a.endYear! - b.endYear!,
    )
    const merged: { start: number | null; end: number }[] = []
    for (const t of ended) {
      const last = merged.at(-1)
      const start = t.startYear ?? t.endYear!
      if (last && start <= last.end + 1) {
        last.end = Math.max(last.end, t.endYear!)
        if (t.startYear === null && last.start !== null && t.endYear! < last.start)
          last.start = null
      } else {
        merged.push({ start: t.startYear, end: t.endYear! })
      }
    }
    past.push({
      graduationYear,
      current: false,
      period: merged
        .reverse()
        .map((m) => span(m.start, m.end))
        .join(', '),
      sort: merged[0]!.end,
    })
  }
  return [
    ...current.sort((a, b) => b.sort - a.sort),
    ...past.sort((a, b) => b.sort - a.sort || b.graduationYear - a.graduationYear),
  ].map(({ sort: _sort, ...badge }) => badge)
}

/** Vervene til personene, for profiler, katalogen og søk. */
export async function loadRepresentativeTerms(
  db: Db,
  personIds: string[],
): Promise<Map<string, RepresentativeTerm[]>> {
  const byPerson = new Map<string, RepresentativeTerm[]>()
  if (!personIds.length) return byPerson
  const rows = await db
    .select({
      personId: cohortRepresentative.personId,
      graduationYear: cohort.graduationYear,
      startYear: cohortRepresentative.startYear,
      endYear: cohortRepresentative.endYear,
    })
    .from(cohortRepresentative)
    .innerJoin(cohort, eq(cohort.id, cohortRepresentative.cohortId))
    .where(inArray(cohortRepresentative.personId, [...new Set(personIds)]))
  for (const { personId, ...term } of rows) {
    byPerson.set(personId, [...(byPerson.get(personId) ?? []), term])
  }
  return byPerson
}

/** Kullene personen er kullrepresentant for nå, nyeste først. */
export const currentRepresentativeOf = (terms: RepresentativeTerm[] | undefined) =>
  [...new Set((terms ?? []).filter((t) => t.endYear === null).map((t) => t.graduationYear))].sort(
    (a, b) => b - a,
  )

export type CohortRepresentative = {
  id: string
  personId: string
  fullName: string
  photo: ProfilePhoto | null
  claimed: boolean
  startYear: number | null
  endYear: number | null
  /** Bare for admins med `members.manage`. */
  note: string | null
  /** Personen går ikke selv i kullet (som student, ansatt eller mentor). */
  otherCohort: boolean
}

export type CohortRepresentatives = {
  current: CohortRepresentative[]
  /** Tidligere verv, sist avsluttet først. */
  past: CohortRepresentative[]
}

const repColumns = {
  id: cohortRepresentative.id,
  personId: person.id,
  fullName: person.fullName,
  photoKey: person.photoKey,
  userId: person.userId,
  startYear: cohortRepresentative.startYear,
  endYear: cohortRepresentative.endYear,
  note: cohortRepresentative.note,
  cohortId: cohortRepresentative.cohortId,
}

type RepRow = {
  id: string
  personId: string
  fullName: string
  photoKey: string | null
  userId: string | null
  startYear: number | null
  endYear: number | null
  note: string | null
  cohortId: string
}

/** Hvilke av personene som hører til hvilke kull (cohortId), til å merke representanter fra andre kull. */
async function cohortMembership(db: Db | Tx, personIds: string[]) {
  const rows = personIds.length
    ? await db
        .select({ personId: personCohort.personId, cohortId: personCohort.cohortId })
        .from(personCohort)
        .where(inArray(personCohort.personId, [...new Set(personIds)]))
    : []
  return new Set(rows.map((r) => `${r.personId}:${r.cohortId}`))
}

function toView(row: RepRow, inCohort: Set<string>, showNote: boolean): CohortRepresentative {
  return {
    id: row.id,
    personId: row.personId,
    fullName: row.fullName,
    photo: photoUrls(row.photoKey),
    claimed: row.userId !== null,
    startYear: row.startYear,
    endYear: row.endYear,
    note: showNote ? row.note : null,
    otherCohort: !inCohort.has(`${row.personId}:${row.cohortId}`),
  }
}

const byStart = (a: CohortRepresentative, b: CohortRepresentative) =>
  (a.startYear ?? 0) - (b.startYear ?? 0) || a.fullName.localeCompare(b.fullName, 'nb')
const byEnd = (a: CohortRepresentative, b: CohortRepresentative) =>
  (b.endYear ?? 0) - (a.endYear ?? 0) || byStart(a, b)

/** Representantene for ett kull, til kullsiden. Bare aktive medlemmer vises. */
export async function listCohortRepresentatives(
  db: Db,
  viewer: Viewer,
  graduationYear: number,
): Promise<CohortRepresentatives> {
  assertMember(viewer)
  const rows = await db
    .select(repColumns)
    .from(cohortRepresentative)
    .innerJoin(cohort, eq(cohort.id, cohortRepresentative.cohortId))
    .innerJoin(person, eq(person.id, cohortRepresentative.personId))
    .innerJoin(membership, and(eq(membership.personId, person.id), eq(membership.status, 'active')))
    .where(eq(cohort.graduationYear, graduationYear))
  const inCohort = await cohortMembership(
    db,
    rows.map((r) => r.personId),
  )
  const showNote = can(viewer, 'members.manage')
  const views = rows.map((r) => toView(r, inCohort, showNote))
  return {
    current: views.filter((r) => r.endYear === null).sort(byStart),
    past: views.filter((r) => r.endYear !== null).sort(byEnd),
  }
}

export type AdminRepresentative = CohortRepresentative & {
  /** Medlemskapet til personen; representanter som ikke er aktive, vises ikke for medlemmer. */
  status: MembershipStatus | null
}

export type RepresentativeOverviewCohort = {
  graduationYear: number
  /** Aktive medlemmer i kullet (studenter). */
  members: number
  current: AdminRepresentative[]
  past: AdminRepresentative[]
}

/** Alle kull med representantene sine, til Admin → Kullrepresentanter. Nyeste kull først. */
export async function listRepresentativeOverview(
  db: Db,
  viewer: Viewer,
): Promise<RepresentativeOverviewCohort[]> {
  assertCan(viewer, 'members.manage')
  const [cohorts, rows, counts] = await Promise.all([
    db
      .select({ id: cohort.id, graduationYear: cohort.graduationYear })
      .from(cohort)
      .orderBy(desc(cohort.graduationYear)),
    db
      .select({ ...repColumns, status: membership.status })
      .from(cohortRepresentative)
      .innerJoin(person, eq(person.id, cohortRepresentative.personId))
      .leftJoin(membership, eq(membership.personId, person.id)),
    db
      .select({ cohortId: personCohort.cohortId, personId: personCohort.personId })
      .from(personCohort)
      .innerJoin(
        membership,
        and(eq(membership.personId, personCohort.personId), eq(membership.status, 'active')),
      )
      .where(eq(personCohort.relation, 'student')),
  ])
  const inCohort = await cohortMembership(
    db,
    rows.map((r) => r.personId),
  )
  const members = new Map<string, number>()
  for (const c of counts) members.set(c.cohortId, (members.get(c.cohortId) ?? 0) + 1)
  return cohorts.map((c) => {
    const reps = rows
      .filter((r) => r.cohortId === c.id)
      .map((r) => ({ ...toView(r, inCohort, true), status: r.status }))
    return {
      graduationYear: c.graduationYear,
      members: members.get(c.id) ?? 0,
      current: reps.filter((r) => r.endYear === null).sort(byStart),
      past: reps.filter((r) => r.endYear !== null).sort(byEnd),
    }
  })
}

export type RepresentativeCandidate = AdminPerson & {
  /** Går i kullet (som student, ansatt eller mentor). */
  inCohort: boolean
}

/**
 * Hvem som kan velges som representant for et kull: med `query` søk på navn
 * blant alle personer, ellers alle i kullet. De i kullet først.
 */
export async function listRepresentativeCandidates(
  db: Db,
  viewer: Viewer,
  input: { graduationYear: number; query?: string },
): Promise<RepresentativeCandidate[]> {
  assertCan(viewer, 'members.manage')
  const q = input.query?.trim() ?? ''
  if (q && q.length < 2) return []
  const ids = q
    ? await db
        .select({ personId: person.id })
        .from(person)
        .where(ilike(person.fullName, `%${q.replace(/[%_\\]/g, '\\$&')}%`))
        .orderBy(asc(person.fullName))
        .limit(20)
    : await db
        .select({ personId: personCohort.personId })
        .from(personCohort)
        .innerJoin(cohort, eq(cohort.id, personCohort.cohortId))
        .where(eq(cohort.graduationYear, input.graduationYear))
  const people = ids.length
    ? await peopleById(
        db,
        ids.map((r) => r.personId),
      )
    : []
  return people
    .map((p) => ({ ...p, inCohort: p.cohortYears.includes(input.graduationYear) }))
    .sort(
      (a, b) =>
        Number(b.inCohort) - Number(a.inCohort) || a.fullName.localeCompare(b.fullName, 'nb'),
    )
}

async function peopleById(db: Db, ids: string[]): Promise<AdminPerson[]> {
  const [rows, years] = await Promise.all([
    db
      .select({
        personId: person.id,
        fullName: person.fullName,
        photoKey: person.photoKey,
        userId: person.userId,
        source: person.source,
        status: membership.status,
        createdAt: person.createdAt,
      })
      .from(person)
      .leftJoin(membership, eq(membership.personId, person.id))
      .where(inArray(person.id, ids)),
    db
      .select({ personId: personCohort.personId, year: cohort.graduationYear })
      .from(personCohort)
      .innerJoin(cohort, eq(cohort.id, personCohort.cohortId))
      .where(inArray(personCohort.personId, ids))
      .orderBy(asc(cohort.graduationYear)),
  ])
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

const termInput = z
  .object({
    startYear: year,
    endYear: year,
    note: optionalText(300),
  })
  .refine((t) => t.startYear === null || t.endYear === null || t.endYear >= t.startYear, {
    message: 'Sluttåret kan ikke være før startåret.',
  })

export const representativeInput = z.object({
  graduationYear: z.number().int(),
  personId: z.uuid(),
  startYear: year,
  note: optionalText(300),
  /** Admin vet at personen ikke går i kullet, og vil likevel sette dem. */
  otherCohort: z.boolean().default(false),
})

export type RepresentativeInput = z.input<typeof representativeInput>
export type RepresentativeTermInput = z.input<typeof termInput>

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new DomainError(parsed.error.issues[0]?.message ?? 'Ugyldige felt.')
  return parsed.data
}

/** Setter en person som kullrepresentant fra `startYear` (standard i år). */
export async function addCohortRepresentative(
  db: Db,
  viewer: Viewer,
  input: RepresentativeInput,
): Promise<{ id: string }> {
  assertCan(viewer, 'members.manage')
  const values = parse(representativeInput, input)
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: cohort.id })
      .from(cohort)
      .where(eq(cohort.graduationYear, values.graduationYear))
    if (!target) throw new NotFoundError('Fant ikke kullet.')
    const [who] = await tx
      .select({ id: person.id, fullName: person.fullName })
      .from(person)
      .where(eq(person.id, values.personId))
      .for('update')
    if (!who) throw new NotFoundError('Fant ikke personen.')
    const inCohort = await cohortMembership(tx, [who.id])
    const other = !inCohort.has(`${who.id}:${target.id}`)
    if (other && !values.otherCohort) {
      throw new DomainError(
        `${who.fullName} går ikke i ES ${values.graduationYear}. Kryss av hvis det likevel er riktig.`,
      )
    }
    const [already] = await tx
      .select({ id: cohortRepresentative.id })
      .from(cohortRepresentative)
      .where(
        and(
          eq(cohortRepresentative.cohortId, target.id),
          eq(cohortRepresentative.personId, who.id),
          isNull(cohortRepresentative.endYear),
        ),
      )
    if (already) {
      throw new DomainError(
        `${who.fullName} er allerede kullrepresentant for ES ${values.graduationYear}.`,
      )
    }
    const startYear = values.startYear ?? new Date().getFullYear()
    const [row] = await tx
      .insert(cohortRepresentative)
      .values({ cohortId: target.id, personId: who.id, startYear, note: values.note })
      .returning({ id: cohortRepresentative.id })
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'cohort.rep_add',
      subjectPersonId: who.id,
      details: {
        representativeId: row!.id,
        graduationYear: values.graduationYear,
        startYear,
        otherCohort: other,
      },
    })
    return row!
  })
}

async function lockTerm(tx: Tx, id: string) {
  const [row] = await tx
    .select({
      id: cohortRepresentative.id,
      cohortId: cohortRepresentative.cohortId,
      personId: cohortRepresentative.personId,
      startYear: cohortRepresentative.startYear,
      endYear: cohortRepresentative.endYear,
      note: cohortRepresentative.note,
      graduationYear: cohort.graduationYear,
    })
    .from(cohortRepresentative)
    .innerJoin(cohort, eq(cohort.id, cohortRepresentative.cohortId))
    .where(eq(cohortRepresentative.id, id))
    .for('update', { of: cohortRepresentative })
  if (!row) throw new NotFoundError('Fant ikke vervet.')
  return row
}

/** Retter årene og notatet for et verv. Uten sluttår er vervet nåværende igjen. */
export async function updateCohortRepresentative(
  db: Db,
  viewer: Viewer,
  id: string,
  input: RepresentativeTermInput,
): Promise<void> {
  assertCan(viewer, 'members.manage')
  const values = parse(termInput, input)
  await db.transaction(async (tx) => {
    const before = await lockTerm(tx, id)
    if (
      before.startYear === values.startYear &&
      before.endYear === values.endYear &&
      before.note === values.note
    ) {
      return
    }
    if (values.endYear === null && before.endYear !== null) {
      const [other] = await tx
        .select({ id: cohortRepresentative.id })
        .from(cohortRepresentative)
        .where(
          and(
            eq(cohortRepresentative.cohortId, before.cohortId),
            eq(cohortRepresentative.personId, before.personId),
            isNull(cohortRepresentative.endYear),
            ne(cohortRepresentative.id, id),
          ),
        )
      if (other) throw new DomainError('Personen har allerede et nåværende verv for kullet.')
    }
    await tx.update(cohortRepresentative).set(values).where(eq(cohortRepresentative.id, id))
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'cohort.rep_edit',
      subjectPersonId: before.personId,
      details: {
        representativeId: id,
        graduationYear: before.graduationYear,
        from: { startYear: before.startYear, endYear: before.endYear },
        to: { startYear: values.startYear, endYear: values.endYear },
        noteChanged: before.note !== values.note,
      },
    })
  })
}

/** Avslutter et nåværende verv i `endYear` (standard i år). */
export async function endCohortRepresentative(
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
    await tx.update(cohortRepresentative).set({ endYear }).where(eq(cohortRepresentative.id, id))
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'cohort.rep_end',
      subjectPersonId: term.personId,
      details: {
        representativeId: id,
        graduationYear: term.graduationYear,
        startYear: term.startYear,
        endYear,
      },
    })
  })
}

/** Sletter et verv som ble lagt inn ved en feil. Avsluttede verv bør heller stå. */
export async function removeCohortRepresentative(
  db: Db,
  viewer: Viewer,
  id: string,
): Promise<void> {
  assertCan(viewer, 'members.manage')
  await db.transaction(async (tx) => {
    const term = await lockTerm(tx, id)
    await tx.delete(cohortRepresentative).where(eq(cohortRepresentative.id, id))
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'cohort.rep_remove',
      subjectPersonId: term.personId,
      details: {
        representativeId: id,
        graduationYear: term.graduationYear,
        startYear: term.startYear,
        endYear: term.endYear,
      },
    })
  })
}
