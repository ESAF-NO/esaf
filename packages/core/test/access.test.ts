import { describe, expect, it } from 'vitest'
import {
  accessLevel,
  assertCan,
  assertMember,
  can,
  permissions,
  roles,
  type Permission,
  type Viewer,
} from '../src/access.ts'
import { AccessDeniedError } from '../src/errors.ts'

const base = { userId: 'u1', emailVerified: true, twoFactorEnabled: false, personId: 'p1' }
type Role = (typeof roles)[number]
const active = (role: Role, twoFactorEnabled = false): Viewer => ({
  ...base,
  twoFactorEnabled,
  membership: { status: 'active', role },
})

const cases: [string, Viewer, string][] = [
  ['ikke innlogget', null, 'anonymous'],
  [
    'ubekreftet e-post',
    { ...base, emailVerified: false, personId: null, membership: null },
    'pending',
  ],
  [
    'ubekreftet e-post selv med aktivt medlemskap',
    { ...base, emailVerified: false, membership: { status: 'active', role: 'owner' } },
    'pending',
  ],
  ['ny konto uten medlemskap', { ...base, membership: null }, 'pending'],
  ['ventende', { ...base, membership: { status: 'pending', role: 'member' } }, 'pending'],
  [
    'ventende med adminrolle',
    { ...base, membership: { status: 'pending', role: 'admin' } },
    'pending',
  ],
  ['deaktivert admin', { ...base, membership: { status: 'inactive', role: 'admin' } }, 'pending'],
  ['aktivt medlem', active('member'), 'member'],
  ['aktiv hovedadmin', active('owner', true), 'member'],
]

describe('accessLevel', () => {
  it.each(cases)('%s', (_, viewer, expected) => {
    expect(accessLevel(viewer)).toBe(expected)
  })
})

function reason(fn: () => void) {
  try {
    fn()
  } catch (error) {
    if (error instanceof AccessDeniedError) return error.reason
    throw error
  }
  return 'allowed'
}

describe('assertMember', () => {
  it('avviser uinnloggede og ikke-godkjente fra medlemsdata', () => {
    expect(reason(() => assertMember(null))).toBe('unauthenticated')
    expect(reason(() => assertMember({ ...base, membership: null }))).toBe('not_member')
    expect(
      reason(() => assertMember({ ...base, membership: { status: 'pending', role: 'member' } })),
    ).toBe('not_member')
    expect(reason(() => assertMember(active('member')))).toBe('allowed')
  })
})

describe('rettigheter', () => {
  // Hvilke rettigheter hver rolle har, med tofaktor der det kreves.
  const expected: Record<Role, Permission[]> = {
    member: [],
    moderator: ['content.moderate'],
    admin: ['content.moderate', 'members.review', 'members.manage', 'profiles.edit', 'audit.read'],
    owner: Object.keys(permissions) as Permission[],
  }

  it.each(roles)('%s har akkurat sine rettigheter', (role) => {
    const viewer = active(role, true)
    const granted = (Object.keys(permissions) as Permission[]).filter((p) => can(viewer, p))
    expect(granted.sort()).toEqual([...expected[role]].sort())
  })

  it('admins og hovedadmins må ha tofaktor, moderatorer ikke', () => {
    expect(reason(() => assertCan(active('admin'), 'members.review'))).toBe('two_factor_required')
    expect(reason(() => assertCan(active('owner'), 'roles.manage'))).toBe('two_factor_required')
    expect(can(active('admin'), 'content.moderate')).toBe(false)
    expect(reason(() => assertCan(active('moderator'), 'content.moderate'))).toBe('allowed')
    expect(reason(() => assertCan(active('admin', true), 'members.review'))).toBe('allowed')
  })

  it('mangler rollen, er svaret «forbidden», uavhengig av tofaktor', () => {
    expect(reason(() => assertCan(active('member', true), 'members.review'))).toBe('forbidden')
    expect(reason(() => assertCan(active('admin', true), 'roles.manage'))).toBe('forbidden')
    expect(reason(() => assertCan(null, 'audit.read'))).toBe('unauthenticated')
    expect(
      reason(() =>
        assertCan(
          { ...base, twoFactorEnabled: true, membership: { status: 'inactive', role: 'owner' } },
          'roles.manage',
        ),
      ),
    ).toBe('not_member')
  })
})
