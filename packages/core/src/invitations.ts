import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { schema, type Db, type InvitationKind, type MemberRole } from '@esaf/db'
import { and, desc, eq, gt, inArray, isNull } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { z } from 'zod'
import { assertCan, roleAtLeast, roles, type Viewer } from './access.ts'
import { AccessDeniedError, DomainError, NotFoundError } from './errors.ts'
import { ensurePersonForVerifiedUser, linkAccountInTx, normalizeEmail, type Tx } from './members.ts'
import { notifyMemberApproved } from './notifications.ts'

const {
  accessRequest,
  account,
  auditEvent,
  cohort,
  invitation,
  membership,
  passkey,
  person,
  personCohort,
  personEmail,
  session,
  twoFactor,
  user,
} = schema

/**
 * Invitasjoner og lenker for nytt passord. En admin lager en lenke. Med
 * e-postleverandør sendes den på e-post til adressen; uten deler admin den selv
 * (SMS, Messenger, muntlig). Med e-post kan man også be om en lenke for nytt
 * passord selv (`requestPasswordReset`). Reglene:
 *
 * - Å kjenne en e-postadresse gir aldri tilgang. Lenken er det som gir tilgang:
 *   den har et tilfeldig token på 256 bit, og bare SHA-256 av tokenet lagres.
 *   Tokenet vises én gang, når lenken lages. Oppslag skjer på hashen, så tokenet
 *   aldri sammenlignes tegn for tegn.
 * - En lenke er bundet til én e-postadresse, virker én gang og går ut etter sju
 *   dager. Den kan trekkes tilbake. En ny lenke til samme adresse erstatter den
 *   forrige.
 * - Å ha lenken regnes som bekreftet e-post: admin har sendt den til personen
 *   bak adressen. Avveiingen er at den som får tak i lenken før personen selv,
 *   kommer inn i stedet. Derfor er lenken kortlivet, virker én gang, vises i
 *   oversikten med status, og kan trekkes tilbake.
 * - Admins inviterer medlemmer. Bare hovedadmins kan invitere med en rolle
 *   (moderator, admin eller hovedadmin), som når roller gis i appen.
 * - Lenker for nytt passord følger reglene for deaktivering: admins for
 *   medlemmer og moderatorer, hovedadmins også for admins og hovedadmins, aldri
 *   en selv. Alle økter logges ut. Tofaktor og passkeys røres ikke, så lenken
 *   kan ikke brukes til å komme forbi tofaktor.
 * - «Glemt passord?»: lenken sendes bare til adressen kontoen har, går ut etter
 *   en time, og svaret er det samme om kontoen finnes eller ikke. Den erstatter
 *   en ventende lenke for nytt passord til samme adresse, også en admin har
 *   laget: den nye virker og er den personen nettopp ba om. Én forespørsel per
 *   adresse hvert andre minutt; deaktiverte kontoer får ingen lenke.
 * - Alt logges: `invitation.*` og `password_link.*`.
 */

/** Hvor lenge en lenke virker. */
export const INVITATION_TTL_DAYS = 7
const INVITATION_TTL_MS = INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000

/** Hvor lenge en lenke for nytt passord man har bedt om selv, virker. */
export const PASSWORD_REQUEST_TTL_MINUTES = 60

/** Hvor ofte man kan be om en ny lenke for nytt passord til samme adresse. */
export const PASSWORD_REQUEST_INTERVAL_MINUTES = 2

/** SHA-256 av tokenet, som hex. Det er bare dette som lagres. */
export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** 256 bit fra den kryptografiske tilfeldighetskilden, som base64url (43 tegn). */
function newToken() {
  return randomBytes(32).toString('base64url')
}

/** Tokenet har alltid denne formen. Alt annet avvises uten oppslag. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export type InvitationStatus = 'pending' | 'used' | 'expired' | 'revoked'

function statusOf(
  row: { usedAt: Date | null; revokedAt: Date | null; expiresAt: Date },
  now = new Date(),
): InvitationStatus {
  if (row.usedAt) return 'used'
  if (row.revokedAt) return 'revoked'
  if (row.expiresAt <= now) return 'expired'
  return 'pending'
}

export type InvitationErrorCode =
  | 'not_found'
  | 'used'
  | 'expired'
  | 'revoked'
  | 'account_exists'
  | 'wrong_email'
  | 'profile_claimed'
  | 'already_linked'
  | 'name_required'

/** Feil ved bruk av en lenke. Koden lar appen vise riktig tekst. */
export class InvitationError extends DomainError {
  readonly code: InvitationErrorCode

