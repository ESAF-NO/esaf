import { schema, type Db, type MemberRole, type MembershipStatus } from '@esaf/db'
import { and, asc, desc, eq, inArray, isNotNull, like, lt, max, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { assertCan, roleAtLeast, roles, type Viewer } from './access.ts'
import { revokeApiTokensForUser } from './api-tokens.ts'
import { DomainError, NotFoundError } from './errors.ts'
import type { Tx } from './members.ts'

const {
  accessRequest,
  apiToken,
  auditEvent,
  cohort,
  membership,
  passkey,
  person,
  personCohort,
  session,
  user,
} = schema

/**
 * Medlemsadministrasjon: roller, tilgang og revisjonslogg. Reglene:
 *
 * - Bare hovedadmins (`owner`) kan gi og fjerne roller, og ingen kan endre sin
 *   egen rolle eller tilgang.
 * - Admins kan deaktivere og gjenopprette medlemmer og moderatorer. Andre admins
 *   og hovedadmins kan bare en hovedadmin endre tilgangen til.
 * - Det finnes alltid minst én aktiv hovedadmin.
 * - Deaktivering logger personen ut overalt og fjerner rollen. Alt logges.
 * - Har noen mistet passkeyene sine, kan de fjernes etter de samme reglene som
 *   for deaktivering, så personen kan legge til nye.
 * - Deaktivering, tap av adminrollen og fjernede passkeys trekker tilbake
 *   MCP-nøklene til kontoen (se `api-tokens.ts`). Antallet står i loggen.
 */

export type AccountView = {
  personId: string
  fullName: string
  email: string
  role: MemberRole
  status: MembershipStatus
  /**
   * Tofaktor eller passkey: admins og hovedadmins trenger én av dem for å kunne
   * logge inn sterkt og bruke rettighetene sine.
   */
  twoFactorEnabled: boolean
  passkeys: number
  cohortYears: number[]
  /** Når kontoen ble koblet til personen (godkjent). */
  claimedAt: Date | null
  /** Siste aktivitet i en innlogget økt. */
  lastSeenAt: Date | null
}

/** Alle med konto som er eller har vært medlem. Ventende og avslåtte ligger under forespørsler. */
export async function listAccounts(db: Db, viewer: Viewer): Promise<AccountView[]> {
  assertCan(viewer, 'members.manage')
  const rows = await db
    .select({
      personId: person.id,
      fullName: person.fullName,
      userId: user.id,
      email: user.email,
      twoFactorEnabled: user.twoFactorEnabled,
      passkeys: sql<number>`(select count(*)::int from ${passkey} where ${passkey.userId} = ${user.id})`,
      role: membership.role,
      status: membership.status,
      claimedAt: person.claimedAt,
    })
    .from(person)
    .innerJoin(user, eq(user.id, person.userId))
    .innerJoin(membership, eq(membership.personId, person.id))
    .leftJoin(accessRequest, eq(accessRequest.userId, user.id))
    .where(
      and(
        inArray(membership.status, ['active', 'inactive']),
        sql`${accessRequest.status} is distinct from 'rejected'`,
      ),
    )
    .orderBy(asc(person.fullName))
  if (!rows.length) return []

  const [years, seen] = await Promise.all([
    db
      .select({ personId: personCohort.personId, year: cohort.graduationYear })
      .from(personCohort)
      .innerJoin(cohort, eq(cohort.id, personCohort.cohortId))
      .where(
        inArray(
          personCohort.personId,
          rows.map((r) => r.personId),
        ),
      ),
    db
      .select({ userId: session.userId, at: max(session.updatedAt) })
      .from(session)
      .where(
        inArray(
          session.userId,
          rows.map((r) => r.userId),
        ),
      )
      .groupBy(session.userId),
  ])
  return rows.map(({ userId, ...row }) => ({
    ...row,
    cohortYears: years
      .filter((y) => y.personId === row.personId)
      .map((y) => y.year)
      .sort(),
    lastSeenAt: seen.find((s) => s.userId === userId)?.at ?? null,
  }))
}

/** Låser alle aktive hovedadmins, så to samtidige endringer ikke kan fjerne den siste. */
async function lockOwners(tx: Tx) {
  return tx
    .select({ personId: membership.personId })
    .from(membership)
    .where(and(eq(membership.role, 'owner'), eq(membership.status, 'active')))
    .for('update')
}

async function lockTarget(tx: Tx, personId: string) {
  const [target] = await tx
    .select({
      role: membership.role,
      status: membership.status,
      userId: person.userId,
    })
    .from(membership)
    .innerJoin(person, eq(person.id, membership.personId))
    .where(eq(membership.personId, personId))
    .for('update')
  if (!target) throw new NotFoundError('Fant ikke personen.')
  return target
}

/** Gir eller fjerner en rolle. Bare for hovedadmins. */
export async function changeRole(
  db: Db,
  viewer: Viewer,
  input: { personId: string; role: MemberRole; reason?: string },
): Promise<void> {
  assertCan(viewer, 'roles.manage')
  if (!roles.includes(input.role)) throw new DomainError('Ukjent rolle.')
  if (input.personId === viewer.personId) {
    throw new DomainError('Du kan ikke endre din egen rolle. Be en annen hovedadmin.')
  }
  await db.transaction(async (tx) => {
    const owners = await lockOwners(tx)
    const target = await lockTarget(tx, input.personId)
    if (!target.userId || target.status !== 'active') {
      throw new DomainError('Bare aktive medlemmer med konto kan få en rolle.')
    }
    if (target.role === input.role) return
    if (target.role === 'owner' && owners.length <= 1) {
      throw new DomainError('ESAF må ha minst én hovedadmin.')
    }
    await tx
      .update(membership)
      .set({ role: input.role })
      .where(eq(membership.personId, input.personId))
    // MCP-nøkler er for admins. Uten rollen virker de ikke uansett, men de skal ikke ligge igjen.
    const revokedTokens = roleAtLeast(input.role, 'admin')
      ? 0
      : await revokeApiTokensForUser(tx, target.userId)
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'role.change',
      subjectPersonId: input.personId,
      details: {
        from: target.role,
        to: input.role,
        reason: input.reason?.trim() || null,
        ...(revokedTokens ? { revokedTokens } : {}),
      },
    })
  })
}

