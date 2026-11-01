import { schema, type BoardRole, type Db } from '@esaf/db'
import { and, asc, eq, ilike, inArray, isNull, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { assertCan, assertMember, type Viewer } from './access.ts'
import { currentBoardRole, loadBoardTerms } from './board.ts'
import { currentRepresentativeOf, loadRepresentativeTerms } from './cohort-reps.ts'
import { DomainError } from './errors.ts'
import { currentRole, loadExperience, type Experience } from './experience.ts'
import { photoUrls, type ProfilePhoto } from './photos.ts'
import { deleteFieldSources } from './sources.ts'

const {
  accessRequest,
  auditEvent,
  cohort,
  company,
  experience,
  membership,
  person,
  personCohort,
  passkey,
  personEmail,
  user,
} = schema

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/**
 * Kjører spørringene etter hverandre. For spørringer som også kjører inne i en
 * transaksjon: én tilkobling kan bare ha én spørring om gangen.
 */
export async function inOrder<T extends readonly (() => PromiseLike<unknown>)[]>(
  queries: T,
): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const results: unknown[] = []
  for (const query of queries) results.push(await query())
  return results as { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }
}

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}

/**
 * Nøkkel for å kjenne igjen samme adresse skrevet ulikt. Gmail ser bort fra
 * punktum og alt etter +, så de regnes som samme adresse.
 */
export function emailKey(email: string) {
  const [local = '', domain = ''] = email.trim().toLowerCase().split('@')
  const base = local.split('+')[0]!
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    return `${base.replace(/\./g, '')}@gmail.com`
  }
  return `${base}@${domain}`
}

/**
 * Sørger for at en konto med bekreftet e-post har en person og et medlemskap.
 * En ny konto får alltid sin egen person med `pending` medlemskap, også når
 * adressen står på en profil fra kullisten: kontoen kobles til profilen først når
 * en admin har godkjent forespørselen om tilgang. Kan aldri gi adminrett.
 */
export async function ensurePersonForVerifiedUser(
  tx: Tx,
  account: { id: string; name: string; email: string },
): Promise<string> {
  const [linked] = await tx
    .select({ id: person.id })
    .from(person)
    .where(eq(person.userId, account.id))
  if (linked) return linked.id

  // To samtidige forespørsler fra en ny konto skal ikke gi to personer.
  const [created] = await tx
    .insert(person)
    .values({ fullName: account.name, userId: account.id, claimedAt: new Date() })
    .onConflictDoNothing({ target: person.userId })
    .returning({ id: person.id })
  if (!created) {
    const [winner] = await tx
      .select({ id: person.id })
      .from(person)
      .where(eq(person.userId, account.id))
    return winner!.id
  }
  await tx.insert(membership).values({ personId: created.id })
  // Står adressen allerede på en profil fra kullisten, blir den der.
  await tx
    .insert(personEmail)
    .values({ email: normalizeEmail(account.email), personId: created.id, source: 'signup' })
    .onConflictDoNothing()
  return created.id
}

/**
 * Bygger `Viewer` for en innlogget bruker. Kalles på serveren for hver
 * forespørsel, med økten fra Better Auth. Uten økt regnes innloggingen som
 * vanlig (ikke passkey), som er det trygge valget.
 */
export async function loadViewer(
  db: Db,
  userId: string,
  session: { signedInWithPasskey?: boolean | null } = {},
): Promise<Viewer> {
  const [[account], [anyPasskey]] = await Promise.all([
    db
      .select({
        emailVerified: user.emailVerified,
        id: user.id,
        name: user.name,
        email: user.email,
        twoFactorEnabled: user.twoFactorEnabled,
      })
      .from(user)
      .where(eq(user.id, userId)),
    db.select({ id: passkey.id }).from(passkey).where(eq(passkey.userId, userId)).limit(1),
  ])
  if (!account) return null
  const factors = {
    twoFactorEnabled: account.twoFactorEnabled,
    passkeySession: session.signedInWithPasskey === true,
    hasPasskey: anyPasskey !== undefined,
  }
  if (!account.emailVerified) {
    return { userId, emailVerified: false, ...factors, personId: null, membership: null }
  }

  const personId = await db.transaction((tx) => ensurePersonForVerifiedUser(tx, account))
  const [m] = await db
    .select({ status: membership.status, role: membership.role })
    .from(membership)
    .where(eq(membership.personId, personId))
  return { userId, emailVerified: true, ...factors, personId, membership: m ?? null }
}

export type MemberListItem = {
  personId: string
  fullName: string
  photo: ProfilePhoto | null
  /** `true` når personen selv har tatt i bruk profilen med en bekreftet konto. */
  claimed: boolean
  /** Fra den øverste nåværende erfaringen. */
  jobTitle: string | null
  currentCompany: string | null
  city: string | null
  studyBackground: string | null
  esCompany: string | null
  expertise: string[]
  industries: string[]
  /** Nåværende og tidligere selskaper, nyeste først. */
  experience: Pick<Experience, 'company' | 'title' | 'endYear' | 'founder'>[]
  cohorts: { graduationYear: number; relation: schema.CohortRelation }[]
  /** Kullene personen er kullrepresentant for nå. */
  representativeOf: number[]
  /** Rollen i styret nå, ellers null. */
  boardRole: BoardRole | null
}