  constructor(code: InvitationErrorCode) {
    super(
      {
        not_found: 'Lenken finnes ikke. Sjekk at du har kopiert hele lenken.',
        used: 'Lenken er allerede brukt.',
        expired: 'Lenken er utløpt. Be styret om en ny.',
        revoked: 'Lenken er trukket tilbake. Be styret om en ny.',
        account_exists:
          'Det finnes allerede en konto med denne e-postadressen. Logg inn for å ta imot invitasjonen.',
        wrong_email:
          'Invitasjonen gjelder en annen e-postadresse enn kontoen du er logget inn med.',
        profile_claimed:
          'Profilen invitasjonen gjelder, er allerede tatt i bruk av en annen konto. Be styret om en ny invitasjon.',
        already_linked:
          'Kontoen din er allerede koblet til en annen profil. Be styret om en invitasjon uten profil.',
        name_required: 'Skriv inn fullt navn.',
      }[code],
    )
    this.name = 'InvitationError'
    this.code = code
  }
}

/** Den som lager en lenke: en innlogget admin, eller operatøren på kommandolinjen. */
type Creator = { personId: string; role: MemberRole } | 'operator'

export type CreatedLink = {
  id: string
  /** Vises eller sendes én gang. Lagres aldri. */
  token: string
  email: string
  kind: InvitationKind
  role: MemberRole
  expiresAt: Date
  /** Navnet til admin som laget lenken, eller null for operatøren (styret). */
  createdByName: string | null
  /** Personen ba om lenken for nytt passord selv. */
  requestedBySelf: boolean
}

/** Navnet til den som lager lenken, til e-posten. */
async function nameOf(tx: Tx, personId: string | null) {
  if (!personId) return null
  const [row] = await tx
    .select({ fullName: person.fullName })
    .from(person)
    .where(eq(person.id, personId))
  return row?.fullName ?? null
}

// ---------------------------------------------------------------------------
// Invitasjoner
// ---------------------------------------------------------------------------

export const invitationInput = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email('Skriv inn en gyldig e-postadresse.').max(254, 'For lang e-postadresse.')),
  role: z.enum(roles).default('member'),
  /** Profilen kontoen skal kobles til. Null betyr at personen skriver inn navnet selv. */
  personId: z.uuid().nullable().default(null),
})

export type InvitationInput = z.input<typeof invitationInput>

async function createInvitationInTx(
  tx: Tx,
  creator: Creator,
  input: z.output<typeof invitationInput>,
  reason: string | null,
): Promise<CreatedLink> {
  const email = normalizeEmail(input.email)
  if (creator !== 'operator' && input.role !== 'member' && creator.role !== 'owner') {
    throw new DomainError('Bare en hovedadmin kan invitere med en rolle.')
  }

  // Har adressen allerede en konto med tilgang, er en invitasjon feil verktøy.
  const [existing] = await tx
    .select({ status: membership.status })
    .from(user)
    .innerJoin(person, eq(person.userId, user.id))
    .innerJoin(membership, eq(membership.personId, person.id))
    .where(and(eq(user.email, email), eq(user.emailVerified, true)))
  if (existing?.status === 'active') {
    throw new DomainError(
      'Denne e-postadressen hører til et aktivt medlem. Endre rollen under Medlemmer i stedet.',
    )
  }

  if (input.personId) {
    const [profile] = await tx
      .select({ userId: person.userId })
      .from(person)
      .where(eq(person.id, input.personId))
    if (!profile) throw new NotFoundError('Fant ikke profilen.')
    if (profile.userId) throw new DomainError('Profilen er allerede tatt i bruk av en konto.')
  }

  const replaced = await revokePending(tx, email, 'invite')
  const token = newToken()
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS)
  const createdByPersonId = creator === 'operator' ? null : creator.personId
  const [row] = await tx
    .insert(invitation)
    .values({
      kind: 'invite',
      email,
      tokenHash: hashInvitationToken(token),
      personId: input.personId,
      role: input.role,
      createdByPersonId,
      expiresAt,
    })
    .returning({ id: invitation.id })
  await tx.insert(auditEvent).values({
    actorPersonId: createdByPersonId,
    action: 'invitation.create',
    subjectPersonId: input.personId,
    details: {
      invitationId: row!.id,
      email,
      role: input.role,
      profilePersonId: input.personId,
      replaced,
      reason,
    },
  })
  return {
    id: row!.id,
    token,
    email,
    kind: 'invite',
    role: input.role,
    expiresAt,
    createdByName: await nameOf(tx, createdByPersonId),
    requestedBySelf: false,
  }
}

