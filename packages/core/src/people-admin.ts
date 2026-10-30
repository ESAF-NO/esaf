import {
  schema,
  type CohortRelation,
  type Db,
  type MemberRole,
  type MembershipStatus,
  type PersonSource,
} from '@esaf/db'
import { and, asc, eq, ilike, inArray, isNull, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import { assertCan, type Viewer } from './access.ts'
import { deleteOrphanCompanies } from './companies.ts'
import { DomainError, NotFoundError } from './errors.ts'
import { normalizeEmail, type Tx } from './members.ts'
import { deletePhotoFiles, photoUrls, type ProfilePhoto } from './photos.ts'
import { normalizePhone } from './profile-import.ts'
import { deleteFieldSources, moveFieldSources, type ProfileSourceField } from './sources.ts'
import type { ObjectStorage } from './storage.ts'

const {
  accessRequest,
  asset,
  auditEvent,
  cohort,
  boardMember,
  cohortRepresentative,
  comment,
  eventParticipation,
  companyLinkRequest,
  companySuggestion,
  experience,
  invitation,
  membership,
  notification,
  person,
  personCohort,
  personEmail,
  post,
  postVote,
  quote,
  user,
} = schema

/**
 * Personer for admins med `profiles.edit`: lage profiler for hånd, rette kull og
 * kjente e-postadresser, og slå sammen duplikater. Reglene:
 *
 * - Kjente e-postadresser (`person_email`) brukes til å koble kontoer til
 *   profiler. Admins ser og retter dem her, men de vises aldri for andre
 *   medlemmer. Adressen kontoen logger inn med, kan ikke fjernes.
 * - Sammenslåing flytter alt fra duplikatet til personen som beholdes: erfaring,
 *   kull, e-post, sitater, kilder, innlegg, kommentarer, stemmer, varsler,
 *   forslag, forespørsler, verv som kullrepresentant og i styret, og deltakelse
 *   på arrangementer. Tomme felt fylles fra duplikatet. Har en av dem konto, er
 *   det den som beholdes; to kontoer slås aldri sammen.
 * - Alt logges (`profile.create`, `profile.admin_cohorts`,
 *   `profile.admin_email_add`, `profile.admin_email_remove`, `person.merge`).
 */

/** Navnet uten store bokstaver, aksenter og tegn, til å finne samme person skrevet ulikt. */
export function normalizePersonName(name: string) {
  return name
    .toLocaleLowerCase('nb')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ø/g, 'o')
    .replace(/æ/g, 'ae')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s-]+/g, ' ')
    .trim()
}

const cohortInput = z.object({
  graduationYear: z
    .number()
    .int()
    .min(1990, 'Ugyldig kull.')
    .refine((y) => y <= new Date().getFullYear() + 4, 'Ugyldig kull.'),
  relation: z.enum(schema.cohortRelation.enumValues),
})

export const cohortsInput = z
  .array(cohortInput)
  .max(10, 'Maks 10 kull.')
  .refine(
    (list) => new Set(list.map((c) => c.graduationYear)).size === list.length,
    'Samme kull står to ganger.',
  )

export const emailInput = z
  .string()
  .trim()
  .max(200)
  .pipe(z.email('Ugyldig e-postadresse.'))
  .transform(normalizeEmail)

export const newProfileInput = z.object({
  fullName: z.string().trim().min(2, 'Navn må ha minst 2 tegn.').max(120),
  cohorts: cohortsInput,
  emails: z.array(emailInput).max(10, 'Maks 10 e-postadresser.'),
  /** `active` vises i katalogen med en gang, som profiler fra kullisten. */
  status: z.enum(['active', 'pending']),
})

export type NewProfileInput = z.input<typeof newProfileInput>

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new DomainError(parsed.error.issues[0]?.message ?? 'Ugyldige felt.')
  return parsed.data
}

/** Kullene, opprettet om de ikke finnes. */
async function cohortIds(tx: Tx, years: number[]) {
  if (!years.length) return new Map<number, string>()
  await tx
    .insert(cohort)
    .values(years.map((graduationYear) => ({ graduationYear })))
    .onConflictDoNothing()
  const rows = await tx
    .select({ id: cohort.id, year: cohort.graduationYear })
    .from(cohort)
    .where(inArray(cohort.graduationYear, years))
  return new Map(rows.map((r) => [r.year, r.id]))
}

/** Feiler hvis en av adressene allerede hører til en annen person. */
async function assertEmailsFree(tx: Tx, emails: string[], personId?: string) {
  if (!emails.length) return
  const [taken] = await tx
    .select({ email: personEmail.email, fullName: person.fullName })
    .from(personEmail)
    .innerJoin(person, eq(person.id, personEmail.personId))
    .where(
      and(
        inArray(personEmail.email, emails),
        personId ? ne(personEmail.personId, personId) : undefined,
      ),
    )
    .limit(1)
  if (taken) throw new DomainError(`${taken.email} hører allerede til ${taken.fullName}.`)
}

