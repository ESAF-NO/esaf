import {
  schema,
  type Db,
  type EventDatePrecision,
  type MembershipStatus,
  type ParticipationRole,
  type ParticipationSource,
} from '@esaf/db'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { assertCan, assertMember, can, type Viewer } from './access.ts'
import {
  assetViews,
  deleteAssetsOf,
  loadAssets,
  purgeAssets,
  type AssetView,
  type PurgeTarget,
} from './assets.ts'
import { companySlug } from './companies.ts'
import { DomainError, NotFoundError } from './errors.ts'
import type { Tx } from './members.ts'
import { loadMatchPeople, matchAttendeeLines, MAX_LINES, type MatchLine } from './person-match.ts'
import { photoUrls, type ProfilePhoto } from './photos.ts'
import type { ObjectStorage } from './storage.ts'
import { optionalText } from './validation.ts'

const {
  auditEvent,
  cohort,
  event,
  eventParticipation,
  eventType,
  membership,
  person,
  personCohort,
} = schema

/**
 * Arrangementer og hvem som var der. ESAF-helgen er den første typen; admins
 * kan legge til flere («Generalforsamling», «Fagkveld»). Reglene:
 *
 * - Alle aktive medlemmer ser typene, arrangementene, hvem som var der og
 *   tallene. Bare aktive medlemmer vises og telles; admins ser også de andre,
 *   merket.
 * - Alle med en rad var med. Rollen er valgfri: arrangør, foredragsholder eller
 *   frivillig. Uten rolle var personen deltaker. `attended` lagres aldri; det
 *   betyr det samme som ingen rolle.
 * - «Jeg var der»: et medlem legger til eller fjerner seg selv, med en gang,
 *   siden det gjelder dem selv. Det logges ikke, som «Jeg var med her».
 * - Deltakelse kan bare registreres når arrangementet har startet.
 * - Admins med `profiles.edit` (sterkt innlogget) lager, retter og sletter typer
 *   og arrangementer, og legger til, retter og fjerner deltakere: én og én, et
 *   helt kull, en innlimt liste eller et regneark (`event-import.ts`). Alt
 *   logges (`event_type.*`, `event.*`).
 */

/** Rollene utover å delta. Null betyr deltaker. */
export const eventRoles = ['organizer', 'speaker', 'volunteer'] as const
export type EventRole = (typeof eventRoles)[number]

/** `attended` og null betyr det samme: deltok, uten særskilt rolle. */
export const normalizeRole = (role: ParticipationRole | null | undefined): EventRole | null =>
  role && role !== 'attended' ? role : null

/** Hvor mye en rolle sier. Brukes når samme person står flere ganger med ulik rolle. */
export const rolePriority = (role: EventRole | null) =>
  role === 'organizer' ? 3 : role === 'speaker' ? 2 : role === 'volunteer' ? 1 : 0

export type RoleCounts = Record<EventRole, number>
const noRoles = (): RoleCounts => ({ organizer: 0, speaker: 0, volunteer: 0 })

/** Dagen i dag i norsk tid, som `YYYY-MM-DD`. */
export function osloToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Oslo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/** Hvor godt datoen er kjent: dag, semester («Høst 2018») eller bare år («2015»). */
export const eventDatePrecisions = [
  'day',
  'semester',
  'year',
] as const satisfies readonly EventDatePrecision[]

/** En periode uten kjent dato: hele året, våren eller høsten. */
export type EventPeriod = 'year' | 'spring' | 'autumn'

const seasonWords = { spring: 'vår', autumn: 'høst' } as const

/**
 * Startdatoen et arrangement med bare år eller semester lagres med: 1. januar
 * for året og våren, 1. juli for høsten. Sorteringen og «har startet» bruker den.
 */
export const periodStart = (year: number, period: EventPeriod) =>
  `${String(year).padStart(4, '0')}-${period === 'autumn' ? '07' : '01'}-01`

/** Semesteret en dato hører til: januar–juni er vår, juli–desember høst. */
export const seasonOf = (date: string): 'spring' | 'autumn' =>
  Number(date.slice(5, 7)) <= 6 ? 'spring' : 'autumn'

/** Navnet et arrangement får fra typen og perioden: «ESAF-helgen høst 2018», «ESAF-helgen 2015». */
export const periodEventName = (typeName: string, year: number, period: EventPeriod) =>
  [typeName, period === 'year' ? null : seasonWords[period], year].filter(Boolean).join(' ')

/** Perioden et arrangement dekker, ut fra datoen og hvor godt den er kjent. */
export const eventPeriod = (e: { startDate: string; datePrecision: EventDatePrecision }) => ({
  year: Number(e.startDate.slice(0, 4)),
  season: e.datePrecision === 'year' ? null : seasonOf(e.startDate),
})