/** Trekker tilbake ventende lenker av samme slag til samme adresse. Gir antallet. */
async function revokePending(tx: Tx, email: string, kind: InvitationKind) {
  const revoked = await tx
    .update(invitation)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(invitation.email, email),
        eq(invitation.kind, kind),
        isNull(invitation.usedAt),
        isNull(invitation.revokedAt),
        gt(invitation.expiresAt, new Date()),
      ),
    )
    .returning({ id: invitation.id })
  return revoked.length
}

function parseInvitationInput(input: InvitationInput) {
  const parsed = invitationInput.safeParse(input)
  if (!parsed.success) throw new DomainError(parsed.error.issues[0]?.message ?? 'Ugyldige felt.')
  return parsed.data
}

/** Lager en invitasjon. Krever `members.review`; med rolle også hovedadmin. */
export async function createInvitation(
  db: Db,
  viewer: Viewer,
  input: InvitationInput,
): Promise<CreatedLink> {
  assertCan(viewer, 'members.review')
  const data = parseInvitationInput(input)
  return db.transaction((tx) =>
    createInvitationInTx(
      tx,
      { personId: viewer.personId, role: viewer.membership!.role },
      data,
      null,
    ),
  )
}

/**
 * Invitasjon fra en lokal operatør med direkte databasetilgang, via
 * `pnpm admin:invite`. Slik kommer den første hovedadmin inn i produksjon.
 */
export async function createInvitationAsOperator(
  db: Db,
  input: InvitationInput & { reason?: string },
): Promise<CreatedLink> {
  const data = parseInvitationInput(input)
  return db.transaction((tx) =>
    createInvitationInTx(tx, 'operator', data, input.reason?.trim() || null),
  )
}

// ---------------------------------------------------------------------------
// Lenker for nytt passord
// ---------------------------------------------------------------------------

/**
 * Lager lenken og logger det. `self` er personen selv, fra «Glemt passord?»: da
 * står personen som den som laget lenken (eller ingen, for en konto uten person
 * ennå), så oversikten ikke viser den som laget av operatøren.
 */
async function createPasswordLinkInTx(
  tx: Tx,
  creator: Creator | 'self',
  target: { personId: string | null; userId: string; email: string },
  reason: string | null,
  ttlMs = INVITATION_TTL_MS,
): Promise<CreatedLink> {
  const email = normalizeEmail(target.email)
  const replaced = await revokePending(tx, email, 'password_reset')
  const token = newToken()
  const expiresAt = new Date(Date.now() + ttlMs)
  const requestedBySelf = creator === 'self'
  const createdByPersonId =
    creator === 'self' ? target.personId : creator === 'operator' ? null : creator.personId
  const [row] = await tx
    .insert(invitation)
    .values({
      kind: 'password_reset',
      email,
      tokenHash: hashInvitationToken(token),
      personId: target.personId,
      createdByPersonId,
      requestedBySelf,
      expiresAt,
    })
    .returning({ id: invitation.id })
  await tx.insert(auditEvent).values({
    actorPersonId: createdByPersonId,
    action: requestedBySelf ? 'password_link.request' : 'password_link.create',
    subjectPersonId: target.personId,
    // Uten person er adressen det eneste som sier hvem det gjaldt.
    details: requestedBySelf
      ? { invitationId: row!.id, replaced, email: target.personId ? undefined : email }
      : { invitationId: row!.id, replaced, reason },
  })
  return {
    id: row!.id,
    token,
    email,
    kind: 'password_reset',
    role: 'member',
    expiresAt,
    createdByName: await nameOf(tx, createdByPersonId),
    requestedBySelf,
  }
}

/**
 * Lager en lenke for nytt passord til en annen persons konto. Samme regler som
 * for deaktivering: admins for medlemmer og moderatorer, hovedadmins også for
 * admins og hovedadmins, aldri en selv.
 */
export async function createPasswordResetLink(
  db: Db,
  viewer: Viewer,
  input: { personId: string; reason: string },
): Promise<CreatedLink> {
  assertCan(viewer, 'members.manage')
  if (input.personId === viewer.personId) {
    throw new DomainError(
      'Du kan ikke lage en slik lenke til deg selv. Bytt passord under «Konto».',
    )
  }
  const reason = input.reason.trim()
  if (reason.length < 3) {
    throw new DomainError('Skriv en kort begrunnelse. Den lagres i revisjonsloggen.')
  }
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({ userId: user.id, email: user.email, role: membership.role })
      .from(person)
      .innerJoin(user, eq(user.id, person.userId))
      .leftJoin(membership, eq(membership.personId, person.id))
      .where(eq(person.id, input.personId))
      .for('update', { of: person })
    if (!target) throw new DomainError('Personen har ingen konto.')
    if (target.role && roleAtLeast(target.role, 'admin') && viewer.membership!.role !== 'owner') {
      throw new DomainError('Bare en hovedadmin kan lage en slik lenke for en admin.')
    }
    return createPasswordLinkInTx(
      tx,
      { personId: viewer.personId, role: viewer.membership!.role },
      { personId: input.personId, userId: target.userId, email: target.email },
      reason,
    )
  })
}

