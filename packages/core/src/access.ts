import type { MemberRole, MembershipStatus } from '@esaf/db'
import { AccessDeniedError } from './errors.ts'

/**
 * Den som gjør en forespørsel, slik serveren ser det. `null` betyr ikke innlogget.
 * Bygges alltid på serveren fra sesjonen, aldri fra data klienten sender.
 */
export type Viewer = {
  userId: string
  emailVerified: boolean
  /** Kontoen har tofaktor; da har all innlogging med passord gått gjennom koden. */
  twoFactorEnabled: boolean
  /** Denne økten ble startet med passkey. */
  passkeySession: boolean
  /** Kontoen har minst én passkey. Gir ingen tilgang i seg selv, se `mayChangeSignInMethods`. */
  hasPasskey: boolean
  personId: string | null
  membership: { status: MembershipStatus; role: MemberRole } | null
  /**
   * Forespørselen kom med en MCP-nøkkel, ikke en innloggingsøkt. Nøkkelen ble
   * laget i en sterk økt og virker bare så lenge kontoen har passkey eller
   * tofaktor (se `authenticateApiToken`). `readOnly`: bare verktøy som leser.
   */
  apiToken?: { id: string; readOnly: boolean }
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
  /**
   * Rette andres profiler, men aldri kontaktinfo. På profiler uten konto kan
   * kontaktinfo fra kullisten skjules eller vises.
   */
  'profiles.edit': 'admin',
  /** Lese revisjonsloggen. */
  'audit.read': 'admin',
  /** Lage MCP-nøkler og bruke adminverktøyene fra en MCP-klient. */
  'mcp.access': 'admin',
  /** Gi og fjerne roller. */
  'roles.manage': 'owner',
} as const satisfies Record<string, MemberRole>

export type Permission = keyof typeof permissions

/** Admins og hovedadmins må være sterkt innlogget for å bruke rettighetene sine. */
export const strongAuthRequired = (role: MemberRole) => roleAtLeast(role, 'admin')

/** Det serveren vet om hvordan den innloggede er logget inn. */
export type SignInFactors = Pick<
  NonNullable<Viewer>,
  'twoFactorEnabled' | 'passkeySession' | 'hasPasskey'
>

/**
 * Sterk innlogging: økten er startet med passkey, eller kontoen har tofaktor
 * (da krever innlogging med passord alltid koden også). En konto med bare
 * passkey som logger inn med passord, får en vanlig økt. En MCP-nøkkel er
 * sterk: den kan bare lages i en sterk økt, og virker bare mens kontoen har
 * passkey eller tofaktor.
 */
export const strongAuth = (
  f: Pick<SignInFactors, 'twoFactorEnabled' | 'passkeySession'> & {
    apiToken?: NonNullable<Viewer>['apiToken']
  },
) => f.twoFactorEnabled || f.passkeySession || f.apiToken !== undefined

/**
 * Om økten kan legge til eller fjerne passkeys og slå på tofaktor. Den første
 * metoden kan legges til med en vanlig økt, som tofaktor alltid har kunnet.
 * Har kontoen allerede passkey, kreves sterk innlogging. Ellers kunne den som
 * bare kan passordet, bytte ut passkeyen med sin egen og bli sterkt innlogget.
 */
export const mayChangeSignInMethods = (f: SignInFactors) => !f.hasPasskey || strongAuth(f)

/** Rollen til et aktivt medlem, ellers `null`. */
export function activeRole(viewer: Viewer): MemberRole | null {
  return accessLevel(viewer) === 'member' ? viewer!.membership!.role : null
}

/** Om den innloggede kan bruke en rettighet nå, medregnet kravet om sterk innlogging. */
export function can(viewer: Viewer, permission: Permission): boolean {
  const role = activeRole(viewer)
  if (!role || !roleAtLeast(role, permissions[permission])) return false
  return !strongAuthRequired(role) || strongAuth(viewer!)
}

export function assertMember(viewer: Viewer): asserts viewer is NonNullable<Viewer> & {
  personId: string
} {
  const level = accessLevel(viewer)
  if (level === 'anonymous') throw new AccessDeniedError('unauthenticated')
  if (level === 'pending') throw new AccessDeniedError('not_member')
}

/**
 * Krever en rettighet. Mangler bare sterk innlogging, får den som spør vite
 * det, så de kan logge inn med passkey eller slå på tofaktor. Ellers er svaret
 * det samme som om handlingen ikke fantes.
 */
export function assertCan(
  viewer: Viewer,
  permission: Permission,
): asserts viewer is NonNullable<Viewer> & { personId: string } {
  assertMember(viewer)
  const role = viewer.membership!.role
  if (!roleAtLeast(role, permissions[permission])) throw new AccessDeniedError('forbidden')
  if (strongAuthRequired(role) && !strongAuth(viewer)) {
    throw new AccessDeniedError('strong_auth_required')
  }
}