/** Lager en profil for hånd, som en profil fra kullisten. Gir ingen tilgang til noen konto. */
export async function createProfile(
  db: Db,
  viewer: Viewer,
  input: NewProfileInput,
): Promise<{ personId: string }> {
  assertCan(viewer, 'profiles.edit')
  const values = parse(newProfileInput, input)
  return db.transaction((tx) => insertProfile(tx, viewer, values))
}

/**
 * Lager profilen i en transaksjon som allerede er i gang, og logger det som
 * `profile.create`. Importene bruker den for personer admin vil opprette.
 * Rettighetene må være sjekket av den som kaller.
 */
export async function insertProfile(
  tx: Tx,
  viewer: Viewer,
  input: NewProfileInput,
  extra: { via?: string } = {},
): Promise<{ personId: string }> {
  const values = parse(newProfileInput, input)
  const emails = [...new Set(values.emails)]
  await assertEmailsFree(tx, emails)
  const [created] = await tx
    .insert(person)
    .values({ fullName: values.fullName, source: 'admin' })
    .returning({ id: person.id })
  const personId = created!.id
  await tx.insert(membership).values({ personId, status: values.status })
  const ids = await cohortIds(
    tx,
    values.cohorts.map((c) => c.graduationYear),
  )
  if (values.cohorts.length) {
    await tx.insert(personCohort).values(
      values.cohorts.map((c) => ({
        personId,
        cohortId: ids.get(c.graduationYear)!,
        relation: c.relation,
      })),
    )
  }
  if (emails.length) {
    await tx
      .insert(personEmail)
      .values(emails.map((email) => ({ email, personId, source: 'admin' as const })))
  }
  await tx.insert(auditEvent).values({
    actorPersonId: viewer?.personId ?? null,
    action: 'profile.create',
    subjectPersonId: personId,
    details: {
      fullName: values.fullName,
      cohorts: values.cohorts.map((c) => c.graduationYear),
      emails: emails.length,
      status: values.status,
      ...(extra.via ? { via: extra.via } : {}),
    },
  })
  return { personId }
}

export type AdminPerson = {
  personId: string
  fullName: string
  photo: ProfilePhoto | null
  claimed: boolean
  source: PersonSource
  status: MembershipStatus | null
  cohortYears: number[]
  createdAt: Date
}

/** Alle personer ESAF kjenner til, også profiler som venter og deaktiverte. */
export async function listPeopleForAdmin(db: Db, viewer: Viewer): Promise<AdminPerson[]> {
  assertCan(viewer, 'profiles.edit')
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
      .orderBy(asc(person.fullName)),
    db
      .select({ personId: personCohort.personId, year: cohort.graduationYear })
      .from(personCohort)
      .innerJoin(cohort, eq(cohort.id, personCohort.cohortId))
      .orderBy(asc(cohort.graduationYear)),
  ])
  const byPerson = new Map<string, number[]>()
  for (const y of years) byPerson.set(y.personId, [...(byPerson.get(y.personId) ?? []), y.year])
  return rows.map(({ photoKey, userId, ...r }) => ({
    ...r,
    photo: photoUrls(photoKey),
    claimed: userId !== null,
    cohortYears: byPerson.get(r.personId) ?? [],
  }))
}

/** Søk blant alle personer, til å velge hvem som skal slås sammen. */
export async function searchAllPeople(
  db: Db,
  viewer: Viewer,
  query: string,
): Promise<AdminPerson[]> {
  assertCan(viewer, 'profiles.edit')
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
    })
    .from(person)
    .leftJoin(membership, eq(membership.personId, person.id))
    .where(ilike(person.fullName, `%${q.replace(/[%_\\]/g, '\\$&')}%`))
    .orderBy(asc(person.fullName))
    .limit(10)
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

/**
 * Personer med samme navn (normalisert) og kull innenfor ett år, eller uten kull.
 * Til å advare før en ny profil lages.
 */
export async function findSimilarPeople(
  db: Db,
  viewer: Viewer,
  input: { fullName: string; years: number[] },
): Promise<AdminPerson[]> {
  assertCan(viewer, 'profiles.edit')
  const wanted = normalizePersonName(input.fullName)
  if (wanted.length < 3) return []
  const all = await listPeopleForAdmin(db, viewer)
  return all
    .filter(
      (p) =>
        normalizePersonName(p.fullName) === wanted &&
        (!p.cohortYears.length ||
          !input.years.length ||
          p.cohortYears.some((a) => input.years.some((b) => Math.abs(a - b) <= 1))),
    )
    .slice(0, 5)
}

export type PersonAdminDetails = {
  personId: string
  fullName: string
  claimed: boolean
  source: PersonSource
  status: MembershipStatus | null
  role: MemberRole | null
  cohorts: { graduationYear: number; relation: CohortRelation }[]
  /** Alle kjente adresser. Vises aldri for andre enn admins. */
  emails: { email: string; source: 'signup' | 'import' | 'admin'; login: boolean }[]
}

