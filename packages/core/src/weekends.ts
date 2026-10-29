import { schema, type Db, type MembershipStatus, type WeekendAttendanceSource } from '@esaf/db'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { assertCan, assertMember, can, type Viewer } from './access.ts'
import { DomainError, NotFoundError } from './errors.ts'
import { emailKey, type Tx } from './members.ts'
import { normalizePersonName } from './people-admin.ts'
import { photoUrls, type ProfilePhoto } from './photos.ts'
import { optionalText } from './validation.ts'

const {
  auditEvent,
  cohort,
  esafWeekend,
  esafWeekendAttendance,
  membership,
  person,
  personCohort,
  personEmail,
} = schema

/**
 * ESAF-helgen: helgene og hvem som var der. Reglene:
 *
 * - Alle aktive medlemmer ser helgene, hvem som var der og tallene. Bare aktive
 *   medlemmer vises og telles; admins ser også de andre, merket.
 * - «Jeg var der»: et medlem legger til eller fjerner seg selv, med en gang,
 *   siden det gjelder dem selv. Det logges ikke, som «Jeg var med her».
 * - Oppmøte kan bare registreres når helgen har startet.
 * - Admins med `profiles.edit` (sterkt innlogget) oppretter, retter og sletter
 *   helger og legger til og fjerner deltakere, én og én, et helt kull eller fra
 *   en innlimt liste med navn og e-post. Alt logges (`weekend.*`).
 */

/** Dagen i dag i norsk tid, som `YYYY-MM-DD`. */
export function osloToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Oslo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/**
 * Kullet en person vises under: det laveste kullet personen gikk i som student,
 * ellers det laveste kullet uansett tilknytning. Null for personer uten kull.
 */
export function primaryCohort(
  cohorts: { graduationYear: number; relation: schema.CohortRelation }[],
): number | null {
  const students = cohorts.filter((c) => c.relation === 'student').map((c) => c.graduationYear)
  const all = students.length ? students : cohorts.map((c) => c.graduationYear)
  return all.length ? Math.min(...all) : null
}

async function cohortsOf(db: Db | Tx, personIds: string[]) {
  const byPerson = new Map<string, { graduationYear: number; relation: schema.CohortRelation }[]>()
  if (!personIds.length) return byPerson
  const rows = await db
    .select({
      personId: personCohort.personId,
      graduationYear: cohort.graduationYear,
      relation: personCohort.relation,
    })
    .from(personCohort)
    .innerJoin(cohort, eq(cohort.id, personCohort.cohortId))
    .where(inArray(personCohort.personId, [...new Set(personIds)]))
  for (const { personId, ...c } of rows)
    byPerson.set(personId, [...(byPerson.get(personId) ?? []), c])
  return byPerson
}

// ---------------------------------------------------------------------------
// For medlemmer
// ---------------------------------------------------------------------------

export type WeekendSummary = {
  id: string
  name: string
  startDate: string
  endDate: string | null
  location: string | null
  /** Aktive medlemmer som var der. */
  attendees: number
  /** Den innloggede var der. */
  attended: boolean
  /** Helgen har ikke startet ennå. */
  upcoming: boolean
}

export type WeekendCohortStat = {
  graduationYear: number
  /** Hvor mange fra kullet som har vært på minst én helg. */
  people: number
  /** Hvor mange ganger folk fra kullet har vært der til sammen. */
  attendances: number
}

export type WeekendOverview = {
  /** Nyeste først. */
  weekends: WeekendSummary[]
  /** Kull med minst én deltaker, nyeste først. */
  cohorts: WeekendCohortStat[]
  /** Ulike personer som har vært på minst én helg. */
  people: number
  /** Oppmøter til sammen. */
  attendances: number
  canManage: boolean
}