/**
 * Deaktiverer eller gjenoppretter et medlem. Deaktivering krever begrunnelse,
 * logger personen ut på alle enheter og setter rollen tilbake til medlem, så
 * rettigheter må gis på nytt etter en eventuell gjenoppretting.
 */
export async function setMemberAccess(
  db: Db,
  viewer: Viewer,
  input: { personId: string; active: boolean; reason: string },
): Promise<void> {
  assertCan(viewer, 'members.manage')
  if (input.personId === viewer.personId) {
    throw new DomainError('Du kan ikke endre din egen tilgang.')
  }
  const reason = input.reason.trim()
  if (!input.active && reason.length < 3) {
    throw new DomainError('Skriv en kort begrunnelse. Den lagres i revisjonsloggen.')
  }

  await db.transaction(async (tx) => {
    const owners = await lockOwners(tx)
    const target = await lockTarget(tx, input.personId)
    if (!target.userId) throw new DomainError('Personen har ingen konto.')
    if (roleAtLeast(target.role, 'admin') && viewer.membership!.role !== 'owner') {
      throw new DomainError('Bare en hovedadmin kan endre tilgangen til en admin.')
    }
    const [request] = await tx
      .select({ status: accessRequest.status })
      .from(accessRequest)
      .where(eq(accessRequest.userId, target.userId))
    if (request?.status === 'rejected') {
      throw new DomainError(
        'Forespørselen til denne personen er avslått, og må ikke gjenopprettes her.',
      )
    }
    const decided = { decidedAt: new Date(), decidedByPersonId: viewer.personId }

    if (input.active) {
      if (target.status !== 'inactive') throw new DomainError('Personen har allerede tilgang.')
      await tx
        .update(membership)
        .set({ status: 'active', ...decided })
        .where(eq(membership.personId, input.personId))
    } else {
      if (target.status !== 'active') throw new DomainError('Personen har ikke tilgang nå.')
      if (target.role === 'owner' && owners.length <= 1) {
        throw new DomainError('ESAF må ha minst én hovedadmin.')
      }
      await tx
        .update(membership)
        .set({ status: 'inactive', role: 'member', ...decided })
        .where(eq(membership.personId, input.personId))
      // Ut med en gang, ikke først når økten går ut.
      await tx.delete(session).where(eq(session.userId, target.userId))
    }
    const revokedTokens = input.active ? 0 : await revokeApiTokensForUser(tx, target.userId)
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: input.active ? 'membership.reactivate' : 'membership.deactivate',
      subjectPersonId: input.personId,
      details: {
        reason: reason || null,
        previousRole: target.role,
        ...(revokedTokens ? { revokedTokens } : {}),
      },
    })
  })
}

/**
 * Fjerner alle passkeys til en person som har mistet dem, så de kan legge til
 * nye etter å ha logget inn med passord. Samme regler som for deaktivering:
 * admins for medlemmer og moderatorer, hovedadmins også for admins, aldri en
 * selv. Personen logges ut overalt, i tilfelle noen andre har en av dem.
 */