/** Det admins kan rette utover profilfeltene: kull og kjente e-postadresser. */
export async function getPersonAdmin(
  db: Db,
  viewer: Viewer,
  personId: string,
): Promise<PersonAdminDetails> {
  assertCan(viewer, 'profiles.edit')
  const [row] = await db
    .select({
      personId: person.id,
      fullName: person.fullName,
      userId: person.userId,
      source: person.source,
      status: membership.status,
      role: membership.role,
      loginEmail: user.email,
    })
    .from(person)
    .leftJoin(membership, eq(membership.personId, person.id))
    .leftJoin(user, eq(user.id, person.userId))
    .where(eq(person.id, personId))
  if (!row) throw new NotFoundError('Fant ikke personen.')
  const [cohorts, emails] = await Promise.all([
    db
      .select({ graduationYear: cohort.graduationYear, relation: personCohort.relation })
      .from(personCohort)
      .innerJoin(cohort, eq(cohort.id, personCohort.cohortId))
      .where(eq(personCohort.personId, personId))
      .orderBy(asc(cohort.graduationYear)),
    db
      .select({ email: personEmail.email, source: personEmail.source })
      .from(personEmail)
      .where(eq(personEmail.personId, personId))
      .orderBy(asc(personEmail.createdAt)),
  ])
  const login = row.loginEmail ? normalizeEmail(row.loginEmail) : null
  return {
    personId: row.personId,
    fullName: row.fullName,
    claimed: row.userId !== null,
    source: row.source,
    status: row.status,
    role: row.role,
    cohorts,
    emails: emails.map((e) => ({ ...e, login: e.email === login })),
  }
}

async function lockPerson(tx: Tx, personId: string) {
  const [row] = await tx
    .select({ id: person.id, fullName: person.fullName })
    .from(person)
    .where(eq(person.id, personId))
    .for('update')
  if (!row) throw new NotFoundError('Fant ikke personen.')
  return row
}

/** Erstatter kullene til personen. */
export async function setPersonCohorts(
  db: Db,
  viewer: Viewer,
  personId: string,
  input: { graduationYear: number; relation: CohortRelation }[],
): Promise<void> {
  assertCan(viewer, 'profiles.edit')
  const cohorts = parse(cohortsInput, input)
  await db.transaction(async (tx) => {
    await lockPerson(tx, personId)
    const before = await tx
      .select({ graduationYear: cohort.graduationYear, relation: personCohort.relation })
      .from(personCohort)
      .innerJoin(cohort, eq(cohort.id, personCohort.cohortId))
      .where(eq(personCohort.personId, personId))
      .orderBy(asc(cohort.graduationYear))
    const key = (list: { graduationYear: number; relation: string }[]) =>
      JSON.stringify(
        [...list]
          .sort((a, b) => a.graduationYear - b.graduationYear)
          .map((c) => [c.graduationYear, c.relation]),
      )
    if (key(before) === key(cohorts)) return
    const ids = await cohortIds(
      tx,
      cohorts.map((c) => c.graduationYear),
    )
    await tx.delete(personCohort).where(eq(personCohort.personId, personId))
    if (cohorts.length) {
      await tx.insert(personCohort).values(
        cohorts.map((c) => ({
          personId,
          cohortId: ids.get(c.graduationYear)!,
          relation: c.relation,
        })),
      )
    }
    const describe = (list: { graduationYear: number; relation: string }[]) =>
      list.map((c) =>
        c.relation === 'student' ? `${c.graduationYear}` : `${c.graduationYear} (${c.relation})`,
      )
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'profile.admin_cohorts',
      subjectPersonId: personId,
      details: { from: describe(before), to: describe(cohorts) },
    })
  })
}

/** Legger til en kjent e-postadresse. En konto med adressen kan da gjøre krav på profilen. */
export async function addPersonEmail(
  db: Db,
  viewer: Viewer,
  personId: string,
  email: string,
): Promise<void> {
  assertCan(viewer, 'profiles.edit')
  const address = parse(emailInput, email)
  await db.transaction(async (tx) => {
    await lockPerson(tx, personId)
    const [existing] = await tx
      .select({ personId: personEmail.personId })
      .from(personEmail)
      .where(eq(personEmail.email, address))
      .for('update')
    if (existing?.personId === personId) throw new DomainError('Adressen er allerede lagt inn.')
    await assertEmailsFree(tx, [address], personId)
    await tx.insert(personEmail).values({ email: address, personId, source: 'admin' })
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'profile.admin_email_add',
      subjectPersonId: personId,
      details: { email: address },
    })
  })
}