/** Alle helgene med tall, til oversikten. Bare aktive medlemmer telles. */
export async function listWeekends(db: Db, viewer: Viewer): Promise<WeekendOverview> {
  assertMember(viewer)
  const [weekends, rows] = await Promise.all([
    db.select().from(esafWeekend).orderBy(desc(esafWeekend.startDate), desc(esafWeekend.createdAt)),
    db
      .select({
        weekendId: esafWeekendAttendance.weekendId,
        personId: esafWeekendAttendance.personId,
      })
      .from(esafWeekendAttendance)
      .innerJoin(
        membership,
        and(
          eq(membership.personId, esafWeekendAttendance.personId),
          eq(membership.status, 'active'),
        ),
      ),
  ])
  const today = osloToday()
  const counts = new Map<string, number>()
  const mine = new Set<string>()
  const timesByPerson = new Map<string, number>()
  for (const r of rows) {
    counts.set(r.weekendId, (counts.get(r.weekendId) ?? 0) + 1)
    timesByPerson.set(r.personId, (timesByPerson.get(r.personId) ?? 0) + 1)
    if (r.personId === viewer.personId) mine.add(r.weekendId)
  }
  const cohorts = await cohortsOf(db, [...timesByPerson.keys()])
  const stats = new Map<number, WeekendCohortStat>()
  for (const [personId, times] of timesByPerson) {
    const year = primaryCohort(cohorts.get(personId) ?? [])
    if (year === null) continue
    const stat = stats.get(year) ?? { graduationYear: year, people: 0, attendances: 0 }
    stat.people++
    stat.attendances += times
    stats.set(year, stat)
  }
  return {
    weekends: weekends.map((w) => ({
      id: w.id,
      name: w.name,
      startDate: w.startDate,
      endDate: w.endDate,
      location: w.location,
      attendees: counts.get(w.id) ?? 0,
      attended: mine.has(w.id),
      upcoming: w.startDate > today,
    })),
    cohorts: [...stats.values()].sort((a, b) => b.graduationYear - a.graduationYear),
    people: timesByPerson.size,
    attendances: rows.length,
    canManage: can(viewer, 'profiles.edit'),
  }
}

export type WeekendAttendee = {
  personId: string
  fullName: string
  photo: ProfilePhoto | null
  claimed: boolean
  /** Bare admins ser deltakere som ikke er aktive medlemmer. */
  status: MembershipStatus | null
  /** Hvordan oppmøtet ble registrert. Bare for admins. */
  source: WeekendAttendanceSource | null
}

export type WeekendDetails = {
  id: string
  name: string
  startDate: string
  endDate: string | null
  location: string | null
  description: string | null
  upcoming: boolean
  /** Deltakere som vises (aktive medlemmer, og for admins alle). */
  attendees: number
  attended: boolean
  /** Etter kull, nyeste kull først. `graduationYear` er null for dem uten kull. */
  groups: { graduationYear: number | null; people: WeekendAttendee[] }[]
  canManage: boolean
}