/** Samme navn, uten forskjell på store og små bokstaver eller ekstra mellomrom. */
export const sameEventName = (a: string, b: string) =>
  a.trim().replace(/\s+/g, ' ').toLocaleLowerCase('nb') ===
  b.trim().replace(/\s+/g, ' ').toLocaleLowerCase('nb')

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

/** Deltakelse fra aktive medlemmer, eventuelt bare for noen arrangementer. */
function activeParticipation(db: Db, eventIds?: string[]) {
  return db
    .select({
      eventId: eventParticipation.eventId,
      personId: eventParticipation.personId,
      role: eventParticipation.role,
    })
    .from(eventParticipation)
    .innerJoin(
      membership,
      and(eq(membership.personId, eventParticipation.personId), eq(membership.status, 'active')),
    )
    .where(eventIds ? inArray(eventParticipation.eventId, eventIds) : undefined)
}

// ---------------------------------------------------------------------------
// For medlemmer
// ---------------------------------------------------------------------------

export type EventTypeInfo = {
  id: string
  slug: string
  name: string
  plural: string | null
  description: string | null
  sortOrder: number
}

const typeColumns = {
  id: eventType.id,
  slug: eventType.slug,
  name: eventType.name,
  plural: eventType.plural,
  description: eventType.description,
  sortOrder: eventType.sortOrder,
}

export type EventTypeSummary = EventTypeInfo & {
  events: number
  upcoming: number
  /** Ulike aktive medlemmer som har vært på minst ett. */
  people: number
  participations: number
  /** Det siste som har startet. */
  latest: {
    id: string
    name: string
    startDate: string
    datePrecision: EventDatePrecision
  } | null
}

/** Alle typene med tall, ESAF-helgen først. */
export async function listEventTypes(
  db: Db,
  viewer: Viewer,
): Promise<{ types: EventTypeSummary[]; canManage: boolean }> {
  assertMember(viewer)
  const [types, events, rows] = await Promise.all([
    db.select(typeColumns).from(eventType).orderBy(asc(eventType.sortOrder), asc(eventType.name)),
    db
      .select({
        id: event.id,
        typeId: event.typeId,
        name: event.name,
        startDate: event.startDate,
        datePrecision: event.datePrecision,
      })
      .from(event)
      .orderBy(desc(event.startDate), desc(event.createdAt)),
    activeParticipation(db),
  ])
  const today = osloToday()
  const typeOf = new Map(events.map((e) => [e.id, e.typeId]))
  const people = new Map<string, Set<string>>()
  const participations = new Map<string, number>()
  for (const r of rows) {
    const typeId = typeOf.get(r.eventId)!
    people.set(typeId, (people.get(typeId) ?? new Set()).add(r.personId))
    participations.set(typeId, (participations.get(typeId) ?? 0) + 1)
  }
  return {
    types: types.map((t) => {
      const own = events.filter((e) => e.typeId === t.id)
      const latest = own.find((e) => e.startDate <= today)
      return {
        ...t,
        events: own.length,
        upcoming: own.filter((e) => e.startDate > today).length,
        people: people.get(t.id)?.size ?? 0,
        participations: participations.get(t.id) ?? 0,
        latest: latest
          ? {
              id: latest.id,
              name: latest.name,
              startDate: latest.startDate,
              datePrecision: latest.datePrecision,
            }
          : null,
      }
    }),
    canManage: can(viewer, 'profiles.edit'),
  }
}

export type EventSummary = {
  id: string
  name: string
  startDate: string
  endDate: string | null
  datePrecision: EventDatePrecision
  location: string | null
  /** Aktive medlemmer som var der. */
  participants: number
  /** Hvor mange av dem som hadde hver rolle. */
  roles: RoleCounts
  /** Den innloggede var der. */
  participated: boolean
  myRole: EventRole | null
  /** Har ikke startet ennå. */
  upcoming: boolean
}

export type EventCohortStat = {
  graduationYear: number
  /** Hvor mange fra kullet som har vært på minst ett. */
  people: number
  /** Hvor mange ganger folk fra kullet har vært der til sammen. */
  participations: number
}

export type EventTypeOverview = {
  type: EventTypeInfo
  /** Nyeste først. */
  events: EventSummary[]
  /** Kull med minst én deltaker, nyeste først. */
  cohorts: EventCohortStat[]
  /** Ulike personer som har vært på minst ett. */
  people: number
  participations: number
  /** Hvor mange ganger folk har hatt hver rolle. */
  roles: RoleCounts
  canManage: boolean
}

