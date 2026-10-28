import { schema, type Db } from '@esaf/db'
import { and, asc, eq, ilike, isNull } from 'drizzle-orm'
import { assertAdmin, assertMember, type Viewer } from './access.ts'
import { DomainError } from './errors.ts'

const { auditEvent, cohort, membership, person, personCohort, user } = schema

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}

/**
 * Sørger for at en konto med bekreftet e-post har en person og et medlemskap.
 * Finnes det en profil med samme e-post som ingen har tatt i bruk (f.eks. fra
 * kullisten), gjør kontoen krav på den og arver medlemskapet ESAF allerede har
 * gitt profilen. Ellers opprettes en ny person med `pending` medlemskap. Denne
 * funksjonen kan aldri gi adminrett.
 */
async function ensurePersonForVerifiedUser(
  tx: Tx,
  account: { id: string; name: string; email: string },
): Promise<string> {
  const email = normalizeEmail(account.email)
  const [linked] = await tx
    .select({ id: person.id })
    .from(person)
    .where(eq(person.userId, account.id))
  if (linked) return linked.id

  const [claimed] = await tx
    .update(person)
    .set({ userId: account.id, claimedAt: new Date() })
    .where(and(eq(person.email, email), isNull(person.userId)))
    .returning({ id: person.id })

  if (claimed) {
    await tx.insert(membership).values({ personId: claimed.id }).onConflictDoNothing()
    await tx.insert(auditEvent).values({
      actorPersonId: claimed.id,
      action: 'profile.claim',
      subjectPersonId: claimed.id,
      details: { match: 'email' },
    })
    return claimed.id
  }

  const [created] = await tx
    .insert(person)
    .values({ fullName: account.name, email, userId: account.id, claimedAt: new Date() })
    .returning({ id: person.id })
  await tx.insert(membership).values({ personId: created!.id })
  return created!.id
}

/** Bygger `Viewer` for en innlogget bruker. Kalles på serveren for hver forespørsel. */
export async function loadViewer(db: Db, userId: string): Promise<Viewer> {
  const [account] = await db.select().from(user).where(eq(user.id, userId))
  if (!account) return null
  if (!account.emailVerified) {
    return { userId, emailVerified: false, personId: null, membership: null }
  }

  const personId = await db.transaction((tx) => ensurePersonForVerifiedUser(tx, account))
  const [m] = await db
    .select({ status: membership.status, role: membership.role })
    .from(membership)
    .where(eq(membership.personId, personId))
  return { userId, emailVerified: true, personId, membership: m ?? null }
}

export type MemberListItem = {
  personId: string
  fullName: string
  /** `true` når personen selv har tatt i bruk profilen med en bekreftet konto. */
  claimed: boolean
  cohorts: { startYear: number; relation: schema.CohortRelation }[]
}

/**
 * Medlemskatalogen: alle med aktivt medlemskap, både verifiserte brukere og
 * profiler fra kullisten som ikke er tatt i bruk ennå. Kun for aktive
 * medlemmer, og viser bevisst ikke kontaktinfo ennå.
 */
export async function listActiveMembers(db: Db, viewer: Viewer): Promise<MemberListItem[]> {
  assertMember(viewer)
  const rows = await db
    .select({
      personId: person.id,
      fullName: person.fullName,
      userId: person.userId,
      startYear: cohort.startYear,
      relation: personCohort.relation,
    })
    .from(membership)
    .innerJoin(person, eq(person.id, membership.personId))
    .leftJoin(personCohort, eq(personCohort.personId, person.id))
    .leftJoin(cohort, eq(cohort.id, personCohort.cohortId))
    .where(eq(membership.status, 'active'))
    .orderBy(asc(person.fullName), asc(cohort.startYear))

  const byPerson = new Map<string, MemberListItem>()
  for (const row of rows) {
    const item = byPerson.get(row.personId) ?? {
      personId: row.personId,
      fullName: row.fullName,
      claimed: row.userId !== null,
      cohorts: [],
    }
    if (row.startYear !== null && row.relation !== null) {
      item.cohorts.push({ startYear: row.startYear, relation: row.relation })
    }
    byPerson.set(row.personId, item)
  }
  return [...byPerson.values()]
}

export type PendingMembership = {
  personId: string
  fullName: string
  email: string | null
  requestedAt: Date
}

export async function listPendingMemberships(db: Db, viewer: Viewer): Promise<PendingMembership[]> {
  assertAdmin(viewer)
  return db
    .select({
      personId: person.id,
      fullName: person.fullName,
      email: person.email,
      requestedAt: membership.createdAt,
    })
    .from(membership)
    .innerJoin(person, eq(person.id, membership.personId))
    .where(eq(membership.status, 'pending'))
    .orderBy(asc(membership.createdAt))
}

/**
 * Godkjenner eller avslår et ventende medlemskap. Endrer aldri rolle, så
 * adminrett kan ikke deles ut herfra.
 */