/** Lenke for nytt passord fra en lokal operatør, via `pnpm admin:password-link`. */
export async function createPasswordResetLinkAsOperator(
  db: Db,
  input: { email: string; reason: string },
): Promise<CreatedLink & { fullName: string }> {
  const email = normalizeEmail(input.email)
  const reason = input.reason.trim()
  if (reason.length < 3) throw new DomainError('Skriv en kort begrunnelse.')
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({
        userId: user.id,
        email: user.email,
        personId: person.id,
        fullName: person.fullName,
      })
      .from(user)
      .innerJoin(person, eq(person.userId, user.id))
      .where(eq(user.email, email))
    if (!target) throw new DomainError(`Fant ingen konto med e-post ${email}.`)
    const link = await createPasswordLinkInTx(tx, 'operator', target, reason)
    return { ...link, fullName: target.fullName }
  })
}

const requestEmail = z.string().trim().toLowerCase().pipe(z.email().max(254))

/**
 * «Glemt passord?»: lager en lenke for nytt passord til kontoen med adressen,
 * som appen sender på e-post til den adressen. Gir null når ingen lenke skal
 * sendes: ukjent eller ugyldig adresse, deaktivert eller avslått konto, eller en
 * lenke er bedt om for mindre enn to minutter siden. Den som spør, skal få samme
 * svar uansett, så det ikke kan brukes til å finne ut hvem som har konto.
 *
 * Lenken virker i en time, og ellers som en lenke fra en admin: én gang, logger
 * ut alle økter, og logger ikke inn (tofaktor gjelder fortsatt). Den erstatter
 * en ventende lenke for nytt passord til samme adresse, også en fra en admin.
 * Kontoer som aldri ble bekreftet, får også en: lenken beviser at personen leser
 * innboksen, slik bekreftelseslenken ville gjort.
 */
export async function requestPasswordReset(
  db: Db,
  input: { email: string },
): Promise<CreatedLink | null> {
  const parsed = requestEmail.safeParse(input.email)
  if (!parsed.success) return null
  const email = parsed.data
  return db.transaction(async (tx) => {
    // Kontoen låses, så to forespørsler samtidig ikke begge kommer forbi grensen.
    const [target] = await tx
      .select({
        userId: user.id,
        email: user.email,
        personId: person.id,
        status: membership.status,
      })
      .from(user)
      .leftJoin(person, eq(person.userId, user.id))
      .leftJoin(membership, eq(membership.personId, person.id))
      .where(eq(user.email, email))
      .for('update', { of: user })
    if (!target) return null
    // Deaktiverte og avslåtte har ingen tilgang å komme tilbake til; styret avgjør det.
    if (target.status === 'inactive') return null
    const since = new Date(Date.now() - PASSWORD_REQUEST_INTERVAL_MINUTES * 60 * 1000)
    const [recent] = await tx
      .select({ id: invitation.id })
      .from(invitation)
      .where(
        and(
          eq(invitation.email, email),
          eq(invitation.kind, 'password_reset'),
          eq(invitation.requestedBySelf, true),
          gt(invitation.createdAt, since),
        ),
      )
      .limit(1)
    if (recent) return null
    return createPasswordLinkInTx(
      tx,
      'self',
      { userId: target.userId, email: target.email, personId: target.personId },
      null,
      PASSWORD_REQUEST_TTL_MINUTES * 60 * 1000,
    )
  })
}

// ---------------------------------------------------------------------------
// Oversikt og tilbaketrekking
// ---------------------------------------------------------------------------

export type InvitationView = {
  id: string
  kind: InvitationKind
  email: string
  role: MemberRole
  status: InvitationStatus
  /** Profilen invitasjonen kobler til, eller personen lenken for nytt passord gjelder. */
  profile: { personId: string; fullName: string } | null
  /** Null betyr operatør på kommandolinjen (eller en slettet person). */
  createdBy: { personId: string; fullName: string } | null
  /** Personen ba om lenken for nytt passord selv («Glemt passord?»). */
  requestedBySelf: boolean
  createdAt: Date
  expiresAt: Date
  usedAt: Date | null
  /** Personen kontoen som brukte lenken, hører til nå. */
  usedBy: { personId: string; fullName: string } | null
  revokedAt: Date | null
}