async function typeBySlug(db: Db, slug: string) {
  const [type] = await db.select(typeColumns).from(eventType).where(eq(eventType.slug, slug))
  if (!type) throw new NotFoundError('Fant ikke arrangementstypen.')
  return type
}

/** Én type med arrangementene og tallene, til oversikten. Bare aktive medlemmer telles. */
export async function getEventTypeOverview(
  db: Db,
  viewer: Viewer,
  slug: string,
): Promise<EventTypeOverview> {
  assertMember(viewer)
  const type = await typeBySlug(db, slug)
  const events = await db
    .select()
    .from(event)
    .where(eq(event.typeId, type.id))
    .orderBy(desc(event.startDate), desc(event.createdAt))
  const rows = events.length
    ? await activeParticipation(
        db,
        events.map((e) => e.id),
      )
    : []
  const today = osloToday()
  const counts = new Map<string, number>()
  const roles = new Map<string, RoleCounts>()
  const mine = new Map<string, EventRole | null>()
  const timesByPerson = new Map<string, number>()
  const total = noRoles()
  for (const r of rows) {
    const role = normalizeRole(r.role)
    counts.set(r.eventId, (counts.get(r.eventId) ?? 0) + 1)
    timesByPerson.set(r.personId, (timesByPerson.get(r.personId) ?? 0) + 1)
    if (role) {
      const c = roles.get(r.eventId) ?? noRoles()
      c[role]++
      roles.set(r.eventId, c)
      total[role]++
    }
    if (r.personId === viewer.personId) mine.set(r.eventId, role)
  }
  const cohorts = await cohortsOf(db, [...timesByPerson.keys()])
  const stats = new Map<number, EventCohortStat>()
  for (const [personId, times] of timesByPerson) {
    const year = primaryCohort(cohorts.get(personId) ?? [])
    if (year === null) continue
    const stat = stats.get(year) ?? { graduationYear: year, people: 0, participations: 0 }
    stat.people++
    stat.participations += times
    stats.set(year, stat)
  }
  return {
    type,
    events: events.map((e) => ({
      id: e.id,
      name: e.name,
      startDate: e.startDate,
      endDate: e.endDate,
      datePrecision: e.datePrecision,
      location: e.location,
      participants: counts.get(e.id) ?? 0,
      roles: roles.get(e.id) ?? noRoles(),
      participated: mine.has(e.id),
      myRole: mine.get(e.id) ?? null,
      upcoming: e.startDate > today,
    })),
    cohorts: [...stats.values()].sort((a, b) => b.graduationYear - a.graduationYear),
    people: timesByPerson.size,
    participations: rows.length,
    roles: total,
    canManage: can(viewer, 'profiles.edit'),
  }
}

export type EventParticipant = {
  personId: string
  fullName: string
  photo: ProfilePhoto | null
  claimed: boolean
  role: EventRole | null
  /** Bare admins ser deltakere som ikke er aktive medlemmer. */
  status: MembershipStatus | null
  /** Hvordan deltakelsen ble registrert. Bare for admins. */
  source: ParticipationSource | null
  /** Notat fra styret. Bare for admins. */
  note: string | null
}

export type EventDetails = {
  id: string
  name: string
  startDate: string
  endDate: string | null
  datePrecision: EventDatePrecision
  location: string | null
  description: string | null
  type: Pick<EventTypeInfo, 'id' | 'slug' | 'name' | 'plural'>
  upcoming: boolean
  /** Deltakere som vises (aktive medlemmer, og for admins alle). */
  participants: number
  roles: RoleCounts
  participated: boolean
  myRole: EventRole | null
  /** Etter kull, nyeste kull først. `graduationYear` er null for dem uten kull. */
  groups: { graduationYear: number | null; people: EventParticipant[] }[]
  canManage: boolean
  /** «Bilder»: albumet, eldste først. */
  photos: AssetView[]
  /** «Dokumenter»: program, referat og lignende. */
  documents: AssetView[]
  /** De som var der, og admins, når arrangementet har startet. */
  canUploadPhotos: boolean
  /** Arrangørene og admins. */
  canUploadDocuments: boolean
}