/** Én helg med deltakerne gruppert etter kull. */
export async function getWeekend(
  db: Db,
  viewer: Viewer,
  weekendId: string,
): Promise<WeekendDetails> {
  assertMember(viewer)
  const [weekend] = await db.select().from(esafWeekend).where(eq(esafWeekend.id, weekendId))
  if (!weekend) throw new NotFoundError('Fant ikke helgen.')
  const canManage = can(viewer, 'profiles.edit')
  const rows = await db
    .select({
      personId: person.id,
      fullName: person.fullName,
      photoKey: person.photoKey,
      userId: person.userId,
      status: membership.status,
      source: esafWeekendAttendance.source,
    })
    .from(esafWeekendAttendance)
    .innerJoin(person, eq(person.id, esafWeekendAttendance.personId))
    .leftJoin(membership, eq(membership.personId, person.id))
    .where(eq(esafWeekendAttendance.weekendId, weekendId))
    .orderBy(asc(person.fullName))
  const visible = rows.filter((r) => canManage || r.status === 'active')
  const cohorts = await cohortsOf(
    db,
    visible.map((r) => r.personId),
  )
  const groups = new Map<number | null, WeekendAttendee[]>()
  for (const r of visible) {
    const year = primaryCohort(cohorts.get(r.personId) ?? [])
    groups.set(year, [
      ...(groups.get(year) ?? []),
      {
        personId: r.personId,
        fullName: r.fullName,
        photo: photoUrls(r.photoKey),
        claimed: r.userId !== null,
        status: canManage ? r.status : null,
        source: canManage ? r.source : null,
      },
    ])
  }
  return {
    id: weekend.id,
    name: weekend.name,
    startDate: weekend.startDate,
    endDate: weekend.endDate,
    location: weekend.location,
    description: weekend.description,
    upcoming: weekend.startDate > osloToday(),
    attendees: visible.length,
    attended: rows.some((r) => r.personId === viewer.personId),
    groups: [...groups.entries()]
      .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : b - a))
      .map(([graduationYear, people]) => ({ graduationYear, people })),
    canManage,
  }
}

/** Helgene en person har vært på, nyeste først, til profilen. */
export async function loadPersonWeekends(db: Db, personId: string) {
  return db
    .select({ id: esafWeekend.id, name: esafWeekend.name, startDate: esafWeekend.startDate })
    .from(esafWeekendAttendance)
    .innerJoin(esafWeekend, eq(esafWeekend.id, esafWeekendAttendance.weekendId))
    .where(eq(esafWeekendAttendance.personId, personId))
    .orderBy(desc(esafWeekend.startDate))
}

async function lockWeekend(tx: Tx, weekendId: string) {
  const [row] = await tx
    .select()
    .from(esafWeekend)
    .where(eq(esafWeekend.id, weekendId))
    .for('update')
  if (!row) throw new NotFoundError('Fant ikke helgen.')
  return row
}

function assertStarted(weekend: { startDate: string }) {
  if (weekend.startDate > osloToday()) {
    throw new DomainError('Helgen har ikke startet ennå. Oppmøte registreres når den har startet.')
  }
}

/** «Jeg var der»: den innloggede legger til eller fjerner seg selv. Gjelder med en gang. */
export async function setOwnAttendance(
  db: Db,
  viewer: Viewer,
  weekendId: string,
  attended: boolean,
): Promise<void> {
  assertMember(viewer)
  await db.transaction(async (tx) => {
    const weekend = await lockWeekend(tx, weekendId)
    if (attended) {
      assertStarted(weekend)
      await tx
        .insert(esafWeekendAttendance)
        .values({ weekendId, personId: viewer.personId, source: 'self' })
        .onConflictDoNothing()
    } else {
      await tx
        .delete(esafWeekendAttendance)
        .where(
          and(
            eq(esafWeekendAttendance.weekendId, weekendId),
            eq(esafWeekendAttendance.personId, viewer.personId),
          ),
        )
    }
  })
}

// ---------------------------------------------------------------------------
// For admins
// ---------------------------------------------------------------------------

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Ugyldig dato.')
  .refine((d) => {
    const parsed = new Date(`${d}T00:00:00Z`)
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === d
  }, 'Ugyldig dato.')
  .refine((d) => d >= '1990-01-01' && d <= '2100-12-31', 'Ugyldig dato.')

export const weekendInput = z
  .object({
    name: z.string().trim().min(3, 'Navnet må ha minst 3 tegn.').max(120, 'Maks 120 tegn.'),
    startDate: isoDate,
    endDate: z
      .union([isoDate, z.literal('')])
      .nullable()
      .transform((d) => d || null),
    location: optionalText(120),
    description: optionalText(2000),
  })
  .refine((w) => w.endDate === null || w.endDate >= w.startDate, {
    message: 'Sluttdatoen kan ikke være før startdatoen.',
  })
  .refine(
    (w) =>
      w.endDate === null ||
      new Date(`${w.endDate}T00:00:00Z`).getTime() -
        new Date(`${w.startDate}T00:00:00Z`).getTime() <=
        14 * 864e5,
    { message: 'En helg kan vare høyst to uker.' },
  )

