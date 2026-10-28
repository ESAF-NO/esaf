import type { MemberRole, MembershipStatus } from '@esaf/db'
import { AccessDeniedError } from './errors.ts'

/**
 * Den som gjør en forespørsel, slik serveren ser det. `null` betyr ikke innlogget.
 * Bygges alltid på serveren fra sesjonen, aldri fra data klienten sender.
 */
export type Viewer = {
  userId: string
  emailVerified: boolean
  personId: string | null
  membership: { status: MembershipStatus; role: MemberRole } | null
} | null

export type AccessLevel = 'anonymous' | 'pending' | 'member' | 'admin'

/**
 * Tilgangsgrensen i ett punkt. Innlogging alene gir aldri mer enn `pending`;
 * medlemsinnsyn krever bekreftet e-post og aktivt medlemskap godkjent av ESAF.
 */
export function accessLevel(viewer: Viewer): AccessLevel {
  if (!viewer) return 'anonymous'
  const m = viewer.membership
  if (!viewer.emailVerified || !viewer.personId || !m || m.status !== 'active') return 'pending'
  return m.role === 'admin' ? 'admin' : 'member'
}

export function assertMember(viewer: Viewer): asserts viewer is NonNullable<Viewer> & {
  personId: string
} {
  const level = accessLevel(viewer)
  if (level === 'anonymous') throw new AccessDeniedError('unauthenticated')
  if (level === 'pending') throw new AccessDeniedError('not_member')
}

export function assertAdmin(viewer: Viewer): asserts viewer is NonNullable<Viewer> & {
  personId: string
} {
  assertMember(viewer)
  if (accessLevel(viewer) !== 'admin') throw new AccessDeniedError('not_admin')
}