/** De nyeste lenkene, med status. Krever `members.review`. */
export async function listInvitations(
  db: Db,
  viewer: Viewer,
  options: { limit?: number } = {},
): Promise<InvitationView[]> {
  assertCan(viewer, 'members.review')
  const profile = alias(person, 'profile')
  const creator = alias(person, 'creator')
  const usedBy = alias(person, 'used_by')
  const rows = await db
    .select({
      row: invitation,
      profileName: profile.fullName,
      creatorName: creator.fullName,
      usedById: usedBy.id,
      usedByName: usedBy.fullName,
    })
    .from(invitation)
    .leftJoin(profile, eq(profile.id, invitation.personId))
    .leftJoin(creator, eq(creator.id, invitation.createdByPersonId))
    .leftJoin(usedBy, eq(usedBy.userId, invitation.usedByUserId))
    .orderBy(desc(invitation.createdAt))
    .limit(Math.min(options.limit ?? 100, 200))
  const now = new Date()
  return rows.map(({ row, profileName, creatorName, usedById, usedByName }) => ({
    id: row.id,
    kind: row.kind,
    email: row.email,
    role: row.role,
    status: statusOf(row, now),
    profile: row.personId && profileName ? { personId: row.personId, fullName: profileName } : null,
    createdBy:
      row.createdByPersonId && creatorName
        ? { personId: row.createdByPersonId, fullName: creatorName }
        : null,
    requestedBySelf: row.requestedBySelf,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
    usedBy: usedById && usedByName ? { personId: usedById, fullName: usedByName } : null,
    revokedAt: row.revokedAt,
  }))
}

/** Trekker tilbake en ventende lenke. Krever `members.review`. */
export async function revokeInvitation(
  db: Db,
  viewer: Viewer,
  input: { id: string },
): Promise<void> {
  assertCan(viewer, 'members.review')
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(invitation)
      .where(eq(invitation.id, input.id))
      .for('update')
    if (!row) throw new NotFoundError('Fant ikke lenken.')
    if (statusOf(row) !== 'pending') throw new DomainError('Lenken er ikke aktiv lenger.')
    await tx.update(invitation).set({ revokedAt: new Date() }).where(eq(invitation.id, row.id))
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: row.kind === 'invite' ? 'invitation.revoke' : 'password_link.revoke',
      subjectPersonId: row.personId,
      details: { invitationId: row.id, email: row.email },
    })
  })
}

export type InviteTarget = {
  /** Profiler uten konto som har adressen i kullisten. */
  profiles: { personId: string; fullName: string; years: number[] }[]
  /** Kontoen med adressen, hvis den finnes. */
  account: {
    verified: boolean
    status: 'pending' | 'active' | 'inactive' | null
    fullName: string | null
  } | null
}

/** Hva admin bør vite om en adresse før invitasjonen lages. Krever `members.review`. */
export async function describeInviteTarget(
  db: Db,
  viewer: Viewer,
  rawEmail: string,
): Promise<InviteTarget> {
  assertCan(viewer, 'members.review')
  const email = normalizeEmail(rawEmail)
  if (!z.email().safeParse(email).success) return { profiles: [], account: null }
  const [profiles, [existing]] = await Promise.all([
    db
      .select({ personId: person.id, fullName: person.fullName })
      .from(personEmail)
      .innerJoin(person, eq(person.id, personEmail.personId))
      .where(and(eq(personEmail.email, email), isNull(person.userId))),
    db
      .select({
        verified: user.emailVerified,
        status: membership.status,
        fullName: person.fullName,
      })
      .from(user)
      .leftJoin(person, eq(person.userId, user.id))
      .leftJoin(membership, eq(membership.personId, person.id))
      .where(eq(user.email, email)),
  ])
  const years = profiles.length
    ? await db
        .select({ personId: personCohort.personId, year: cohort.graduationYear })
        .from(personCohort)
        .innerJoin(cohort, eq(cohort.id, personCohort.cohortId))
        .where(
          inArray(
            personCohort.personId,
            profiles.map((p) => p.personId),
          ),
        )
    : []
  return {
    profiles: profiles.map((p) => ({
      ...p,
      years: years
        .filter((y) => y.personId === p.personId)
        .map((y) => y.year)
        .sort(),
    })),
    account: existing
      ? {
          verified: existing.verified,
          status: existing.status ?? null,
          fullName: existing.verified ? (existing.fullName ?? null) : null,
        }
      : null,
  }
}

