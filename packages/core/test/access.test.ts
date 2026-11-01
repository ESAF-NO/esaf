import { describe, expect, it } from 'vitest'
import {
  accessLevel,
  assertCan,
  assertMember,
  can,
  mayChangeSignInMethods,
  permissions,
  roles,
  strongAuth,
  type Permission,
  type SignInFactors,
  type Viewer,
} from '../src/access.ts'
import { AccessDeniedError } from '../src/errors.ts'

const password: SignInFactors = {
  twoFactorEnabled: false,
  passkeySession: false,
  hasPasskey: false,
}
const base = { userId: 'u1', emailVerified: true, ...password, personId: 'p1' }
type Role = (typeof roles)[number]
/** Et aktivt medlem. Uten `factors` er økten startet med bare passord. */
const active = (role: Role, factors: Partial<SignInFactors> = {}): Viewer => ({
  ...base,
  ...factors,
  membership: { status: 'active', role },
})
// Innloggingene som gir sterk økt.
const totp = { twoFactorEnabled: true }
const passkey = { hasPasskey: true, passkeySession: true }
/** Kontoen har bare passkey, men denne økten er startet med passord. */
const passkeyAccountWithPassword = { hasPasskey: true, passkeySession: false }

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
  ['aktiv hovedadmin', active('owner', totp), 'member'],
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
  // Hvilke rettigheter hver rolle har, sterkt innlogget.
  const expected: Record<Role, Permission[]> = {
    member: [],
    moderator: ['content.moderate'],
    admin: [
      'content.moderate',
      'members.review',
      'members.manage',
      'profiles.edit',
      'audit.read',
      'mcp.access',
      'badges.manage',
    ],
    owner: Object.keys(permissions) as Permission[],
  }

  it.each(roles)('%s har akkurat sine rettigheter', (role) => {
    const viewer = active(role, passkey)
    const granted = (Object.keys(permissions) as Permission[]).filter((p) => can(viewer, p))
    expect(granted.sort()).toEqual([...expected[role]].sort())
  })

  it('admins og hovedadmins må være sterkt innlogget, moderatorer ikke', () => {
    expect(reason(() => assertCan(active('admin'), 'members.review'))).toBe('strong_auth_required')
    expect(reason(() => assertCan(active('owner'), 'roles.manage'))).toBe('strong_auth_required')
    expect(can(active('admin'), 'content.moderate')).toBe(false)
    expect(reason(() => assertCan(active('moderator'), 'content.moderate'))).toBe('allowed')
    expect(reason(() => assertCan(active('admin', totp), 'members.review'))).toBe('allowed')
  })

  it('passkey gir sterk innlogging bare når økten er startet med den', () => {
    // Kontoen har passkey, men denne økten kom fra passordet alene.
    const weak = active('owner', passkeyAccountWithPassword)
    expect(reason(() => assertCan(weak, 'roles.manage'))).toBe('strong_auth_required')
    expect(can(weak, 'audit.read')).toBe(false)
    // Samme konto, logget inn med passkey.
    expect(reason(() => assertCan(active('owner', passkey), 'roles.manage'))).toBe('allowed')
    expect(can(active('admin', passkey), 'audit.read')).toBe(true)
    // Med tofaktor er alle økter sterke, uansett passkey.
    const both = active('admin', { ...totp, ...passkeyAccountWithPassword })
    expect(reason(() => assertCan(both, 'members.review'))).toBe('allowed')
    // Moderatorer har ikke noe krav.
    expect(can(active('moderator', passkeyAccountWithPassword), 'content.moderate')).toBe(true)
  })

  it('mangler rollen, er svaret «forbidden», uavhengig av innloggingen', () => {
    expect(reason(() => assertCan(active('member', passkey), 'members.review'))).toBe('forbidden')
    expect(reason(() => assertCan(active('admin', totp), 'roles.manage'))).toBe('forbidden')
    expect(reason(() => assertCan(null, 'audit.read'))).toBe('unauthenticated')
    expect(
      reason(() =>
        assertCan(
          { ...base, ...passkey, membership: { status: 'inactive', role: 'owner' } },
          'roles.manage',
        ),
      ),
    ).toBe('not_member')
  })
})

describe('sterk innlogging', () => {
  it('er passkey-økt eller tofaktor, aldri passord alene', () => {
    expect(strongAuth(password)).toBe(false)
    expect(strongAuth({ ...password, ...passkeyAccountWithPassword })).toBe(false)
    expect(strongAuth({ ...password, ...passkey })).toBe(true)
    expect(strongAuth({ ...password, ...totp })).toBe(true)
  })

  it('en MCP-nøkkel er sterk, men gir ikke mer enn rollen', () => {
    const token = { mcp: { apiTokenId: 'nøkkel', readOnly: false } }
    expect(strongAuth({ ...password, ...token })).toBe(true)
    const admin: Viewer = { ...active('admin')!, ...token }
    expect(reason(() => assertCan(admin, 'profiles.edit'))).toBe('allowed')
    expect(reason(() => assertCan(admin, 'roles.manage'))).toBe('forbidden')
    expect(reason(() => assertCan({ ...active('member')!, ...token }, 'mcp.access'))).toBe(
      'forbidden',
    )
  })

  it('den første metoden kan legges til fra en vanlig økt, men ikke byttes ut uten sterk økt', () => {
    expect(mayChangeSignInMethods(password)).toBe(true)
    expect(mayChangeSignInMethods({ ...password, ...passkeyAccountWithPassword })).toBe(false)
    expect(mayChangeSignInMethods({ ...password, ...passkey })).toBe(true)
    expect(mayChangeSignInMethods({ ...password, ...totp, hasPasskey: true })).toBe(true)
  })
})
