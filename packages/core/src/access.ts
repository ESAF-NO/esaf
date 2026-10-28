import type { MemberRole, MembershipStatus } from '@esaf/db'
import { AccessDeniedError } from './errors.ts'

/**
 * Den som gjør en forespørsel, slik serveren ser det. `null` betyr ikke innlogget.
 * Bygges alltid på serveren fra sesjonen, aldri fra data klienten sender.
 */
export type Viewer = {
  userId: string
  emailVerified: boolean
  /** Kontoen har tofaktor; da har også innloggingen gått gjennom tofaktor. */
  twoFactorEnabled: boolean
  personId: string | null
  membership: { status: MembershipStatus; role: MemberRole } | null
} | null

export type AccessLevel = 'anonymous' | 'pending' | 'member'

/**
 * Tilgangsgrensen i ett punkt. Innlogging alene gir aldri mer enn `pending`;
 * medlemsinnsyn krever bekreftet e-post og aktivt medlemskap godkjent av ESAF.
 * Hva et medlem i tillegg kan gjøre, avgjøres av rollen (se `can`).
 */
export function accessLevel(viewer: Viewer): AccessLevel {
  if (!viewer) return 'anonymous'
  const m = viewer.membership
  if (!viewer.emailVerified || !viewer.personId || !m || m.status !== 'active') return 'pending'
  return 'member'
}

/** Rollene fra minst til mest. En rolle har alt rollene under den har. */
export const roles = [
  'member',
  'moderator',
  'admin',
  'owner',
] as const satisfies readonly MemberRole[]

export const roleAtLeast = (role: MemberRole, minimum: MemberRole) =>
  roles.indexOf(role) >= roles.indexOf(minimum)

/**
 * Hva rollene får gjøre, som den laveste rollen som har rettigheten. Alle
 * handlinger utover vanlig medlemskap sjekker en rettighet her, på serveren.
 */
export const permissions = {
  /** Skjule andres innlegg og kommentarer. */
  'content.moderate': 'moderator',
  /** Behandle forespørsler om tilgang og koble kontoer til profiler. */
  'members.review': 'admin',
  /** Deaktivere og gjenopprette medlemmer med lavere rolle enn en selv. */
  'members.manage': 'admin',
  /** Rette andres profiler, men aldri kontaktinfo. */
  'profiles.edit': 'admin',
  /** Lese revisjonsloggen. */
  'audit.read': 'admin',
  /** Gi og fjerne roller. */
  'roles.manage': 'owner',
} as const satisfies Record<string, MemberRole>

export type Permission = keyof typeof permissions

/** Admins og hovedadmins må ha tofaktor for å bruke rettighetene sine. */
export const twoFactorRequired = (role: MemberRole) => roleAtLeast(role, 'admin')

/** Rollen til et aktivt medlem, ellers `null`. */
export function activeRole(viewer: Viewer): MemberRole | null {
  return accessLevel(viewer) === 'member' ? viewer!.membership!.role : null
}

/** Om den innloggede kan bruke en rettighet nå, medregnet tofaktor. */
export function can(viewer: Viewer, permission: Permission): boolean {
  const role = activeRole(viewer)
  if (!role || !roleAtLeast(role, permissions[permission])) return false
  return !twoFactorRequired(role) || viewer!.twoFactorEnabled
}

export function assertMember(viewer: Viewer): asserts viewer is NonNullable<Viewer> & {
  personId: string
} {
  const level = accessLevel(viewer)
  if (level === 'anonymous') throw new AccessDeniedError('unauthenticated')
  if (level === 'pending') throw new AccessDeniedError('not_member')
}

/**
 * Krever en rettighet. Mangler bare tofaktor, får den som spør vite det, så de
 * kan slå det på. Ellers er svaret det samme som om handlingen ikke fantes.
 */
export function assertCan(
  viewer: Viewer,
  permission: Permission,
): asserts viewer is NonNullable<Viewer> & { personId: string } {
  assertMember(viewer)
  const role = viewer.membership!.role
  if (!roleAtLeast(role, permissions[permission])) throw new AccessDeniedError('forbidden')
  if (twoFactorRequired(role) && !viewer.twoFactorEnabled) {
    throw new AccessDeniedError('two_factor_required')
  }
}