// ---------------------------------------------------------------------------
// Bruk av lenkene (offentlig: den som har lenken)
// ---------------------------------------------------------------------------

export type InvitationDetails =
  | { status: Exclude<InvitationStatus, 'pending'> | 'invalid' }
  | {
      status: 'pending'
      kind: InvitationKind
      email: string
      role: MemberRole
      /** Navnet til den som inviterte, eller null for styret (operatør). */
      invitedBy: string | null
      /** Profilen kontoen kobles til. */
      profile: { fullName: string; years: number[] } | null
      expiresAt: Date
      /**
       * `verified`: det finnes en konto med bekreftet adresse; personen må logge
       * inn. `unverified`: en konto som aldri ble bekreftet, og som overtas.
       */
      account: 'none' | 'unverified' | 'verified'
    }

/**
 * Hva siden for en lenke viser. Krever bare tokenet, som er hemmeligheten.
 * Ugyldige, brukte, utløpte og tilbaketrukne lenker gir bare statusen.
 */
export async function describeInvitation(
  db: Db,
  token: string,
  kind: InvitationKind,
): Promise<InvitationDetails> {
  if (!TOKEN_PATTERN.test(token)) return { status: 'invalid' }
  const creator = alias(person, 'creator')
  const [found] = await db
    .select({ row: invitation, invitedBy: creator.fullName })
    .from(invitation)
    .leftJoin(creator, eq(creator.id, invitation.createdByPersonId))
    .where(eq(invitation.tokenHash, hashInvitationToken(token)))
  if (!found || found.row.kind !== kind) return { status: 'invalid' }
  const { row } = found
  const status = statusOf(row)
  if (status !== 'pending') return { status }

  const [[existing], profileRows] = await Promise.all([
    db.select({ verified: user.emailVerified }).from(user).where(eq(user.email, row.email)),
    row.personId && kind === 'invite'
      ? db
          .select({ fullName: person.fullName, year: cohort.graduationYear })
          .from(person)
          .leftJoin(personCohort, eq(personCohort.personId, person.id))
          .leftJoin(cohort, eq(cohort.id, personCohort.cohortId))
          .where(eq(person.id, row.personId))
      : [],
  ])
  return {
    status,
    kind: row.kind,
    email: row.email,
    role: row.role,
    invitedBy: found.invitedBy,
    profile: profileRows[0]
      ? {
          fullName: profileRows[0].fullName,
          years: profileRows
            .map((r) => r.year)
            .filter((y): y is number => y !== null)
            .sort(),
        }
      : null,
    expiresAt: row.expiresAt,
    account: !existing ? 'none' : existing.verified ? 'verified' : 'unverified',
  }
}

/** Låser lenken og sjekker at den kan brukes nå. */
async function lockUsable(tx: Tx, token: string, kind: InvitationKind) {
  if (!TOKEN_PATTERN.test(token)) throw new InvitationError('not_found')
  const [row] = await tx
    .select()
    .from(invitation)
    .where(eq(invitation.tokenHash, hashInvitationToken(token)))
    .for('update')
  if (!row || row.kind !== kind) throw new InvitationError('not_found')
  const status = statusOf(row)
  if (status !== 'pending') throw new InvitationError(status)
  return row
}

const fullNameInput = z.string().trim().min(2).max(120)

/**
 * Tar imot en invitasjon med en ny konto. Kalles av Better Auth-endepunktet i
 * appen, som har hashet passordet og lager økten etterpå. Alt skjer i én
 * transaksjon: kontoen, koblingen til profilen, medlemskapet med rollen og at
 * lenken er brukt.
 *
 * Kontoen får bekreftet e-post: admin har sendt lenken til personen bak
 * adressen, og lenken er bundet til den. Uten passord (`passwordHash: null`)
 * legger personen til en passkey rett etterpå, i økten som lages.
 *
 * Finnes det en konto med adressen som aldri ble bekreftet, overtas den: ingen
 * har bevist at de eier den, og den har ingen person, passkeys eller tofaktor.
 * Finnes det en bekreftet konto, må personen logge inn og bruke
 * `acceptInvitationAsUser`.
 */