/** Fjerner en kjent e-postadresse, men aldri den kontoen logger inn med. */
export async function removePersonEmail(
  db: Db,
  viewer: Viewer,
  personId: string,
  email: string,
): Promise<void> {
  assertCan(viewer, 'profiles.edit')
  const address = normalizeEmail(email)
  await db.transaction(async (tx) => {
    await lockPerson(tx, personId)
    const [login] = await tx
      .select({ email: user.email })
      .from(person)
      .innerJoin(user, eq(user.id, person.userId))
      .where(eq(person.id, personId))
    if (login && normalizeEmail(login.email) === address) {
      throw new DomainError('Dette er adressen kontoen logger inn med, og den kan ikke fjernes.')
    }
    const removed = await tx
      .delete(personEmail)
      .where(and(eq(personEmail.email, address), eq(personEmail.personId, personId)))
      .returning({ email: personEmail.email })
    if (!removed.length) throw new NotFoundError('Fant ikke adressen.')
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'profile.admin_email_remove',
      subjectPersonId: personId,
      details: { email: address },
    })
  })
}

const personColumns = {
  id: person.id,
  fullName: person.fullName,
  userId: person.userId,
  city: person.city,
  studyBackground: person.studyBackground,
  esCompanyId: person.esCompanyId,
  bio: person.bio,
  expertise: person.expertise,
  industries: person.industries,
  linkedinUrl: person.linkedinUrl,
  photoKey: person.photoKey,
  contactEmail: person.contactEmail,
  contactEmailVisible: person.contactEmailVisible,
  phone: person.phone,
  phoneVisible: person.phoneVisible,
}

/** Et kontaktfelt som har en verdi, men er skjult for medlemmer. */
const hiddenContact = (value: string | null, visible: boolean) => value !== null && !visible

/**
 * Slår sammen to profiler for samme person. Alt fra `sourceId` flyttes til
 * personen som beholdes, tomme felt fylles fra duplikatet, og duplikatet slettes.
 * Har duplikatet konto og den andre ikke, byttes de, så kontoen beholdes. To
 * kontoer slås aldri sammen. Gir personen som ble beholdt.
 */
