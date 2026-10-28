import { describe, expect, it } from 'vitest'
import { accessLevel, assertAdmin, assertMember, type Viewer } from '../src/access.ts'
import { AccessDeniedError } from '../src/errors.ts'

const base = { userId: 'u1', emailVerified: true, personId: 'p1' }

const cases: [string, Viewer, string][] = [
  ['ikke innlogget', null, 'anonymous'],
  [
    'ubekreftet e-post',
    { ...base, emailVerified: false, personId: null, membership: null },
    'pending',
  ],
  [
    'ubekreftet e-post selv med aktivt medlemskap',
    { ...base, emailVerified: false, membership: { status: 'active', role: 'admin' } },
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
  ['aktivt medlem', { ...base, membership: { status: 'active', role: 'member' } }, 'member'],
  ['aktiv admin', { ...base, membership: { status: 'active', role: 'admin' } }, 'admin'],
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

describe('assertMember / assertAdmin', () => {
  it('avviser uinnloggede og ikke-godkjente fra medlemsdata', () => {
    expect(reason(() => assertMember(null))).toBe('unauthenticated')
    expect(reason(() => assertMember({ ...base, membership: null }))).toBe('not_member')
    expect(
      reason(() => assertMember({ ...base, membership: { status: 'pending', role: 'member' } })),
    ).toBe('not_member')
  })

  it('krever adminrolle for adminhandlinger', () => {
    const member: Viewer = { ...base, membership: { status: 'active', role: 'member' } }
    const admin: Viewer = { ...base, membership: { status: 'active', role: 'admin' } }
    expect(reason(() => assertMember(member))).toBe('allowed')
    expect(reason(() => assertAdmin(member))).toBe('not_admin')
    expect(reason(() => assertAdmin(admin))).toBe('allowed')
    expect(reason(() => assertAdmin(null))).toBe('unauthenticated')
  })
})
