import { schema, type AccessRequestStatus, type Db, type MemberRole } from '@esaf/db'
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { accessLevel, assertCan, assertMember, type Viewer } from './access.ts'
import { AccessDeniedError, DomainError } from './errors.ts'
import { ensurePersonForVerifiedUser, linkAccountInTx, normalizeEmail, type Tx } from './members.ts'
import { notifyMemberApproved } from './notifications.ts'
import { normalizeLinkedinUrl } from './profiles.ts'

const { accessRequest, auditEvent, cohort, membership, person, personCohort, personEmail, user } =
  schema

/**
 * Tilgang til ESAF krever at en admin godkjenner en forespørsel. Ingenting skjer
 * automatisk, heller ikke for dem som står i kullisten:
 *
 * 1. Kontoen bekrefter e-postadressen (beviser at personen leser den innboksen).
 * 2. Personen forteller hvem de er. Står kontoens adresse på en profil fra
 *    kullisten, kan de velge den. Andres profiler vises aldri for søkere.
 * 3. En admin ser hva som er bevist og godkjenner eller avslår. Bekreftet
 *    adresse fra lista er et sterkt tegn. Navn, kull, telefon og LinkedIn kan
 *    hvem som helst med lista skrive inn, så de er bare til hjelp.
 */

/** En profil fra kullisten. */
export type ProfileRef = { personId: string; fullName: string; years: number[] }

export type AccessState = {
  email: string
  /** Profilen med kontoens e-postadresse som ingen har tatt i bruk, hvis den finnes. */
  match: ProfileRef | null
  request: {
    status: AccessRequestStatus
    fullName: string
    graduationYear: number | null
    linkedinUrl: string | null
    note: string | null
    profile: ProfileRef | null
    createdAt: Date
  } | null
}

/** Innlogget med bekreftet e-post, uansett medlemskap. */
function assertVerified(
  viewer: Viewer,
): asserts viewer is NonNullable<Viewer> & { personId: string } {
  if (!viewer) throw new AccessDeniedError('unauthenticated')
  if (!viewer.emailVerified || !viewer.personId) throw new AccessDeniedError('not_member')
}

async function accountEmail(db: Db | Tx, userId: string) {
  const [account] = await db.select({ email: user.email }).from(user).where(eq(user.id, userId))
  return normalizeEmail(account!.email)
}

/** Profiler som har adressen i kullisten og ikke er tatt i bruk. */
async function profilesWithEmail(db: Db | Tx, email: string) {
  const rows = await db
    .select({ id: person.id })
    .from(personEmail)
    .innerJoin(person, eq(person.id, personEmail.personId))
    .where(and(eq(personEmail.email, email), isNull(person.userId)))
  return rows.map((r) => r.id)
}

async function profileRefs(db: Db | Tx, ids: string[]) {
  const unique = [...new Set(ids)]
  if (!unique.length)
    return new Map<string, ProfileRef & { claimed: boolean; phone: string | null }>()
  const [people, years] = await Promise.all([
    db
      .select({
        personId: person.id,
        fullName: person.fullName,
        userId: person.userId,
        phone: person.phone,
      })
      .from(person)
      .where(inArray(person.id, unique)),
    db
      .select({ personId: personCohort.personId, year: cohort.graduationYear })
      .from(personCohort)
      .innerJoin(cohort, eq(cohort.id, personCohort.cohortId))
      .where(inArray(personCohort.personId, unique)),
  ])
  return new Map(
    people.map((p) => [
      p.personId,
      {
        personId: p.personId,
        fullName: p.fullName,
        years: years
          .filter((y) => y.personId === p.personId)
          .map((y) => y.year)
          .sort(),
        claimed: p.userId !== null,
        phone: p.phone,
      },
    ]),
  )
}

const publicRef = (ref: ProfileRef | undefined): ProfileRef | null =>
  ref ? { personId: ref.personId, fullName: ref.fullName, years: ref.years } : null

/** Hvor langt den innloggede har kommet. Viser bare profilen som hører til kontoens egen adresse. */
export async function getAccessState(db: Db, viewer: Viewer): Promise<AccessState> {
  assertVerified(viewer)
  const email = await accountEmail(db, viewer.userId)
  const [[request], matches] = await Promise.all([
    db.select().from(accessRequest).where(eq(accessRequest.userId, viewer.userId)),
    profilesWithEmail(db, email),
  ])
  const refs = await profileRefs(db, [
    ...matches.slice(0, 1),
    ...(request?.profilePersonId ? [request.profilePersonId] : []),
  ])
  return {
    email,
    match: publicRef(refs.get(matches[0] ?? '')),
    request: request
      ? {
          status: request.status,
          fullName: request.fullName,
          graduationYear: request.graduationYear,
          linkedinUrl: request.linkedinUrl,
          note: request.note,
          profile: publicRef(refs.get(request.profilePersonId ?? '')),
          createdAt: request.createdAt,
        }
      : null,
  }
}