/** Ett arrangement med deltakerne gruppert etter kull, arrangører og andre roller først. */
export async function getEvent(db: Db, viewer: Viewer, eventId: string): Promise<EventDetails> {
  assertMember(viewer)
  const [row] = await db
    .select({
      event,
      type: {
        id: eventType.id,
        slug: eventType.slug,
        name: eventType.name,
        plural: eventType.plural,
      },
    })
    .from(event)
    .innerJoin(eventType, eq(eventType.id, event.typeId))
    .where(eq(event.id, eventId))
  if (!row) throw new NotFoundError('Fant ikke arrangementet.')
  const canManage = can(viewer, 'profiles.edit')
  const rows = await db
    .select({
      personId: person.id,
      fullName: person.fullName,
      photoKey: person.photoKey,
      userId: person.userId,
      status: membership.status,
      role: eventParticipation.role,
      source: eventParticipation.source,
      note: eventParticipation.note,
    })
    .from(eventParticipation)
    .innerJoin(person, eq(person.id, eventParticipation.personId))
    .leftJoin(membership, eq(membership.personId, person.id))
    .where(eq(eventParticipation.eventId, eventId))
    .orderBy(asc(person.fullName))
  const visible = rows.filter((r) => canManage || r.status === 'active')
  const cohorts = await cohortsOf(
    db,
    visible.map((r) => r.personId),
  )
  const groups = new Map<number | null, EventParticipant[]>()
  const roles = noRoles()
  for (const r of visible) {
    const role = normalizeRole(r.role)
    if (role) roles[role]++
    const year = primaryCohort(cohorts.get(r.personId) ?? [])
    groups.set(year, [
      ...(groups.get(year) ?? []),
      {
        personId: r.personId,
        fullName: r.fullName,
        photo: photoUrls(r.photoKey),
        claimed: r.userId !== null,
        role,
        status: canManage ? r.status : null,
        source: canManage ? r.source : null,
        note: canManage ? r.note : null,
      },
    ])
  }
  const own = rows.find((r) => r.personId === viewer.personId)
  const e = row.event
  const moderator = can(viewer, 'content.moderate')
  const organizer = normalizeRole(own?.role) === 'organizer'
  const files = await loadAssets(
    db,
    viewer,
    { eventId: e.id },
    (a) => moderator || (a.purpose === 'event_document' && (organizer || canManage)),
  )
  const upcoming = e.startDate > osloToday()
  return {
    id: e.id,
    name: e.name,
    startDate: e.startDate,
    endDate: e.endDate,
    datePrecision: e.datePrecision,
    location: e.location,
    description: e.description,
    type: row.type,
    upcoming,
    participants: visible.length,
    roles,
    participated: Boolean(own),
    myRole: normalizeRole(own?.role),
    groups: [...groups.entries()]
      .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : b - a))
      .map(([graduationYear, people]) => ({
        graduationYear,
        people: people.sort(
          (a, b) =>
            rolePriority(b.role) - rolePriority(a.role) ||
            a.fullName.localeCompare(b.fullName, 'nb'),
        ),
      })),
    canManage,
    photos: assetViews(files.filter((f) => f.purpose === 'event_photo')),
    documents: assetViews(files.filter((f) => f.purpose === 'event_document')),
    canUploadPhotos: !upcoming && (Boolean(own) || canManage),
    canUploadDocuments: organizer || canManage,
  }
}

export type PersonEventGroup = {
  type: { slug: string; name: string }
  /** Hvor mange arrangementer av typen personen har vært på. */
  total: number
  roles: RoleCounts
  /** Nyeste først. */
  events: {
    id: string
    name: string
    startDate: string
    datePrecision: EventDatePrecision
    role: EventRole | null
  }[]
}

/** Arrangementene en person har vært på, per type, til profilen. */
export async function loadPersonEvents(db: Db, personId: string): Promise<PersonEventGroup[]> {
  const rows = await db
    .select({
      id: event.id,
      name: event.name,
      startDate: event.startDate,
      datePrecision: event.datePrecision,
      role: eventParticipation.role,
      typeId: eventType.id,
      slug: eventType.slug,
      typeName: eventType.name,
    })
    .from(eventParticipation)
    .innerJoin(event, eq(event.id, eventParticipation.eventId))
    .innerJoin(eventType, eq(eventType.id, event.typeId))
    .where(eq(eventParticipation.personId, personId))
    .orderBy(asc(eventType.sortOrder), asc(eventType.name), desc(event.startDate))
  const groups = new Map<string, PersonEventGroup>()
  for (const r of rows) {
    const group = groups.get(r.typeId) ?? {
      type: { slug: r.slug, name: r.typeName },
      total: 0,
      roles: noRoles(),
      events: [],
    }
    const role = normalizeRole(r.role)
    group.total++
    if (role) group.roles[role]++
    group.events.push({
      id: r.id,
      name: r.name,
      startDate: r.startDate,
      datePrecision: r.datePrecision,
      role,
    })
    groups.set(r.typeId, group)
  }
  return [...groups.values()]
}