export type WeekendInput = z.input<typeof weekendInput>

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new DomainError(parsed.error.issues[0]?.message ?? 'Ugyldige felt.')
  return parsed.data
}

/** Det som kan rettes, med verdiene nå. */
export async function getEditableWeekend(db: Db, viewer: Viewer, weekendId: string) {
  assertCan(viewer, 'profiles.edit')
  const [row] = await db.select().from(esafWeekend).where(eq(esafWeekend.id, weekendId))
  if (!row) throw new NotFoundError('Fant ikke helgen.')
  return {
    id: row.id,
    name: row.name,
    startDate: row.startDate,
    endDate: row.endDate,
    location: row.location,
    description: row.description,
  }
}

export async function createWeekend(
  db: Db,
  viewer: Viewer,
  input: WeekendInput,
): Promise<{ id: string }> {
  assertCan(viewer, 'profiles.edit')
  const values = parse(weekendInput, input)
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(esafWeekend).values(values).returning({ id: esafWeekend.id })
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'weekend.create',
      details: { weekendId: row!.id, name: values.name, startDate: values.startDate },
    })
    return row!
  })
}

export async function updateWeekend(
  db: Db,
  viewer: Viewer,
  weekendId: string,
  input: WeekendInput,
): Promise<void> {
  assertCan(viewer, 'profiles.edit')
  const values = parse(weekendInput, input)
  await db.transaction(async (tx) => {
    const before = await lockWeekend(tx, weekendId)
    const fields = (Object.keys(values) as (keyof typeof values)[]).filter(
      (key) => values[key] !== before[key],
    )
    if (!fields.length) return
    await tx.update(esafWeekend).set(values).where(eq(esafWeekend.id, weekendId))
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'weekend.edit',
      details: { weekendId, name: values.name, previousName: before.name, fields },
    })
  })
}

/** Sletter helgen og oppmøtet. Logges med navnet og hvor mange som var der. */
export async function deleteWeekend(db: Db, viewer: Viewer, weekendId: string): Promise<void> {
  assertCan(viewer, 'profiles.edit')
  await db.transaction(async (tx) => {
    const weekend = await lockWeekend(tx, weekendId)
    const attendees = await tx.$count(
      esafWeekendAttendance,
      eq(esafWeekendAttendance.weekendId, weekendId),
    )
    await tx.delete(esafWeekend).where(eq(esafWeekend.id, weekendId))
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'weekend.delete',
      details: { weekendId, name: weekend.name, startDate: weekend.startDate, attendees },
    })
  })
}

const MAX_BULK = 500

/**
 * Legger til deltakere. `import` er for lister som er limt inn, `admin` for
 * deltakere lagt til én og én. De som allerede er registrert, beholdes som de
 * er. Gir hvor mange som ble lagt til.
 */
export async function addWeekendAttendees(
  db: Db,
  viewer: Viewer,
  weekendId: string,
  input: { personIds: string[]; source: 'admin' | 'import' },
): Promise<{ added: number }> {
  assertCan(viewer, 'profiles.edit')
  const ids = parse(z.array(z.uuid()).min(1, 'Velg minst én person.').max(MAX_BULK), [
    ...new Set(input.personIds),
  ])
  const source = parse(z.enum(['admin', 'import']), input.source)
  return db.transaction(async (tx) => {
    const weekend = await lockWeekend(tx, weekendId)
    assertStarted(weekend)
    const found = await tx.select({ id: person.id }).from(person).where(inArray(person.id, ids))
    if (found.length !== ids.length) throw new NotFoundError('Fant ikke alle personene.')
    const added = await tx
      .insert(esafWeekendAttendance)
      .values(ids.map((personId) => ({ weekendId, personId, source })))
      .onConflictDoNothing()
      .returning({ personId: esafWeekendAttendance.personId })
    if (added.length) {
      await tx.insert(auditEvent).values({
        actorPersonId: viewer.personId,
        action: 'weekend.attendance_add',
        subjectPersonId: added.length === 1 ? added[0]!.personId : null,
        details: {
          weekendId,
          name: weekend.name,
          source,
          added: added.length,
          personIds: added.map((a) => a.personId),
        },
      })
    }
    return { added: added.length }
  })
}