export async function acceptInvitation(
  db: Db,
  input: { token: string; passwordHash: string | null; fullName?: string | null },
): Promise<{ userId: string; personId: string }> {
  return db.transaction(async (tx) => {
    const row = await lockUsable(tx, input.token, 'invite')
    const [existing] = await tx
      .select({ id: user.id, verified: user.emailVerified })
      .from(user)
      .where(eq(user.email, row.email))
      .for('update')
    if (existing?.verified) throw new InvitationError('account_exists')

    // Profilen låses før noe skrives, så to invitasjoner til samme profil ikke begge vinner.
    let profile: { id: string; fullName: string } | null = null
    if (row.personId) {
      const [p] = await tx
        .select({ id: person.id, fullName: person.fullName, userId: person.userId })
        .from(person)
        .where(eq(person.id, row.personId))
        .for('update')
      if (p?.userId) throw new InvitationError('profile_claimed')
      if (p) profile = { id: p.id, fullName: p.fullName }
    }
    const typedName = fullNameInput.safeParse(input.fullName ?? '')
    if (!profile && !typedName.success) throw new InvitationError('name_required')
    const fullName = profile?.fullName ?? typedName.data!

    const now = new Date()
    let userId: string
    if (existing) {
      // Ubekreftet konto: alt som hørte til den, fjernes før den overtas.
      userId = existing.id
      await tx.delete(session).where(eq(session.userId, userId))
      await tx.delete(account).where(eq(account.userId, userId))
      await tx.delete(passkey).where(eq(passkey.userId, userId))
      await tx.delete(twoFactor).where(eq(twoFactor.userId, userId))
      await tx
        .update(user)
        .set({ name: fullName, emailVerified: true, twoFactorEnabled: false })
        .where(eq(user.id, userId))
    } else {
      userId = randomUUID()
      await tx
        .insert(user)
        .values({ id: userId, name: fullName, email: row.email, emailVerified: true })
    }
    if (input.passwordHash) {
      // Slik Better Auth selv lagrer passord: en `credential`-konto med bruker-ID-en som `accountId`.
      await tx.insert(account).values({
        id: randomUUID(),
        accountId: userId,
        providerId: 'credential',
        userId,
        password: input.passwordHash,
      })
    }

    let personId: string
    if (profile) {
      personId = profile.id
      await tx.update(person).set({ userId, claimedAt: now }).where(eq(person.id, personId))
    } else {
      const [created] = await tx
        .insert(person)
        .values({ fullName, userId, claimedAt: now, source: 'signup' })
        .returning({ id: person.id })
      personId = created!.id
    }
    const decided = { decidedAt: now, decidedByPersonId: row.createdByPersonId }
    await tx
      .insert(membership)
      .values({ personId, status: 'active', role: row.role, ...decided })
      .onConflictDoUpdate({
        target: membership.personId,
        set: { status: 'active', role: row.role, ...decided },
      })
    await tx
      .insert(personEmail)
      .values({ email: row.email, personId, source: 'signup' })
      .onConflictDoNothing()
    await tx
      .update(invitation)
      .set({ usedAt: now, usedByUserId: userId })
      .where(eq(invitation.id, row.id))
    await notifyMemberApproved(tx, personId)
    await tx.insert(auditEvent).values({
      actorPersonId: personId,
      action: 'invitation.use',
      subjectPersonId: personId,
      details: {
        invitationId: row.id,
        role: row.role,
        invitedByPersonId: row.createdByPersonId,
        profileLinked: profile !== null,
        account: existing ? 'unverified_taken_over' : 'new',
        method: input.passwordHash ? 'password' : 'passkey',
      },
    })
    return { userId, personId }
  })
}

/**
 * Tar imot en invitasjon med kontoen man er logget inn med. Adressen må være
 * den invitasjonen gjelder. Kontoen blir aktivt medlem med rollen (en høyere
 * rolle tas aldri fra den), kobles til profilen hvis den ikke er koblet fra før,
 * og en åpen forespørsel om tilgang godkjennes.
 */