/** Arrangementet, låst for resten av transaksjonen, med typen. */
async function lockEvent(tx: Tx, eventId: string) {
  const [row] = await tx
    .select({
      id: event.id,
      typeId: event.typeId,
      name: event.name,
      startDate: event.startDate,
      endDate: event.endDate,
      datePrecision: event.datePrecision,
      location: event.location,
      description: event.description,
      typeSlug: eventType.slug,
      typeName: eventType.name,
    })
    .from(event)
    .innerJoin(eventType, eq(eventType.id, event.typeId))
    .where(eq(event.id, eventId))
    .for('update', { of: event })
  if (!row) throw new NotFoundError('Fant ikke arrangementet.')
  return row
}

export function assertStarted(e: { startDate: string; name?: string }) {
  if (e.startDate > osloToday()) {
    throw new DomainError(
      `${e.name ?? 'Arrangementet'} har ikke startet ennå. Deltakelse registreres når det har startet.`,
    )
  }
}

/** Det som står i loggen om arrangementet, så setningene kan lenke til det. */
const eventRef = (e: { id: string; name: string; typeSlug: string; typeName: string }) => ({
  eventId: e.id,
  name: e.name,
  typeSlug: e.typeSlug,
  typeName: e.typeName,
})

/** «Jeg var der»: den innloggede legger til eller fjerner seg selv. Gjelder med en gang. */
export async function setOwnParticipation(
  db: Db,
  viewer: Viewer,
  eventId: string,
  participated: boolean,
): Promise<void> {
  assertMember(viewer)
  await db.transaction(async (tx) => {
    const e = await lockEvent(tx, eventId)
    if (participated) {
      assertStarted(e)
      await tx
        .insert(eventParticipation)
        .values({ eventId, personId: viewer.personId, source: 'self' })
        .onConflictDoNothing()
    } else {
      await tx
        .delete(eventParticipation)
        .where(
          and(
            eq(eventParticipation.eventId, eventId),
            eq(eventParticipation.personId, viewer.personId),
          ),
        )
    }
  })
}

// ---------------------------------------------------------------------------
// For admins: typer
// ---------------------------------------------------------------------------

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new DomainError(parsed.error.issues[0]?.message ?? 'Ugyldige felt.')
  return parsed.data
}

/** ESAF-helgen kan ikke slettes; gamle lenker til /esaf-helgen sendes dit. */
export const ESAF_WEEKEND_SLUG = 'esaf-helgen'

export const eventTypeInput = z.object({
  name: z.string().trim().min(2, 'Navnet må ha minst 2 tegn.').max(60, 'Maks 60 tegn.'),
  plural: optionalText(60),
  description: optionalText(500),
  sortOrder: z.number().int().min(0, 'Ugyldig rekkefølge.').max(1000, 'Ugyldig rekkefølge.'),
})

export type EventTypeInput = z.input<typeof eventTypeInput>

/** Adressen for en ny type, fra navnet: «Fagkveld» blir `fagkveld`. */
export const eventTypeSlug = (name: string) =>
  companySlug(name)
    .replace(/^selskap-/, 'type-')
    .slice(0, 60)
    .replace(/-$/, '')

export async function createEventType(
  db: Db,
  viewer: Viewer,
  input: EventTypeInput,
): Promise<{ id: string; slug: string }> {
  assertCan(viewer, 'profiles.edit')
  const values = parse(eventTypeInput, input)
  const slug = eventTypeSlug(values.name)
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(eventType)
      .values({ ...values, slug })
      .onConflictDoNothing()
      .returning({ id: eventType.id, slug: eventType.slug })
    if (!row)
      throw new DomainError(`Det finnes allerede en type med adressen /arrangementer/${slug}.`)
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'event_type.create',
      details: { typeId: row.id, slug, name: values.name },
    })
    return row
  })
}

export async function updateEventType(
  db: Db,
  viewer: Viewer,
  typeId: string,
  input: EventTypeInput,
): Promise<void> {
  assertCan(viewer, 'profiles.edit')
  const values = parse(eventTypeInput, input)
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(eventType).where(eq(eventType.id, typeId)).for('update')
    if (!before) throw new NotFoundError('Fant ikke arrangementstypen.')
    const fields = (Object.keys(values) as (keyof typeof values)[]).filter(
      (key) => values[key] !== before[key],
    )
    if (!fields.length) return
    await tx
      .update(eventType)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(eventType.id, typeId))
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'event_type.edit',
      details: {
        typeId,
        slug: before.slug,
        name: values.name,
        previousName: before.name,
        fields,
      },
    })
  })
}