/**
 * Subspørring med alle personer i et kull, uansett tilknytning (student, ansatt,
 * mentor). Tabellene har egne navn, så de ikke blandes med tabellene rundt.
 */
export function personIdsInCohort(db: Db, graduationYear: number) {
  const inCohort = alias(personCohort, 'in_cohort')
  const ofYear = alias(cohort, 'of_year')
  return db
    .select({ personId: inCohort.personId })
    .from(inCohort)
    .innerJoin(ofYear, eq(ofYear.id, inCohort.cohortId))
    .where(eq(ofYear.graduationYear, graduationYear))
}

/**
 * Medlemskatalogen: alle med aktivt medlemskap, både verifiserte brukere og
 * profiler fra kullisten som ikke er tatt i bruk ennå. Kun for aktive
 * medlemmer, og viser bevisst ikke kontaktinfo ennå. Med `cohortYear` bare
 * personene i det kullet (med alle kullene deres).
 */
export async function listActiveMembers(
  db: Db,
  viewer: Viewer,
  options: { cohortYear?: number } = {},
): Promise<MemberListItem[]> {
  assertMember(viewer)
  const inCohort =
    options.cohortYear === undefined
      ? undefined
      : inArray(person.id, personIdsInCohort(db, options.cohortYear))
  const rows = await db
    .select({
      personId: person.id,
      fullName: person.fullName,
      photoKey: person.photoKey,
      userId: person.userId,
      city: person.city,
      studyBackground: person.studyBackground,
      esCompany: company.name,
      expertise: person.expertise,
      industries: person.industries,
      graduationYear: cohort.graduationYear,
      relation: personCohort.relation,
    })
    .from(membership)
    .innerJoin(person, eq(person.id, membership.personId))
    .leftJoin(company, eq(company.id, person.esCompanyId))
    .leftJoin(personCohort, eq(personCohort.personId, person.id))
    .leftJoin(cohort, eq(cohort.id, personCohort.cohortId))
    .where(and(eq(membership.status, 'active'), inCohort))
    .orderBy(asc(person.fullName), asc(cohort.graduationYear))
  const ids = rows.map((r) => r.personId)
  const [experiences, terms, boardTerms] = await Promise.all([
    loadExperience(db, ids),
    loadRepresentativeTerms(db, ids),
    loadBoardTerms(db, ids),
  ])

  const byPerson = new Map<string, MemberListItem>()
  for (const row of rows) {
    const roles = experiences.get(row.personId) ?? []
    const item = byPerson.get(row.personId) ?? {
      personId: row.personId,
      fullName: row.fullName,
      photo: photoUrls(row.photoKey),
      claimed: row.userId !== null,
      ...currentRole(roles),
      city: row.city,
      studyBackground: row.studyBackground,
      esCompany: row.esCompany,
      expertise: row.expertise,
      industries: row.industries,
      experience: roles.map(({ company, title, endYear, founder }) => ({
        company,
        title,
        endYear,
        founder,
      })),
      cohorts: [],
      representativeOf: currentRepresentativeOf(terms.get(row.personId)),
      boardRole: currentBoardRole(boardTerms.get(row.personId)),
    }
    if (row.graduationYear !== null && row.relation !== null) {
      item.cohorts.push({ graduationYear: row.graduationYear, relation: row.relation })
    }
    byPerson.set(row.personId, item)
  }
  return [...byPerson.values()]
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
  assertCan(viewer, 'members.review')
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
  /**
   * Fra telefonlista, så admin kan ringe og sjekke at en søker er den de sier.
   * Admin ser nummeret også når det er skjult for medlemmer (`phoneHidden`).
   */
  phone: string | null
  phoneHidden: boolean
}

/** Søk blant profiler ingen har tatt i bruk, for å koble en konto manuelt. */
export async function searchUnclaimedProfiles(
  db: Db,
  viewer: Viewer,
  query: string,
): Promise<UnclaimedProfile[]> {
  assertCan(viewer, 'members.review')
  const q = query.trim()
  if (q.length < 2) return []
  const rows = await db
    .select({
      personId: person.id,
      fullName: person.fullName,
      phone: person.phone,
      phoneVisible: person.phoneVisible,
      year: cohort.graduationYear,
    })
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
      phone: row.phone,
      phoneHidden: row.phone !== null && !row.phoneVisible,
    }
    if (row.year !== null) item.cohortYears.push(row.year)
    byPerson.set(row.personId, item)
  }
  return [...byPerson.values()].slice(0, 10)
}

/**
 * Kobler kontoen bak en ventende person til en profil ingen har tatt i bruk.
 * Den tomme personen fra registreringen slettes, og kontoen arver profilens
 * kull og medlemskap. Kalles inne i en transaksjon av noe som har sjekket tilgang.
 */