export async function mergePeople(
  db: Db,
  storage: ObjectStorage,
  viewer: Viewer,
  input: { sourceId: string; targetId: string },
): Promise<{ personId: string }> {
  assertCan(viewer, 'profiles.edit')
  if (input.sourceId === input.targetId) throw new DomainError('Velg en annen person.')

  const { personId, unusedPhoto } = await db.transaction(async (tx) => {
    // Låses i fast rekkefølge, så to samtidige sammenslåinger ikke venter på hverandre.
    const rows = await tx
      .select(personColumns)
      .from(person)
      .where(inArray(person.id, [input.sourceId, input.targetId]))
      .orderBy(asc(person.id))
      .for('update')
    let source = rows.find((r) => r.id === input.sourceId)
    let target = rows.find((r) => r.id === input.targetId)
    if (!source || !target) throw new NotFoundError('Fant ikke personen.')
    if (source.userId && target.userId) {
      throw new DomainError(
        'Begge har egen konto, og to kontoer kan ikke slås sammen. Be den ene om å slutte å bruke sin.',
      )
    }
    if (source.userId) [source, target] = [target, source]
    const from = source.id
    const into = target.id

    // Erfaring: duplikatets rader kommer etter målets, og like rader tas bare én gang.
    const jobs = await tx
      .select()
      .from(experience)
      .where(inArray(experience.personId, [from, into]))
      .orderBy(asc(experience.position))
    const key = (e: (typeof jobs)[number]) =>
      JSON.stringify([e.companyId, e.title, e.startYear, e.endYear, e.founder])
    const kept = new Set(jobs.filter((e) => e.personId === into).map(key))
    let position = Math.max(-1, ...jobs.filter((e) => e.personId === into).map((e) => e.position))
    let movedJobs = 0
    for (const e of jobs.filter((j) => j.personId === from)) {
      if (kept.has(key(e))) {
        await tx.delete(experience).where(eq(experience.id, e.id))
        continue
      }
      kept.add(key(e))
      position++
      movedJobs++
      await tx.update(experience).set({ personId: into, position }).where(eq(experience.id, e.id))
    }

    // Kull: målets tilknytning gjelder når begge er i samme kull.
    const movedCohorts = await tx.execute(
      sql`insert into ${personCohort} (person_id, cohort_id, relation, created_at) select ${into}, cohort_id, relation, created_at from ${personCohort} where person_id = ${from} on conflict do nothing returning cohort_id`,
    )

    // Kullrepresentant: et nåværende verv duplikatet har i et kull målet også
    // representerer nå, er det samme vervet; ellers flyttes vervene.
    await tx
      .delete(cohortRepresentative)
      .where(
        and(
          eq(cohortRepresentative.personId, from),
          isNull(cohortRepresentative.endYear),
          sql`exists (select 1 from ${cohortRepresentative} other where other.person_id = ${into} and other.cohort_id = ${cohortRepresentative.cohortId} and other.end_year is null)`,
        ),
      )
    const movedReps = await tx
      .update(cohortRepresentative)
      .set({ personId: into })
      .where(eq(cohortRepresentative.personId, from))
      .returning({ id: cohortRepresentative.id })

    // Styret: sitter begge i styret nå, er det samme person i samme styre, og
    // målets verv gjelder. Ellers flyttes vervene.
    await tx
      .delete(boardMember)
      .where(
        and(
          eq(boardMember.personId, from),
          isNull(boardMember.endYear),
          sql`exists (select 1 from ${boardMember} other where other.person_id = ${into} and other.end_year is null)`,
        ),
      )
    const movedBoard = await tx
      .update(boardMember)
      .set({ personId: into })
      .where(eq(boardMember.personId, from))
      .returning({ id: boardMember.id })

    // Arrangementer: deltakelsen til begge, én gang per arrangement. Har den som
    // beholdes ingen rolle eller notat der, tas duplikatets med.
    const movedEvents = await tx.execute(
      sql`insert into ${eventParticipation} (event_id, person_id, role, source, note, created_at) select event_id, ${into}, role, source, note, created_at from ${eventParticipation} where person_id = ${from} on conflict (event_id, person_id) do update set role = coalesce(${eventParticipation}.role, excluded.role), note = coalesce(${eventParticipation}.note, excluded.note) returning (xmax = 0) as inserted`,
    )

    const emails = await tx
      .update(personEmail)
      .set({ personId: into })
      .where(eq(personEmail.personId, from))
      .returning({ email: personEmail.email })
    const quotes = await tx
      .update(quote)
      .set({ personId: into })
      .where(eq(quote.personId, from))
      .returning({ id: quote.id })

    // Innhold og stemmer. Profiler uten konto har sjelden noe, men ingenting skal gå tapt.
    await tx.update(post).set({ authorPersonId: into }).where(eq(post.authorPersonId, from))
    await tx.update(comment).set({ authorPersonId: into }).where(eq(comment.authorPersonId, from))
    await tx.update(asset).set({ ownerPersonId: into }).where(eq(asset.ownerPersonId, from))
    await tx.execute(
      sql`insert into ${postVote} (post_id, person_id, created_at) select post_id, ${into}, created_at from ${postVote} where person_id = ${from} on conflict do nothing`,
    )
    await tx.delete(postVote).where(eq(postVote.personId, from))
    await tx
      .delete(notification)
      .where(
        and(
          eq(notification.recipientPersonId, from),
          sql`exists (select 1 from ${notification} n where n.recipient_person_id = ${into} and n.event_key = ${notification.eventKey})`,
        ),
      )
    await tx
      .update(notification)
      .set({ recipientPersonId: into })
      .where(eq(notification.recipientPersonId, from))
    await tx
      .update(notification)
      .set({ actorPersonId: into })
      .where(eq(notification.actorPersonId, from))

    // Forslag og forespørsler om tilknytning.
    await tx
      .update(companySuggestion)
      .set({ suggestedByPersonId: into })
      .where(eq(companySuggestion.suggestedByPersonId, from))
    await tx
      .update(companySuggestion)
      .set({ decidedByPersonId: into })
      .where(eq(companySuggestion.decidedByPersonId, from))
    await tx
      .delete(companyLinkRequest)
      .where(
        and(
          eq(companyLinkRequest.personId, from),
          eq(companyLinkRequest.status, 'pending'),
          sql`exists (select 1 from ${companyLinkRequest} other where other.person_id = ${into} and other.company_id = ${companyLinkRequest.companyId} and other.role = ${companyLinkRequest.role} and other.status = 'pending')`,
        ),
      )
    await tx
      .update(companyLinkRequest)
      .set({ personId: into })
      .where(eq(companyLinkRequest.personId, from))
    await tx
      .update(companyLinkRequest)
      .set({ requestedByPersonId: into })
      .where(eq(companyLinkRequest.requestedByPersonId, from))
    await tx
      .update(companyLinkRequest)
      .set({ decidedByPersonId: into })
      .where(eq(companyLinkRequest.decidedByPersonId, from))

    // Forespørsler om tilgang og avgjørelser som peker på duplikatet. En forespørsel
    // fra målets egen konto kan ikke peke på målet selv.
    const [account] = target.userId
      ? await tx.select({ id: user.id }).from(user).where(eq(user.id, target.userId))
      : []
    if (account) {
      await tx
        .update(accessRequest)
        .set({ profilePersonId: null })
        .where(and(eq(accessRequest.profilePersonId, from), eq(accessRequest.userId, account.id)))
    }
    await tx
      .update(accessRequest)
      .set({ profilePersonId: into })
      .where(eq(accessRequest.profilePersonId, from))
    await tx
      .update(accessRequest)
      .set({ decidedByPersonId: into })
      .where(eq(accessRequest.decidedByPersonId, from))
    await tx
      .update(membership)
      .set({ decidedByPersonId: into })
      .where(eq(membership.decidedByPersonId, from))
    // Lenker som gjelder duplikatet, gjelder nå personen som ble beholdt. Er den
    // allerede tatt i bruk, avvises en invitasjon til den når den brukes.
    await tx.update(invitation).set({ personId: into }).where(eq(invitation.personId, from))
    await tx
      .update(invitation)
      .set({ createdByPersonId: into })
      .where(eq(invitation.createdByPersonId, from))

    // Loggen forteller fortsatt hva som skjedde, nå med personen som ble beholdt.
    await tx
      .update(auditEvent)
      .set({ actorPersonId: into })
      .where(eq(auditEvent.actorPersonId, from))
    await tx
      .update(auditEvent)
      .set({ subjectPersonId: into })
      .where(eq(auditEvent.subjectPersonId, from))

    // Medlemskapet: en profil uten konto blir aktiv hvis duplikatet var det.
    const statuses = await tx
      .select({ personId: membership.personId, status: membership.status })
      .from(membership)
      .where(inArray(membership.personId, [from, into]))
    const sourceStatus = statuses.find((s) => s.personId === from)?.status
    const targetStatus = statuses.find((s) => s.personId === into)?.status
    if (!targetStatus) {
      await tx.insert(membership).values({ personId: into, status: sourceStatus ?? 'pending' })
    } else if (!target.userId && sourceStatus === 'active' && targetStatus !== 'active') {
      await tx.update(membership).set({ status: 'active' }).where(eq(membership.personId, into))
    }

    // Tomme felt fylles fra duplikatet, og kildene for dem følger med.
    const filled: ProfileSourceField[] = []
    const fill = <K extends 'city' | 'studyBackground' | 'bio' | 'linkedinUrl'>(field: K) => {
      if (target[field] === null && source[field] !== null) filled.push(field)
      return target[field] ?? source[field]
    }
    const values = {
      city: fill('city'),
      studyBackground: fill('studyBackground'),
      bio: fill('bio'),
      linkedinUrl: fill('linkedinUrl'),
      esCompanyId: target.esCompanyId ?? source.esCompanyId,
      expertise: target.expertise.length ? target.expertise : source.expertise,
      industries: target.industries.length ? target.industries : source.industries,
      photoKey: target.photoKey ?? source.photoKey,
      // Kontaktinfo bestemmer personen selv over når profilen er tatt i bruk.
      // Ellers fylles tomme felt fra duplikatet, og er feltet skjult på en av
      // profilene, blir det skjult på den som beholdes.
      ...(target.userId
        ? {}
        : {
            contactEmail: target.contactEmail ?? source.contactEmail,
            contactEmailVisible: !(
              hiddenContact(target.contactEmail, target.contactEmailVisible) ||
              hiddenContact(source.contactEmail, source.contactEmailVisible)
            ),
            phone: target.phone ?? source.phone,
            phoneVisible: !(
              hiddenContact(target.phone, target.phoneVisible) ||
              hiddenContact(source.phone, source.phoneVisible)
            ),
          }),
    }
    if (!target.esCompanyId && source.esCompanyId) filled.push('esCompany')
    if (!target.expertise.length && source.expertise.length) filled.push('expertise')
    if (!target.industries.length && source.industries.length) filled.push('industries')
    if (!target.photoKey && source.photoKey) filled.push('photo')
    if (movedJobs) filled.push('experience')
    await moveFieldSources(tx, 'person', from, into, filled)

    // Duplikatet slettes før målet får bildet, siden nøkkelen er unik.
    await tx.delete(person).where(eq(person.id, from))
    await tx.update(person).set(values).where(eq(person.id, into))
    if (target.esCompanyId && source.esCompanyId && source.esCompanyId !== target.esCompanyId) {
      await deleteOrphanCompanies(tx, [source.esCompanyId])
    }

    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'person.merge',
      subjectPersonId: into,
      details: {
        from: { personId: from, fullName: source.fullName, claimed: source.userId !== null },
        into: { personId: into, fullName: target.fullName, claimed: target.userId !== null },
        experience: movedJobs,
        cohorts: movedCohorts.rows.length,
        representatives: movedReps.length,
        board: movedBoard.length,
        events: movedEvents.rows.filter((r) => r.inserted).length,
        emails: emails.length,
        quotes: quotes.length,
        fields: filled,
      },
    })
    return {
      personId: into,
      unusedPhoto: target.photoKey && source.photoKey ? source.photoKey : null,
    }
  })
  if (unusedPhoto) await deletePhotoFiles(storage, unusedPhoto)
  return { personId }
}