/** Sletter en tom type. Typer med arrangementer, og ESAF-helgen, kan ikke slettes. */
export async function deleteEventType(db: Db, viewer: Viewer, typeId: string): Promise<void> {
  assertCan(viewer, 'profiles.edit')
  await db.transaction(async (tx) => {
    const [type] = await tx.select().from(eventType).where(eq(eventType.id, typeId)).for('update')
    if (!type) throw new NotFoundError('Fant ikke arrangementstypen.')
    if (type.slug === ESAF_WEEKEND_SLUG) throw new DomainError('ESAF-helgen kan ikke slettes.')
    const events = await tx.$count(event, eq(event.typeId, typeId))
    if (events) {
      throw new DomainError(
        `${type.name} har ${events} ${events === 1 ? 'arrangement' : 'arrangementer'}. Slett eller flytt dem først.`,
      )
    }
    // Et merke med regel for typen ville ellers aldri kunne deles ut eller rettes.
    const [usedBy] = await tx
      .select({ name: schema.badge.name })
      .from(schema.badge)
      .where(sql`${schema.badge.rule}->>'eventTypeId' = ${typeId}`)
      .limit(1)
    if (usedBy) {
      throw new DomainError(
        `Merket «${usedBy.name}» bruker ${type.name}. Endre eller slett merket først.`,
      )
    }
    await tx.delete(eventType).where(eq(eventType.id, typeId))
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'event_type.delete',
      details: { typeId, slug: type.slug, name: type.name },
    })
  })
}

/** Alle typene, til skjemaene for admins. */
export async function listEventTypeOptions(db: Db, viewer: Viewer): Promise<EventTypeInfo[]> {
  assertCan(viewer, 'profiles.edit')
  return db
    .select(typeColumns)
    .from(eventType)
    .orderBy(asc(eventType.sortOrder), asc(eventType.name))
}

// ---------------------------------------------------------------------------
// For admins: arrangementer
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

/** Et arrangement kan vare høyst så mange dager. */
export const MAX_EVENT_DAYS = 31

/**
 * Et arrangement. Med `datePrecision` `semester` eller `year` brukes bare året
 * (og semesteret) i `startDate`; datoen lagres som første dag i perioden, uten
 * sluttdato. Uten `datePrecision` er datoen kjent.
 */
export const eventInput = z
  .object({
    typeId: z.uuid('Velg en type.'),
    name: z.string().trim().min(3, 'Navnet må ha minst 3 tegn.').max(120, 'Maks 120 tegn.'),
    startDate: isoDate,
    endDate: z
      .union([isoDate, z.literal('')])
      .nullable()
      .transform((d) => d || null),
    datePrecision: z.enum(eventDatePrecisions, 'Ugyldig datopresisjon.').default('day'),
    location: optionalText(120),
    description: optionalText(2000),
  })
  .transform((e) =>
    e.datePrecision === 'day'
      ? e
      : {
          ...e,
          startDate: periodStart(
            Number(e.startDate.slice(0, 4)),
            e.datePrecision === 'year' ? 'year' : seasonOf(e.startDate),
          ),
          endDate: null,
        },
  )
  .refine((e) => e.endDate === null || e.endDate >= e.startDate, {
    message: 'Sluttdatoen kan ikke være før startdatoen.',
  })
  .refine(
    (e) =>
      e.endDate === null ||
      new Date(`${e.endDate}T00:00:00Z`).getTime() -
        new Date(`${e.startDate}T00:00:00Z`).getTime() <=
        MAX_EVENT_DAYS * 864e5,
    { message: `Et arrangement kan vare høyst ${MAX_EVENT_DAYS} dager.` },
  )

export type EventInput = z.input<typeof eventInput>
export type EventValues = z.output<typeof eventInput>

export const parseEventInput = (input: unknown): EventValues => parse(eventInput, input)

async function typeById(tx: Tx, typeId: string) {
  const [type] = await tx
    .select({ id: eventType.id, slug: eventType.slug, name: eventType.name })
    .from(eventType)
    .where(eq(eventType.id, typeId))
  if (!type) throw new DomainError('Fant ikke arrangementstypen.')
  return type
}

/** Det som kan rettes, med verdiene nå. */
export async function getEditableEvent(db: Db, viewer: Viewer, eventId: string) {
  assertCan(viewer, 'profiles.edit')
  const [row] = await db.select().from(event).where(eq(event.id, eventId))
  if (!row) throw new NotFoundError('Fant ikke arrangementet.')
  return {
    id: row.id,
    typeId: row.typeId,
    name: row.name,
    startDate: row.startDate,
    endDate: row.endDate,
    datePrecision: row.datePrecision,
    location: row.location,
    description: row.description,
  }
}

/**
 * Lager arrangementet i en transaksjon som allerede er i gang, og logger det.
 * Importen bruker den for arrangementer som mangler.
 */