const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Maks ${max} tegn.`)
    .transform((v) => (v === '' ? null : v))

export const accessRequestInput = z.object({
  /** Profilen personen sier er dem. Må ha kontoens egen e-postadresse. */
  profilePersonId: z.uuid().nullable(),
  fullName: z.string().trim().min(2, 'Skriv inn fullt navn.').max(120, 'Maks 120 tegn.'),
  graduationYear: z.number().int().min(1990).max(2100).nullable(),
  linkedinUrl: optional(300).transform((v, ctx) => {
    if (v === null) return null
    const url = normalizeLinkedinUrl(v)
    if (!url) {
      ctx.addIssue({ code: 'custom', message: 'Må være en lenke til en LinkedIn-profil.' })
      return z.NEVER
    }
    return url
  }),
  note: optional(500),
})

export type AccessRequestInput = z.input<typeof accessRequestInput>

/** Sender eller oppdaterer forespørselen om tilgang. */
export async function submitAccessRequest(
  db: Db,
  viewer: Viewer,
  input: AccessRequestInput,
): Promise<void> {
  assertVerified(viewer)
  if (accessLevel(viewer) !== 'pending') throw new DomainError('Du har allerede tilgang.')
  const parsed = accessRequestInput.safeParse(input)
  if (!parsed.success) throw new DomainError(parsed.error.issues[0]?.message ?? 'Ugyldige felt.')
  const data = parsed.data
  const email = await accountEmail(db, viewer.userId)
  if (
    data.profilePersonId &&
    !(await profilesWithEmail(db, email)).includes(data.profilePersonId)
  ) {
    throw new DomainError(
      'Du kan bare velge profilen som har e-postadressen din. Står du i lista med en annen adresse, finner styret deg.',
    )
  }

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ status: accessRequest.status })
      .from(accessRequest)
      .where(eq(accessRequest.userId, viewer.userId))
      .for('update')
    if (existing?.status === 'rejected') {
      throw new DomainError(
        'Forespørselen din er avslått. Ta kontakt med ESAF-styret om du mener det er feil.',
      )
    }
    if (existing?.status === 'approved') throw new DomainError('Du har allerede tilgang.')
    await tx
      .insert(accessRequest)
      .values({ userId: viewer.userId, ...data })
      .onConflictDoUpdate({ target: accessRequest.userId, set: data })
    await tx.update(person).set({ fullName: data.fullName }).where(eq(person.id, viewer.personId))
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'access.request',
      subjectPersonId: viewer.personId,
      details: { profilePersonId: data.profilePersonId },
    })
  })
}

/** En profil fra kullisten slik admin ser den når en forespørsel vurderes. */
export type CandidateProfile = ProfileRef & {
  claimed: boolean
  /** Fra telefonlista, så admin kan ringe og sjekke at det er personen selv. */
  phone: string | null
}

export type AccessRequestView = {
  id: string
  status: AccessRequestStatus
  createdAt: Date
  decidedAt: Date | null
  fullName: string
  graduationYear: number | null
  linkedinUrl: string | null
  note: string | null
  /** Kontoens bekreftede e-postadresse. */
  email: string
  /** Profilen personen sier er dem. */
  profile: CandidateProfile | null
  /** Sterk: den bekreftede adressen står på den valgte profilen i kullisten. */
  emailOnProfile: boolean
  /** Profiler med likt navn (samme kull først), når personen ikke fant seg selv. */
  suggestions: CandidateProfile[]
}

const fold = (s: string) => s.toLocaleLowerCase('nb').normalize('NFD').replace(/[̀-ͯ]/g, '')
const words = (s: string) =>
  fold(s)
    .split(/[\s-]+/)
    .filter((w) => w.length > 1)

/** Forespørsler til admin, med det som er bevist og forslag til hvem det kan være. */
export async function listAccessRequests(
  db: Db,
  viewer: Viewer,
  status: AccessRequestStatus = 'open',
): Promise<AccessRequestView[]> {
  assertCan(viewer, 'members.review')
  const rows = await db
    .select({ request: accessRequest, email: user.email })
    .from(accessRequest)
    .innerJoin(user, eq(user.id, accessRequest.userId))
    .where(eq(accessRequest.status, status))
    .orderBy(status === 'open' ? asc(accessRequest.createdAt) : desc(accessRequest.decidedAt))
    .limit(100)
  if (!rows.length) return []

  // Navnelikhet regnes ut her, ikke i SQL, så «Schüller» også treffer «Schuller».
  const unclaimed = rows.some((r) => !r.request.profilePersonId)
    ? await db
        .select({ id: person.id, fullName: person.fullName })
        .from(person)
        .where(isNull(person.userId))
    : []
  const suggestionIds = new Map<string, string[]>()
  for (const { request } of rows) {
    if (request.profilePersonId) continue
    const wanted = words(request.fullName)
    const scored = unclaimed
      .map((p) => {
        const have = words(p.fullName)
        return { id: p.id, score: wanted.filter((w) => have.includes(w)).length }
      })
      .filter((p) => p.score >= Math.min(2, wanted.length))
      .sort((a, b) => b.score - a.score)
    suggestionIds.set(
      request.id,
      scored.slice(0, 8).map((p) => p.id),
    )
  }

  const chosen = rows.flatMap((r) => (r.request.profilePersonId ? [r.request.profilePersonId] : []))
  const [refs, onProfile] = await Promise.all([
    profileRefs(db, [...chosen, ...[...suggestionIds.values()].flat()]),
    chosen.length
      ? db
          .select({ email: personEmail.email, personId: personEmail.personId })
          .from(personEmail)
          .where(inArray(personEmail.personId, chosen))
      : [],
  ])

  return rows.map(({ request, email }) => {
    const address = normalizeEmail(email)
    const year = request.graduationYear
    return {
      id: request.id,
      status: request.status,
      createdAt: request.createdAt,
      decidedAt: request.decidedAt,
      fullName: request.fullName,
      graduationYear: year,
      linkedinUrl: request.linkedinUrl,
      note: request.note,
      email: address,
      profile: refs.get(request.profilePersonId ?? '') ?? null,
      emailOnProfile: onProfile.some(
        (e) => e.personId === request.profilePersonId && e.email === address,
      ),
      suggestions: (suggestionIds.get(request.id) ?? [])
        .map((id) => refs.get(id)!)
        .sort(
          (a, b) =>
            Number(year !== null && b.years.includes(year)) -
            Number(year !== null && a.years.includes(year)),
        )
        .slice(0, 4),
    }
  })
}

type RequestRow = typeof accessRequest.$inferSelect

/**
 * Godkjenner inne i en transaksjon. Med en profil kobles kontoen til den og får
 * profilens kull; ellers blir personen fra registreringen medlem i oppgitt kull.
 */
async function approveInTx(
  tx: Tx,
  request: RequestRow,
  applicantPersonId: string,
  profilePersonId: string | null,
  actorPersonId: string | null,
): Promise<string> {
  const decided = { decidedAt: new Date(), decidedByPersonId: actorPersonId }
  let personId = applicantPersonId
  if (profilePersonId) {
    await linkAccountInTx(tx, { pendingPersonId: applicantPersonId, profilePersonId })
    personId = profilePersonId
    if (request.linkedinUrl) {
      const [profile] = await tx
        .select({ linkedinUrl: person.linkedinUrl })
        .from(person)
        .where(eq(person.id, personId))
      if (!profile?.linkedinUrl) {
        await tx
          .update(person)
          .set({ linkedinUrl: request.linkedinUrl })
          .where(eq(person.id, personId))
      }
    }
  } else {
    await tx
      .update(person)
      .set({ fullName: request.fullName, linkedinUrl: request.linkedinUrl })
      .where(eq(person.id, personId))
    if (request.graduationYear) {
      await tx
        .insert(cohort)
        .values({ graduationYear: request.graduationYear })
        .onConflictDoNothing()
      const [c] = await tx
        .select({ id: cohort.id })
        .from(cohort)
        .where(eq(cohort.graduationYear, request.graduationYear))
      await tx.insert(personCohort).values({ personId, cohortId: c!.id }).onConflictDoNothing()
    }
  }
  // Også en profil kullisten importerte som ventende blir aktiv: admin har nå godkjent personen.
  await tx
    .update(membership)
    .set({ status: 'active', ...decided })
    .where(eq(membership.personId, personId))
  await tx
    .update(accessRequest)
    .set({ status: 'approved', profilePersonId, ...decided })
    .where(eq(accessRequest.id, request.id))
  // Først nå er personen aktiv, koblet til profilen og i riktig kull.
  await notifyMemberApproved(tx, personId)
  return personId
}

/**
 * Admin godkjenner eller avslår. Ved godkjenning kan admin velge en annen profil
 * enn den personen valgte (`profilePersonId`), eller ingen (`null`).
 */
export async function decideAccessRequest(
  db: Db,
  viewer: Viewer,
  input: { requestId: string; decision: 'approve' | 'reject'; profilePersonId?: string | null },
): Promise<void> {
  assertCan(viewer, 'members.review')
  await db.transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(accessRequest)
      .where(eq(accessRequest.id, input.requestId))
      .for('update')
    if (!request || request.status !== 'open')
      throw new DomainError('Fant ikke en åpen forespørsel.')
    const [applicant] = await tx
      .select({ id: person.id })
      .from(person)
      .where(eq(person.userId, request.userId))
    if (!applicant) throw new DomainError('Fant ikke kontoen bak forespørselen.')
    if (applicant.id === viewer.personId) {
      throw new DomainError('Du kan ikke behandle din egen forespørsel.')
    }

    if (input.decision === 'reject') {
      const decided = { decidedAt: new Date(), decidedByPersonId: viewer.personId }
      await tx
        .update(membership)
        .set({ status: 'inactive', ...decided })
        .where(eq(membership.personId, applicant.id))
      await tx
        .update(accessRequest)
        .set({ status: 'rejected', ...decided })
        .where(eq(accessRequest.id, request.id))
      await tx.insert(auditEvent).values({
        actorPersonId: viewer.personId,
        action: 'access.reject',
        subjectPersonId: applicant.id,
        details: { requestId: request.id },
      })
      return
    }

    const profilePersonId =
      input.profilePersonId === undefined ? request.profilePersonId : input.profilePersonId
    const personId = await approveInTx(tx, request, applicant.id, profilePersonId, viewer.personId)
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'access.approve',
      subjectPersonId: personId,
      details: { requestId: request.id, profilePersonId },
    })
  })
}

/**
 * Rolle gitt av en lokal operatør med direkte databasetilgang, via
 * `pnpm admin:grant`. Brukes til første hovedadmin; senere roller gis i appen.
 * Krever at kontoen finnes og har bekreftet e-post. Har kontoen en åpen
 * forespørsel, godkjennes den samtidig, så kontoen kobles til profilen personen
 * valgte fra kullisten.
 */
export async function grantRoleAsOperator(
  db: Db,
  input: { email: string; reason: string; role?: MemberRole },
): Promise<{ personId: string; fullName: string; role: MemberRole }> {
  const role = input.role ?? 'owner'
  const email = normalizeEmail(input.email)
  const [account] = await db.select().from(user).where(eq(user.email, email))
  if (!account) throw new DomainError(`Fant ingen konto med e-post ${email}.`)
  if (!account.emailVerified) {
    throw new DomainError('Kontoen har ikke bekreftet e-postadressen sin ennå.')
  }

  return db.transaction(async (tx) => {
    let personId = await ensurePersonForVerifiedUser(tx, account)
    const [request] = await tx
      .select()
      .from(accessRequest)
      .where(and(eq(accessRequest.userId, account.id), eq(accessRequest.status, 'open')))
      .for('update')
    if (request) personId = await approveInTx(tx, request, personId, request.profilePersonId, null)
    await tx
      .update(membership)
      .set({ status: 'active', role, decidedAt: new Date(), decidedByPersonId: null })
      .where(eq(membership.personId, personId))
    await tx.insert(auditEvent).values({
      actorPersonId: null,
      action: 'operator.grant_role',
      subjectPersonId: personId,
      details: { role, reason: input.reason, approvedRequest: request?.id ?? null },
    })
    const [p] = await tx
      .select({ fullName: person.fullName })
      .from(person)
      .where(eq(person.id, personId))
    return { personId, fullName: p!.fullName, role }
  })
}

/** Markerer at et nytt medlem er ferdig med (eller hoppet over) velkomststegene. */
export async function finishOnboarding(db: Db, viewer: Viewer): Promise<void> {
  assertMember(viewer)
  await db.update(person).set({ onboardedAt: new Date() }).where(eq(person.id, viewer.personId))
}