/**
 * Sletter en profil ingen har tatt i bruk, for eksempel en som ble lagt inn ved
 * en feil eller to ganger (da er sammenslåing som regel bedre). Profiler med
 * konto, innlegg eller kommentarer slettes aldri. Krever begrunnelse. Kull,
 * e-postadresser, erfaring, verv, deltakelse og kilder forsvinner med profilen;
 * sitater blir stående uten kobling, med navnet slik kilden skriver det.
 * Ventende invitasjoner til profilen trekkes tilbake. Selskaper som bare fantes
 * fordi profilen nevnte dem, ryddes bort. Logges som `profile.delete`.
 */
export async function deleteProfile(
  db: Db,
  storage: ObjectStorage,
  viewer: Viewer,
  input: { personId: string; reason: string },
): Promise<void> {
  assertCan(viewer, 'profiles.edit')
  const reason = input.reason.trim()
  if (reason.length < 3) {
    throw new DomainError('Skriv en kort begrunnelse. Den lagres i revisjonsloggen.')
  }
  const photoKey = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: person.id,
        fullName: person.fullName,
        userId: person.userId,
        photoKey: person.photoKey,
        esCompanyId: person.esCompanyId,
        source: person.source,
      })
      .from(person)
      .where(eq(person.id, input.personId))
      .for('update')
    if (!row) throw new NotFoundError('Fant ikke personen.')
    if (row.userId) {
      throw new DomainError(
        'Profilen er tatt i bruk av en konto og kan ikke slettes. Deaktiver medlemmet i stedet.',
      )
    }
    const [[posts], [comments]] = await Promise.all([
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(post)
        .where(eq(post.authorPersonId, row.id)),
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(comment)
        .where(eq(comment.authorPersonId, row.id)),
    ])
    if (posts!.n || comments!.n) {
      throw new DomainError('Profilen har innlegg eller kommentarer. Slå den sammen i stedet.')
    }
    const [jobs, years] = await Promise.all([
      tx
        .select({ companyId: experience.companyId })
        .from(experience)
        .where(eq(experience.personId, row.id)),
      tx
        .select({ year: cohort.graduationYear })
        .from(personCohort)
        .innerJoin(cohort, eq(cohort.id, personCohort.cohortId))
        .where(eq(personCohort.personId, row.id)),
    ])
    const revoked = await tx
      .update(invitation)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(invitation.personId, row.id),
          isNull(invitation.usedAt),
          isNull(invitation.revokedAt),
        ),
      )
      .returning({ id: invitation.id })
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'profile.delete',
      details: {
        fullName: row.fullName,
        personId: row.id,
        source: row.source,
        cohorts: years.map((y) => y.year).sort(),
        reason,
        ...(revoked.length ? { revokedInvitations: revoked.length } : {}),
      },
    })
    await deleteFieldSources(tx, 'person', [row.id])
    await tx.delete(person).where(eq(person.id, row.id))
    await deleteOrphanCompanies(tx, [...jobs.map((j) => j.companyId), row.esCompanyId])
    return row.photoKey
  })
  if (photoKey) await deletePhotoFiles(storage, photoKey)
}