export async function insertEvent(
  tx: Tx,
  viewer: NonNullable<Viewer>,
  values: EventValues,
  extra: { via?: string } = {},
) {
  const type = await typeById(tx, values.typeId)
  const [row] = await tx.insert(event).values(values).returning({ id: event.id })
  await tx.insert(auditEvent).values({
    actorPersonId: viewer.personId,
    action: 'event.create',
    details: {
      ...eventRef({ id: row!.id, name: values.name, typeSlug: type.slug, typeName: type.name }),
      startDate: values.startDate,
      datePrecision: values.datePrecision,
      ...(extra.via ? { via: extra.via } : {}),
    },
  })
  return { id: row!.id, typeSlug: type.slug }
}

export async function createEvent(
  db: Db,
  viewer: Viewer,
  input: EventInput,
): Promise<{ id: string; typeSlug: string }> {
  assertCan(viewer, 'profiles.edit')
  const values = parse(eventInput, input)
  return db.transaction((tx) => insertEvent(tx, viewer, values))
}

export async function updateEvent(
  db: Db,
  viewer: Viewer,
  eventId: string,
  input: EventInput,
): Promise<{ typeSlug: string }> {
  assertCan(viewer, 'profiles.edit')
  const values = parse(eventInput, input)
  return db.transaction(async (tx) => {
    const before = await lockEvent(tx, eventId)
    const type = await typeById(tx, values.typeId)
    const fields = (Object.keys(values) as (keyof typeof values)[]).filter(
      (key) => values[key] !== before[key],
    )
    if (!fields.length) return { typeSlug: type.slug }
    await tx
      .update(event)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(event.id, eventId))
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'event.edit',
      details: {
        ...eventRef({ id: eventId, name: values.name, typeSlug: type.slug, typeName: type.name }),
        previousName: before.name,
        ...(type.id !== before.typeId ? { previousType: before.typeName } : {}),
        fields,
      },
    })
    return { typeSlug: type.slug }
  })
}

/**
 * Sletter arrangementet, deltakelsen og bildene og dokumentene. Logges med
 * navnet, hvor mange som var der og hvor mange filer som ble slettet. Med
 * `storage` fjernes filene med en gang, ellers av oppryddingen.
 */
export async function deleteEvent(
  db: Db,
  viewer: Viewer,
  eventId: string,
  storage?: ObjectStorage,
): Promise<{ typeSlug: string }> {
  assertCan(viewer, 'profiles.edit')
  const { typeSlug, files } = await db.transaction(async (tx) => {
    const e = await lockEvent(tx, eventId)
    const participants = await tx.$count(
      eventParticipation,
      eq(eventParticipation.eventId, eventId),
    )
    const removed: PurgeTarget[] = await deleteAssetsOf(tx, { eventId })
    await tx.delete(event).where(eq(event.id, eventId))
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'event.delete',
      details: { ...eventRef(e), startDate: e.startDate, participants, files: removed.length },
    })
    return { typeSlug: e.typeSlug, files: removed }
  })
  if (storage) await purgeAssets(db, storage, files)
  return { typeSlug }
}

// ---------------------------------------------------------------------------
// For admins: deltakere
// ---------------------------------------------------------------------------

const MAX_BULK = MAX_LINES

const roleInput = z
  .enum(['attended', ...eventRoles])
  .nullable()
  .optional()
  .transform((r) => normalizeRole(r ?? null))

/**
 * Legger til deltakere, eventuelt med en rolle. `import` er for lister som er
 * limt inn, `admin` for deltakere lagt til én og én. De som allerede er
 * registrert, beholdes som de er. Gir hvor mange som ble lagt til.
 */
export async function addEventParticipants(
  db: Db,
  viewer: Viewer,
  eventId: string,
  input: { personIds: string[]; source: 'admin' | 'import'; role?: ParticipationRole | null },
): Promise<{ added: number }> {
  assertCan(viewer, 'profiles.edit')
  const ids = parse(z.array(z.uuid()).min(1, 'Velg minst én person.').max(MAX_BULK), [
    ...new Set(input.personIds),
  ])
  const source = parse(z.enum(['admin', 'import']), input.source)
  const role = parse(roleInput, input.role)
  return db.transaction(async (tx) => {
    const e = await lockEvent(tx, eventId)
    assertStarted(e)
    const found = await tx.select({ id: person.id }).from(person).where(inArray(person.id, ids))
    if (found.length !== ids.length) throw new NotFoundError('Fant ikke alle personene.')
    const added = await tx
      .insert(eventParticipation)
      .values(ids.map((personId) => ({ eventId, personId, source, role })))
      .onConflictDoNothing()
      .returning({ personId: eventParticipation.personId })
    if (added.length) {
      await tx.insert(auditEvent).values({
        actorPersonId: viewer.personId,
        action: 'event.participant_add',
        subjectPersonId: added.length === 1 ? added[0]!.personId : null,
        details: {
          ...eventRef(e),
          source,
          role,
          added: added.length,
          personIds: added.map((a) => a.personId),
        },
      })
    }
    return { added: added.length }
  })
}