export async function linkAccountInTx(
  tx: Tx,
  input: { pendingPersonId: string; profilePersonId: string },
): Promise<string> {
  if (input.pendingPersonId === input.profilePersonId) {
    throw new DomainError('Velg en annen profil.')
  }
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
  // Kontoens e-post flyttes til profilen (cascade ville ellers slettet den).
  await tx
    .update(personEmail)
    .set({ personId: input.profilePersonId })
    .where(eq(personEmail.personId, input.pendingPersonId))
  await tx.delete(person).where(eq(person.id, input.pendingPersonId))
  await deleteFieldSources(tx, 'person', [input.pendingPersonId])
  await tx
    .update(person)
    .set({ userId: pending.userId, claimedAt: new Date() })
    .where(eq(person.id, input.profilePersonId))
  await tx.insert(membership).values({ personId: input.profilePersonId }).onConflictDoNothing()
  return pending.userId
}

/**
 * Kobler en ventende konto til en eksisterende profil, for når e-posten i
 * kullisten ikke stemmer med e-posten personen registrerte seg med.
 */
export async function linkAccountToProfile(
  db: Db,
  viewer: Viewer,
  input: { pendingPersonId: string; profilePersonId: string },
): Promise<void> {
  assertCan(viewer, 'members.review')
  await db.transaction(async (tx) => {
    const userId = await linkAccountInTx(tx, input)
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'profile.link',
      subjectPersonId: input.profilePersonId,
      details: { userId },
    })
  })
}

export type PersonHit = {
  personId: string
  fullName: string
  photo: ProfilePhoto | null
  claimed: boolean
  jobTitle: string | null
  currentCompany: string | null
  /** Kullene personen er kullrepresentant for nå. */
  representativeOf: number[]
  /** Rollen i styret nå, ellers null. */
  boardRole: BoardRole | null
}

/**
 * Rask søk etter aktive medlemmer på navn, nåværende og tidligere selskaper og
 * stillinger, by, studieretning, ES-selskap, ekspertise og bransjer.
 */
export async function searchPeople(
  db: Db,
  viewer: Viewer,
  query: string,
  limit = 6,
): Promise<PersonHit[]> {
  assertMember(viewer)
  const words = query.trim().split(/\s+/).filter(Boolean).slice(0, 5)
  if (!words.length) return []
  const roles = sql`(select string_agg(concat_ws(' ', ${company.name}, ${experience.title}), ' ') from ${experience} inner join ${company} on ${company.id} = ${experience.companyId} where ${experience.personId} = ${sql.raw('"person"."id"')})`
  const esCompany = sql`(select ${company.name} from ${company} where ${company.id} = ${person.esCompanyId})`
  const haystack = sql`concat_ws(' ', ${person.fullName}, ${person.city}, ${person.studyBackground}, ${esCompany}, array_to_string(${person.expertise}, ' '), array_to_string(${person.industries}, ' '), ${roles})`
  const rows = await db
    .select({
      personId: person.id,
      fullName: person.fullName,
      photoKey: person.photoKey,
      userId: person.userId,
    })
    .from(person)
    .innerJoin(membership, eq(membership.personId, person.id))
    .where(
      and(
        eq(membership.status, 'active'),
        ...words.map((w) => sql`${haystack} ilike ${`%${w.replace(/[%_\\]/g, '\\$&')}%`}`),
      ),
    )
    .orderBy(sql`${person.userId} is null`, asc(person.fullName))
    .limit(limit)
  const ids = rows.map((r) => r.personId)
  const [experiences, terms, boardTerms] = await Promise.all([
    loadExperience(db, ids),
    loadRepresentativeTerms(db, ids),
    loadBoardTerms(db, ids),
  ])
  return rows.map(({ userId, photoKey, ...r }) => ({
    ...r,
    photo: photoUrls(photoKey),
    ...currentRole(experiences.get(r.personId) ?? []),
    claimed: userId !== null,
    representativeOf: currentRepresentativeOf(terms.get(r.personId)),
    boardRole: currentBoardRole(boardTerms.get(r.personId)),
  }))
}

/** Navn, stilling og hvor langt den innloggede har kommet, til menyen og rutevaktene. */
export async function viewerCard(db: Db, viewer: Viewer) {
  if (!viewer?.personId) return null
  const [row] = await db
    .select({
      fullName: person.fullName,
      photoKey: person.photoKey,
      onboardedAt: person.onboardedAt,
    })
    .from(person)
    .where(eq(person.id, viewer.personId))
  if (!row) return null
  const [[request], [account], experiences] = await Promise.all([
    db
      .select({ status: accessRequest.status })
      .from(accessRequest)
      .where(eq(accessRequest.userId, viewer.userId)),
    db.select({ email: user.email }).from(user).where(eq(user.id, viewer.userId)),
    loadExperience(db, [viewer.personId]),
  ])
  return {
    fullName: row.fullName,
    photo: photoUrls(row.photoKey),
    email: account?.email ?? null,
    onboarded: row.onboardedAt !== null,
    requestStatus: request?.status ?? null,
    ...currentRole(experiences.get(viewer.personId) ?? []),
  }
}