export async function decideMembership(
  db: Db,
  viewer: Viewer,
  input: { personId: string; decision: 'approve' | 'reject' },
): Promise<void> {
  assertAdmin(viewer)
  if (input.personId === viewer.personId) {
    throw new DomainError('Du kan ikke behandle ditt eget medlemskap.')
  }
  const status = input.decision === 'approve' ? 'active' : 'inactive'

  await db.transaction(async (tx) => {
    const updated = await tx
      .update(membership)
      .set({ status, decidedAt: new Date(), decidedByPersonId: viewer.personId })
      .where(and(eq(membership.personId, input.personId), eq(membership.status, 'pending')))
      .returning({ personId: membership.personId })
    if (updated.length === 0) throw new DomainError('Fant ikke et ventende medlemskap.')

    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: `membership.${input.decision}`,
      subjectPersonId: input.personId,
    })
  })
}

export type UnclaimedProfile = {
  personId: string
  fullName: string
  cohortYears: number[]
}

/** Søk blant profiler ingen har tatt i bruk, for å koble en konto manuelt. */
export async function searchUnclaimedProfiles(
  db: Db,
  viewer: Viewer,
  query: string,
): Promise<UnclaimedProfile[]> {
  assertAdmin(viewer)
  const q = query.trim()
  if (q.length < 2) return []
  const rows = await db
    .select({ personId: person.id, fullName: person.fullName, startYear: cohort.startYear })
    .from(person)
    .leftJoin(personCohort, eq(personCohort.personId, person.id))
    .leftJoin(cohort, eq(cohort.id, personCohort.cohortId))
    .where(and(isNull(person.userId), ilike(person.fullName, `%${q.replace(/[%_\\]/g, '\\$&')}%`)))
    .orderBy(asc(person.fullName))
    .limit(50)

  const byPerson = new Map<string, UnclaimedProfile>()
  for (const row of rows) {
    const item = byPerson.get(row.personId) ?? {
      personId: row.personId,
      fullName: row.fullName,
      cohortYears: [],
    }
    if (row.startYear !== null) item.cohortYears.push(row.startYear)
    byPerson.set(row.personId, item)
  }
  return [...byPerson.values()].slice(0, 10)
}

/**
 * Kobler en ventende konto til en eksisterende profil, for når e-posten i
 * kullisten ikke stemmer med e-posten personen registrerte seg med. Den tomme
 * personen som ble opprettet ved registreringen slettes, og kontoen arver
 * profilens kull og medlemskap.
 */
export async function linkAccountToProfile(
  db: Db,
  viewer: Viewer,
  input: { pendingPersonId: string; profilePersonId: string },
): Promise<void> {
  assertAdmin(viewer)
  if (input.pendingPersonId === input.profilePersonId) {
    throw new DomainError('Velg en annen profil.')
  }

  await db.transaction(async (tx) => {
    const [pending] = await tx
      .select({ userId: person.userId, status: membership.status })
      .from(person)
      .innerJoin(membership, eq(membership.personId, person.id))
      .where(eq(person.id, input.pendingPersonId))
      .for('update')
    if (!pending?.userId || pending.status !== 'pending') {
      throw new DomainError('Fant ikke en ventende konto å koble.')
    }
    const cohorts = await tx
      .select({ cohortId: personCohort.cohortId })
      .from(personCohort)
      .where(eq(personCohort.personId, input.pendingPersonId))
    if (cohorts.length > 0) {
      throw new DomainError('Kontoen har allerede kulldata og kan ikke slås sammen automatisk.')
    }

    const [profile] = await tx
      .select({ userId: person.userId })
      .from(person)
      .where(eq(person.id, input.profilePersonId))
      .for('update')
    if (!profile) throw new DomainError('Fant ikke profilen.')
    if (profile.userId) throw new DomainError('Profilen er allerede tatt i bruk av en annen konto.')

    // Revisjonsloggen peker på profilen, ikke på den tomme personen som slettes.
    await tx.delete(person).where(eq(person.id, input.pendingPersonId))
    await tx
      .update(person)
      .set({ userId: pending.userId, claimedAt: new Date() })
      .where(eq(person.id, input.profilePersonId))
    await tx.insert(membership).values({ personId: input.profilePersonId }).onConflictDoNothing()
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'profile.link',
      subjectPersonId: input.profilePersonId,
      details: { userId: pending.userId },
    })
  })
}

/**
 * Første admin (og senere nye admins) gis kun av en lokal operatør med direkte
 * databasetilgang, via `pnpm admin:grant`. Krever at kontoen finnes og har
 * bekreftet e-post, så ingen kan få admin bare ved å registrere en adresse.
 */
export async function grantAdminAsOperator(
  db: Db,
  input: { email: string; reason: string },
): Promise<{ personId: string; fullName: string }> {
  const email = normalizeEmail(input.email)
  const [account] = await db.select().from(user).where(eq(user.email, email))
  if (!account) throw new DomainError(`Fant ingen konto med e-post ${email}.`)
  if (!account.emailVerified) {
    throw new DomainError('Kontoen har ikke bekreftet e-postadressen sin ennå.')
  }

  return db.transaction(async (tx) => {
    const personId = await ensurePersonForVerifiedUser(tx, account)
    await tx
      .update(membership)
      .set({ status: 'active', role: 'admin', decidedAt: new Date(), decidedByPersonId: null })
      .where(eq(membership.personId, personId))
    await tx.insert(auditEvent).values({
      actorPersonId: null,
      action: 'operator.grant_admin',
      subjectPersonId: personId,
      details: { reason: input.reason },
    })
    return { personId, fullName: account.name }
  })
}