/** «Legg til hele kullet»: alle aktive medlemmer som gikk i kullet som studenter. */
export async function addEventCohort(
  db: Db,
  viewer: Viewer,
  eventId: string,
  graduationYear: number,
): Promise<{ added: number }> {
  assertCan(viewer, 'profiles.edit')
  return db.transaction(async (tx) => {
    const e = await lockEvent(tx, eventId)
    assertStarted(e)
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
      .insert(eventParticipation)
      .values(students.map(({ personId }) => ({ eventId, personId, source: 'admin' as const })))
      .onConflictDoNothing()
      .returning({ personId: eventParticipation.personId })
    if (added.length) {
      await tx.insert(auditEvent).values({
        actorPersonId: viewer.personId,
        action: 'event.participant_add',
        details: {
          ...eventRef(e),
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

export const participantInput = z.object({
  role: roleInput,
  note: optionalText(300),
})

export type ParticipantInput = z.input<typeof participantInput>

/** Endrer rollen og notatet til en deltaker. */
export async function updateEventParticipant(
  db: Db,
  viewer: Viewer,
  eventId: string,
  personId: string,
  input: ParticipantInput,
): Promise<void> {
  assertCan(viewer, 'profiles.edit')
  const values = parse(participantInput, input)
  await db.transaction(async (tx) => {
    const e = await lockEvent(tx, eventId)
    const where = and(
      eq(eventParticipation.eventId, eventId),
      eq(eventParticipation.personId, personId),
    )
    const [before] = await tx.select().from(eventParticipation).where(where).for('update')
    if (!before) throw new NotFoundError('Personen er ikke registrert på arrangementet.')
    const from = normalizeRole(before.role)
    if (from === values.role && before.note === values.note) return
    await tx.update(eventParticipation).set(values).where(where)
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'event.participant_edit',
      subjectPersonId: personId,
      details: {
        ...eventRef(e),
        from: { role: from },
        to: { role: values.role },
        noteChanged: before.note !== values.note,
      },
    })
  })
}

export async function removeEventParticipant(
  db: Db,
  viewer: Viewer,
  eventId: string,
  personId: string,
): Promise<void> {
  assertCan(viewer, 'profiles.edit')
  await db.transaction(async (tx) => {
    const e = await lockEvent(tx, eventId)
    const removed = await tx
      .delete(eventParticipation)
      .where(
        and(eq(eventParticipation.eventId, eventId), eq(eventParticipation.personId, personId)),
      )
      .returning({ source: eventParticipation.source, role: eventParticipation.role })
    if (!removed.length) throw new NotFoundError('Personen er ikke registrert på arrangementet.')
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'event.participant_remove',
      subjectPersonId: personId,
      details: {
        ...eventRef(e),
        source: removed[0]!.source,
        role: normalizeRole(removed[0]!.role),
      },
    })
  })
}

/** Matcher en innlimt liste mot alle personer ESAF kjenner, til forhåndsvisningen før lagring. */
export async function matchEventParticipants(
  db: Db,
  viewer: Viewer,
  eventId: string,
  text: string,
): Promise<MatchLine[]> {
  assertCan(viewer, 'profiles.edit')
  if (text.length > 100_000) throw new DomainError('Lista er for lang.')
  const [[found], people, participation] = await Promise.all([
    db.select({ id: event.id }).from(event).where(eq(event.id, eventId)),
    loadMatchPeople(db),
    db
      .select({ personId: eventParticipation.personId })
      .from(eventParticipation)
      .where(eq(eventParticipation.eventId, eventId)),
  ])
  if (!found) throw new NotFoundError('Fant ikke arrangementet.')
  return matchAttendeeLines(text, people, new Set(participation.map((p) => p.personId)))
}

/** Arrangementet en gammel ESAF-helg-lenke peker til, med typen, eller null. */
export async function findEventType(db: Db, viewer: Viewer, eventId: string) {
  assertMember(viewer)
  const [row] = await db
    .select({ slug: eventType.slug })
    .from(event)
    .innerJoin(eventType, eq(eventType.id, event.typeId))
    .where(eq(event.id, eventId))
  return row ? { typeSlug: row.slug } : null
}