export async function removePasskeys(
  db: Db,
  viewer: Viewer,
  input: { personId: string; reason: string },
): Promise<void> {
  assertCan(viewer, 'members.manage')
  if (input.personId === viewer.personId) {
    throw new DomainError('Du kan ikke fjerne dine egne passkeys her. Gjør det under «Konto».')
  }
  const reason = input.reason.trim()
  if (reason.length < 3) {
    throw new DomainError('Skriv en kort begrunnelse. Den lagres i revisjonsloggen.')
  }
  await db.transaction(async (tx) => {
    const target = await lockTarget(tx, input.personId)
    if (!target.userId) throw new DomainError('Personen har ingen konto.')
    if (roleAtLeast(target.role, 'admin') && viewer.membership!.role !== 'owner') {
      throw new DomainError('Bare en hovedadmin kan fjerne passkeys for en admin.')
    }
    const removed = await tx
      .delete(passkey)
      .where(eq(passkey.userId, target.userId))
      .returning({ id: passkey.id })
    if (!removed.length) throw new DomainError('Personen har ingen passkeys.')
    await tx.delete(session).where(eq(session.userId, target.userId))
    // Nøklene ble laget med en av passkeyene; den kan være på avveie.
    const revokedTokens = await revokeApiTokensForUser(tx, target.userId)
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'security.remove_passkeys',
      subjectPersonId: input.personId,
      details: { reason, count: removed.length, ...(revokedTokens ? { revokedTokens } : {}) },
    })
  })
}

/** En person i loggen. Profilen kan bare åpnes når medlemskapet er aktivt. */
export type AuditPerson = { personId: string; fullName: string; active: boolean }

export type AuditEntry = {
  id: string
  action: string
  createdAt: Date
  details: Record<string, unknown>
  /** Null betyr lokal operatør (CLI). */
  actor: AuditPerson | null
  subject: AuditPerson | null
  /** Gjort med en MCP-nøkkel: navnet på nøkkelen. Ellers fra appen eller CLI-en. */
  viaMcp: { tokenName: string } | null
}

/**
 * Revisjonsloggen, nyeste først. Bla bakover med `before`. Kan avgrenses til én
 * person (som utfører eller den det gjelder), handlinger som begynner med
 * `actionPrefix` (f.eks. `company.`), og det som er gjort med MCP-nøkler.
 */
export async function listAuditEvents(
  db: Db,
  viewer: Viewer,
  options: {
    before?: Date
    limit?: number
    personId?: string
    actionPrefix?: string
    viaMcp?: boolean
  } = {},
): Promise<AuditEntry[]> {
  assertCan(viewer, 'audit.read')
  const actor = alias(person, 'actor')
  const subject = alias(person, 'subject')
  const actorMembership = alias(membership, 'actor_membership')
  const subjectMembership = alias(membership, 'subject_membership')
  const rows = await db
    .select({
      id: auditEvent.id,
      action: auditEvent.action,
      createdAt: auditEvent.createdAt,
      details: auditEvent.details,
      actorId: actor.id,
      actorName: actor.fullName,
      actorStatus: actorMembership.status,
      subjectId: subject.id,
      subjectName: subject.fullName,
      subjectStatus: subjectMembership.status,
      tokenName: apiToken.name,
    })
    .from(auditEvent)
    .leftJoin(actor, eq(actor.id, auditEvent.actorPersonId))
    .leftJoin(actorMembership, eq(actorMembership.personId, actor.id))
    .leftJoin(subject, eq(subject.id, auditEvent.subjectPersonId))
    .leftJoin(subjectMembership, eq(subjectMembership.personId, subject.id))
    .leftJoin(apiToken, eq(apiToken.id, auditEvent.apiTokenId))
    .where(
      and(
        options.before ? lt(auditEvent.createdAt, options.before) : undefined,
        options.personId
          ? or(
              eq(auditEvent.actorPersonId, options.personId),
              eq(auditEvent.subjectPersonId, options.personId),
            )
          : undefined,
        options.actionPrefix
          ? like(auditEvent.action, `${options.actionPrefix.replace(/[%_\\]/g, '\\$&')}%`)
          : undefined,
        options.viaMcp ? isNotNull(auditEvent.apiTokenId) : undefined,
      ),
    )
    .orderBy(desc(auditEvent.createdAt))
    .limit(Math.min(options.limit ?? 50, 200))
  const who = (id: string | null, fullName: string | null, status: MembershipStatus | null) =>
    id && fullName ? { personId: id, fullName, active: status === 'active' } : null
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    createdAt: r.createdAt,
    details: r.details,
    actor: who(r.actorId, r.actorName, r.actorStatus),
    subject: who(r.subjectId, r.subjectName, r.subjectStatus),
    viaMcp: r.tokenName !== null ? { tokenName: r.tokenName } : null,
  }))
}