/**
 * Fyller inn kontaktinfo på en profil ingen har tatt i bruk, der feltet er tomt,
 * som importen fra kullisten gjør. Står det noe der fra før, eller er profilen
 * tatt i bruk, endres det aldri: da er det personens eget valg. Kontaktadressen
 * blir også en kjent adresse, hvis ingen andre har den. Logges som
 * `profile.admin_contact_fill`.
 */
export async function fillUnclaimedContact(
  db: Db,
  viewer: Viewer,
  personId: string,
  input: { contactEmail?: string | null; phone?: string | null },
): Promise<{ filled: ('contactEmail' | 'phone')[] }> {
  assertCan(viewer, 'profiles.edit')
  const parsed = z
    .object({
      contactEmail: emailInput.nullable().optional(),
      phone: z
        .string()
        .trim()
        .max(30)
        .refine((v) => /^\+?[0-9 ()-]{5,20}$/.test(v), 'Ugyldig telefonnummer.')
        .nullable()
        .optional(),
    })
    .safeParse(input)
  if (!parsed.success) throw new DomainError(parsed.error.issues[0]?.message ?? 'Ugyldige felt.')
  const { contactEmail, phone } = parsed.data
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ userId: person.userId, contactEmail: person.contactEmail, phone: person.phone })
      .from(person)
      .where(eq(person.id, personId))
      .for('update')
    if (!row) throw new NotFoundError('Fant ikke personen.')
    if (row.userId) {
      throw new DomainError('Profilen er tatt i bruk. Bare personen selv endrer kontaktinfoen.')
    }
    const values: { contactEmail?: string; phone?: string } = {}
    if (contactEmail) {
      if (row.contactEmail && normalizeEmail(row.contactEmail) !== contactEmail) {
        throw new DomainError('Profilen har allerede en kontaktadresse, og den endres ikke.')
      }
      if (!row.contactEmail) values.contactEmail = contactEmail
    }
    if (phone) {
      const normalized = normalizePhone(phone) ?? phone
      if (row.phone && row.phone !== normalized) {
        throw new DomainError('Profilen har allerede et telefonnummer, og det endres ikke.')
      }
      if (!row.phone) values.phone = normalized
    }
    const filled = Object.keys(values) as ('contactEmail' | 'phone')[]
    if (!filled.length) return { filled }
    if (values.contactEmail) {
      const [owner] = await tx
        .select({ personId: personEmail.personId })
        .from(personEmail)
        .where(eq(personEmail.email, values.contactEmail))
      if (owner && owner.personId !== personId) {
        await assertEmailsFree(tx, [values.contactEmail], personId)
      }
      if (!owner) {
        await tx
          .insert(personEmail)
          .values({ email: values.contactEmail, personId, source: 'admin' })
      }
    }
    await tx.update(person).set(values).where(eq(person.id, personId))
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'profile.admin_contact_fill',
      subjectPersonId: personId,
      details: { fields: filled },
    })
    return { filled }
  })
}