/** «Legg til hele kullet»: alle aktive medlemmer som gikk i kullet som studenter. */
export async function addWeekendCohort(
  db: Db,
  viewer: Viewer,
  weekendId: string,
  graduationYear: number,
): Promise<{ added: number }> {
  assertCan(viewer, 'profiles.edit')
  return db.transaction(async (tx) => {
    const weekend = await lockWeekend(tx, weekendId)
    assertStarted(weekend)
    const students = await tx
      .select({ personId: personCohort.personId })
      .from(personCohort)
      .innerJoin(cohort, eq(cohort.id, personCohort.cohortId))
      .innerJoin(
        membership,
        and(eq(membership.personId, personCohort.personId), eq(membership.status, 'active')),
      )
      .where(and(eq(cohort.graduationYear, graduationYear), eq(personCohort.relation, 'student')))
    if (!students.length) throw new DomainError(`Ingen aktive medlemmer i ES ${graduationYear}.`)
    const added = await tx
      .insert(esafWeekendAttendance)
      .values(students.map(({ personId }) => ({ weekendId, personId, source: 'admin' as const })))
      .onConflictDoNothing()
      .returning({ personId: esafWeekendAttendance.personId })
    if (added.length) {
      await tx.insert(auditEvent).values({
        actorPersonId: viewer.personId,
        action: 'weekend.attendance_add',
        details: {
          weekendId,
          name: weekend.name,
          source: 'admin',
          cohort: graduationYear,
          added: added.length,
          personIds: added.map((a) => a.personId),
        },
      })
    }
    return { added: added.length }
  })
}

export async function removeWeekendAttendee(
  db: Db,
  viewer: Viewer,
  weekendId: string,
  personId: string,
): Promise<void> {
  assertCan(viewer, 'profiles.edit')
  await db.transaction(async (tx) => {
    const weekend = await lockWeekend(tx, weekendId)
    const removed = await tx
      .delete(esafWeekendAttendance)
      .where(
        and(
          eq(esafWeekendAttendance.weekendId, weekendId),
          eq(esafWeekendAttendance.personId, personId),
        ),
      )
      .returning({ source: esafWeekendAttendance.source })
    if (!removed.length) throw new NotFoundError('Personen er ikke registrert på helgen.')
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'weekend.attendance_remove',
      subjectPersonId: personId,
      details: { weekendId, name: weekend.name, source: removed[0]!.source },
    })
  })
}

// ---------------------------------------------------------------------------
// Innlimt liste: navn og e-post matches mot personene ESAF kjenner
// ---------------------------------------------------------------------------

/** En person slik listen matches mot. */
export type MatchPerson = {
  personId: string
  fullName: string
  /** Kjente adresser og kontaktadressen. */
  emails: string[]
  cohortYears: number[]
  claimed: boolean
  status: MembershipStatus | null
}

export type MatchCandidate = Omit<MatchPerson, 'emails'> & {
  /** Allerede registrert på helgen. */
  attending: boolean
}