export async function acceptInvitationAsUser(
  db: Db,
  viewer: Viewer,
  token: string,
): Promise<{ personId: string }> {
  if (!viewer) throw new AccessDeniedError('unauthenticated')
  if (!viewer.emailVerified) throw new AccessDeniedError('not_member')
  return db.transaction(async (tx) => {
    const row = await lockUsable(tx, token, 'invite')
    const [own] = await tx
      .select({ id: user.id, name: user.name, email: user.email })
      .from(user)
      .where(eq(user.id, viewer.userId))
    if (!own) throw new AccessDeniedError('unauthenticated')
    if (normalizeEmail(own.email) !== row.email) throw new InvitationError('wrong_email')

    let personId = await ensurePersonForVerifiedUser(tx, own)
    const [current] = await tx
      .select({ status: membership.status, role: membership.role })
      .from(membership)
      .where(eq(membership.personId, personId))
      .for('update')
    const [request] = await tx
      .select({
        id: accessRequest.id,
        status: accessRequest.status,
        profile: accessRequest.profilePersonId,
      })
      .from(accessRequest)
      .where(eq(accessRequest.userId, own.id))
      .for('update')

    // Admin valgte profilen i invitasjonen. Uten den gjelder profilen personen selv
    // valgte i forespørselen, som bare kan være en med kontoens egen adresse.
    const profileId = row.personId ?? (request?.status === 'open' ? request.profile : null)
    let profileLinked = false
    if (profileId && profileId !== personId) {
      if (current?.status === 'pending') {
        const [target] = await tx
          .select({ userId: person.userId })
          .from(person)
          .where(eq(person.id, profileId))
          .for('update')
        if (target?.userId) throw new InvitationError('profile_claimed')
        if (target) {
          await linkAccountInTx(tx, { pendingPersonId: personId, profilePersonId: profileId })
          personId = profileId
          profileLinked = true
        }
      } else if (row.personId) {
        throw new InvitationError('already_linked')
      }
    }

    const wasActive = current?.status === 'active'
    const role =
      wasActive && current && roleAtLeast(current.role, row.role) ? current.role : row.role
    const now = new Date()
    const decided = { decidedAt: now, decidedByPersonId: row.createdByPersonId }
    await tx
      .insert(membership)
      .values({ personId, status: 'active', role, ...decided })
      .onConflictDoUpdate({
        target: membership.personId,
        set: { status: 'active', role, ...decided },
      })
    if (request && request.status !== 'approved') {
      await tx
        .update(accessRequest)
        .set({
          status: 'approved',
          profilePersonId: profileLinked ? personId : request.profile,
          ...decided,
        })
        .where(eq(accessRequest.id, request.id))
    }
    await tx
      .update(invitation)
      .set({ usedAt: now, usedByUserId: own.id })
      .where(eq(invitation.id, row.id))
    if (!wasActive) await notifyMemberApproved(tx, personId)
    await tx.insert(auditEvent).values({
      actorPersonId: personId,
      action: 'invitation.use',
      subjectPersonId: personId,
      details: {
        invitationId: row.id,
        role,
        invitedByPersonId: row.createdByPersonId,
        profileLinked,
        account: 'existing',
        previousStatus: current?.status ?? null,
        approvedRequest: request && request.status !== 'approved' ? request.id : null,
      },
    })
    return { personId }
  })
}

/**
 * Setter nytt passord med en lenke fra en admin, eller en personen ba om selv. Kalles av Better Auth-endepunktet
 * i appen, som har hashet passordet. Alle økter slettes, også den som eventuelt
 * er åpen i nettleseren nå; personen logger inn med det nye passordet (og
 * tofaktor, om kontoen har det).
 */
export async function resetPasswordWithLink(
  db: Db,
  input: { token: string; passwordHash: string },
): Promise<{ userId: string }> {
  return db.transaction(async (tx) => {
    const row = await lockUsable(tx, input.token, 'password_reset')
    const [target] = await tx
      .select({ id: user.id, personId: person.id })
      .from(user)
      .leftJoin(person, eq(person.userId, user.id))
      .where(eq(user.email, row.email))
      .for('update', { of: user })
    // Kontoen må fortsatt høre til personen lenken ble laget for.
    if (!target || (row.personId && target.personId !== row.personId)) {
      throw new InvitationError('not_found')
    }
    const now = new Date()
    await tx.delete(session).where(eq(session.userId, target.id))
    const updated = await tx
      .update(account)
      .set({ password: input.passwordHash, updatedAt: now })
      .where(and(eq(account.userId, target.id), eq(account.providerId, 'credential')))
      .returning({ id: account.id })
    if (!updated.length) {
      await tx.insert(account).values({
        id: randomUUID(),
        accountId: target.id,
        providerId: 'credential',
        userId: target.id,
        password: input.passwordHash,
      })
    }
    // Lenken er bundet til adressen; har den kommet fram, er adressen bekreftet.
    await tx.update(user).set({ emailVerified: true }).where(eq(user.id, target.id))
    await tx
      .update(invitation)
      .set({ usedAt: now, usedByUserId: target.id })
      .where(eq(invitation.id, row.id))
    await tx.insert(auditEvent).values({
      actorPersonId: target.personId,
      action: 'password_link.use',
      subjectPersonId: target.personId,
      details: { invitationId: row.id, createdByPersonId: row.createdByPersonId },
    })
    return { userId: target.id }
  })
}