export type AdminPersonIndexItem = AdminPerson & {
  role: MemberRole | null
  cohorts: { graduationYear: number; relation: CohortRelation }[]
  jobTitle: string | null
  currentCompany: string | null
  city: string | null
  linkedinUrl: string | null
  /** Hvilke profilfelt som er fylt ut, til å finne profiler som trenger mer info. */
  has: {
    photo: boolean
    bio: boolean
    linkedin: boolean
    city: boolean
    experience: boolean
    studyBackground: boolean
    esCompany: boolean
    expertise: boolean
    industries: boolean
    contactEmail: boolean
    phone: boolean
    knownEmail: boolean
  }
}

/**
 * Alle personer med det som trengs for å søke og filtrere i adminverktøy (f.eks.
 * MCP): kull med tilknytning, rolle, nåværende stilling og hvilke felt som
 * mangler. Kontaktinfo tas ikke med, bare om den finnes.
 */
export async function listPeopleIndex(db: Db, viewer: Viewer): Promise<AdminPersonIndexItem[]> {
  assertCan(viewer, 'profiles.edit')
  const [rows, cohorts, jobs, emails] = await Promise.all([
    db
      .select({
        personId: person.id,
        fullName: person.fullName,
        photoKey: person.photoKey,
        userId: person.userId,
        source: person.source,
        status: membership.status,
        role: membership.role,
        createdAt: person.createdAt,
        city: person.city,
        linkedinUrl: person.linkedinUrl,
        bio: person.bio,
        studyBackground: person.studyBackground,
        esCompanyId: person.esCompanyId,
        expertise: person.expertise,
        industries: person.industries,
        contactEmail: person.contactEmail,
        phone: person.phone,
      })
      .from(person)
      .leftJoin(membership, eq(membership.personId, person.id))
      .orderBy(asc(person.fullName)),
    db
      .select({
        personId: personCohort.personId,
        graduationYear: cohort.graduationYear,
        relation: personCohort.relation,
      })
      .from(personCohort)
      .innerJoin(cohort, eq(cohort.id, personCohort.cohortId))
      .orderBy(asc(cohort.graduationYear)),
    db
      .select({
        personId: experience.personId,
        title: experience.title,
        endYear: experience.endYear,
        company: schema.company.name,
      })
      .from(experience)
      .innerJoin(schema.company, eq(schema.company.id, experience.companyId))
      .orderBy(asc(experience.position)),
    db.select({ personId: personEmail.personId }).from(personEmail),
  ])
  const cohortsOf = new Map<string, AdminPersonIndexItem['cohorts']>()
  for (const c of cohorts) {
    cohortsOf.set(c.personId, [
      ...(cohortsOf.get(c.personId) ?? []),
      { graduationYear: c.graduationYear, relation: c.relation },
    ])
  }
  const jobsOf = new Map<string, typeof jobs>()
  for (const j of jobs) jobsOf.set(j.personId, [...(jobsOf.get(j.personId) ?? []), j])
  const withEmail = new Set(emails.map((e) => e.personId))
  return rows.map((r) => {
    const list = jobsOf.get(r.personId) ?? []
    const now = list.find((j) => j.endYear === null)
    const personCohorts = cohortsOf.get(r.personId) ?? []
    return {
      personId: r.personId,
      fullName: r.fullName,
      photo: photoUrls(r.photoKey),
      claimed: r.userId !== null,
      source: r.source,
      status: r.status,
      role: r.role,
      createdAt: r.createdAt,
      cohortYears: personCohorts.map((c) => c.graduationYear),
      cohorts: personCohorts,
      jobTitle: now?.title ?? null,
      currentCompany: now?.company ?? null,
      city: r.city,
      linkedinUrl: r.linkedinUrl,
      has: {
        photo: r.photoKey !== null,
        bio: r.bio !== null,
        linkedin: r.linkedinUrl !== null,
        city: r.city !== null,
        experience: list.length > 0,
        studyBackground: r.studyBackground !== null,
        esCompany: r.esCompanyId !== null,
        expertise: r.expertise.length > 0,
        industries: r.industries.length > 0,
        contactEmail: r.contactEmail !== null,
        phone: r.phone !== null,
        knownEmail: withEmail.has(r.personId),
      },
    }
  })
}