export type MatchLine = {
  /** Linjen slik den ble limt inn. */
  line: string
  /**
   * `matched`: én person, på e-post eller fullt navn. `ambiguous`: flere med samme
   * e-post eller navn. `suggested`: bare samme fornavn og etternavn, så admin må
   * bekrefte. `unmatched`: ingen. `duplicate`: samme person som en linje over.
   */
  status: 'matched' | 'ambiguous' | 'suggested' | 'unmatched' | 'duplicate'
  by: 'email' | 'name' | 'firstLast' | null
  candidates: MatchCandidate[]
}

const EMAIL = /[^\s<>(),;:"'[\]]+@[^\s<>(),;:"'[\]]+\.[a-z]{2,}/gi
const YEAR = /\b(?:19|20)\d{2}\b/g

/** Linjene i en innlimt liste: én person per linje (eller adskilt med semikolon). */
export function attendeeLines(text: string) {
  return text
    .split(/\r?\n|;/)
    .map((l) => l.replace(/^\s*(?:[-*•·]|\d+[.)])\s+/, '').trim())
    .filter(Boolean)
}

/** Navnet, e-postadressene og et eventuelt kull fra én linje. */
export function parseAttendeeLine(line: string) {
  const emails = (line.match(EMAIL) ?? []).map((e) => e.toLowerCase())
  const years = (line.replace(EMAIL, ' ').match(YEAR) ?? []).map(Number)
  const rest = line
    .replace(EMAIL, ' ')
    .replace(YEAR, ' ')
    .replace(/\bES\b|\bkull\b/gi, ' ')
    .replace(/[<>()"'[\]\t]/g, ' ')
  const parts = rest
    .split(',')
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  // «Nordmann, Kari» blir «Kari Nordmann». Ellers er navnet det første feltet.
  const name =
    parts.length === 2 && parts[0]!.split(' ').length === 1 && parts[1]!.split(' ').length <= 2
      ? `${parts[1]} ${parts[0]}`
      : (parts[0] ?? '')
  return { name, emails, year: years[0] ?? null }
}

const firstLast = (name: string) => {
  const parts = name.split(' ')
  return parts.length > 2 ? `${parts[0]} ${parts.at(-1)}` : name
}

/**
 * Matcher linjene mot personene. E-post går foran navn; Gmail-varianter regnes
 * som samme adresse. Navn sammenlignes uten store bokstaver, aksenter og tegn
 * (`normalizePersonName`), og et kull på linjen («Kari Nordmann 2024») skiller
 * mellom personer med samme navn. Samme fornavn og etternavn med ulike
 * mellomnavn blir bare et forslag.
 */
export function matchAttendeeLines(
  text: string,
  people: MatchPerson[],
  attending: ReadonlySet<string> = new Set(),
): MatchLine[] {
  const lines = attendeeLines(text)
  if (lines.length > MAX_BULK) throw new DomainError(`Maks ${MAX_BULK} linjer om gangen.`)
  const byEmail = new Map<string, MatchPerson[]>()
  const byName = new Map<string, MatchPerson[]>()
  const byFirstLast = new Map<string, MatchPerson[]>()
  const push = (map: Map<string, MatchPerson[]>, key: string, p: MatchPerson) => {
    const list = map.get(key) ?? []
    if (!list.includes(p)) list.push(p)
    map.set(key, list)
  }
  for (const p of people) {
    for (const e of p.emails) push(byEmail, emailKey(e), p)
    const name = normalizePersonName(p.fullName)
    if (name) {
      push(byName, name, p)
      push(byFirstLast, firstLast(name), p)
    }
  }
  const candidate = (p: MatchPerson): MatchCandidate => ({
    personId: p.personId,
    fullName: p.fullName,
    cohortYears: p.cohortYears,
    claimed: p.claimed,
    status: p.status,
    attending: attending.has(p.personId),
  })
  const sort = (list: MatchPerson[]) =>
    [...list].sort(
      (a, b) =>
        Number(b.status === 'active') - Number(a.status === 'active') ||
        a.fullName.localeCompare(b.fullName, 'nb'),
    )

  const seen = new Set<string>()
  return lines.map((line): MatchLine => {
    const parsed = parseAttendeeLine(line)
    const inYear = (list: MatchPerson[]) => {
      if (parsed.year === null || list.length < 2) return list
      const hit = list.filter((p) => p.cohortYears.includes(parsed.year!))
      return hit.length ? hit : list
    }
    let by: MatchLine['by'] = null
    let found: MatchPerson[] = []
    const emailHits = [...new Set(parsed.emails.flatMap((e) => byEmail.get(emailKey(e)) ?? []))]
    const name = normalizePersonName(parsed.name)
    if (emailHits.length) {
      by = 'email'
      found = emailHits
    } else if (name && byName.has(name)) {
      by = 'name'
      found = inYear(byName.get(name)!)
    } else if (name.includes(' ')) {
      // Begge veier: «Kari Nordmann» mot «Kari Marie Nordmann», og omvendt.
      const loose = [
        ...new Set([
          ...(byFirstLast.get(firstLast(name)) ?? []),
          ...(byName.get(firstLast(name)) ?? []),
        ]),
      ]
      if (loose.length) {
        by = 'firstLast'
        found = inYear(loose)
      }
    }
    const candidates = sort(found).map(candidate)
    let status: MatchLine['status'] =
      found.length === 0
        ? 'unmatched'
        : by === 'firstLast'
          ? 'suggested'
          : found.length > 1
            ? 'ambiguous'
            : 'matched'
    if (status === 'matched') {
      const id = found[0]!.personId
      if (seen.has(id)) status = 'duplicate'
      seen.add(id)
    }
    return { line, status, by, candidates }
  })
}

/** Matcher en innlimt liste mot alle personer ESAF kjenner, til forhåndsvisningen før lagring. */
export async function matchWeekendAttendees(
  db: Db,
  viewer: Viewer,
  weekendId: string,
  text: string,
): Promise<MatchLine[]> {
  assertCan(viewer, 'profiles.edit')
  if (text.length > 100_000) throw new DomainError('Lista er for lang.')
  const [[weekend], rows, emails, attendance] = await Promise.all([
    db.select({ id: esafWeekend.id }).from(esafWeekend).where(eq(esafWeekend.id, weekendId)),
    db
      .select({
        personId: person.id,
        fullName: person.fullName,
        userId: person.userId,
        contactEmail: person.contactEmail,
        status: membership.status,
      })
      .from(person)
      .leftJoin(membership, eq(membership.personId, person.id)),
    db.select({ personId: personEmail.personId, email: personEmail.email }).from(personEmail),
    db
      .select({ personId: esafWeekendAttendance.personId })
      .from(esafWeekendAttendance)
      .where(eq(esafWeekendAttendance.weekendId, weekendId)),
  ])
  if (!weekend) throw new NotFoundError('Fant ikke helgen.')
  const cohorts = await db
    .select({ personId: personCohort.personId, year: cohort.graduationYear })
    .from(personCohort)
    .innerJoin(cohort, eq(cohort.id, personCohort.cohortId))
    .orderBy(asc(cohort.graduationYear))
  const yearsOf = new Map<string, number[]>()
  for (const c of cohorts) yearsOf.set(c.personId, [...(yearsOf.get(c.personId) ?? []), c.year])
  const emailsOf = new Map<string, string[]>()
  for (const e of emails) emailsOf.set(e.personId, [...(emailsOf.get(e.personId) ?? []), e.email])
  const people: MatchPerson[] = rows.map((r) => ({
    personId: r.personId,
    fullName: r.fullName,
    emails: [...(emailsOf.get(r.personId) ?? []), ...(r.contactEmail ? [r.contactEmail] : [])],
    cohortYears: yearsOf.get(r.personId) ?? [],
    claimed: r.userId !== null,
    status: r.status,
  }))
  return matchAttendeeLines(text, people, new Set(attendance.map((a) => a.personId)))
}
