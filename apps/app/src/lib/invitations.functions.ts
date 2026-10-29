import {
  acceptInvitationAsUser,
  createInvitation,
  createPasswordResetLink,
  describeInvitation,
  describeInviteTarget,
  listInvitations,
  mayChangeSignInMethods,
  revokeInvitation,
  roles,
  type CreatedLink,
} from '@esaf/core'
import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { isAPIError } from 'better-auth/api'
import { z } from 'zod'
import { rethrowForClient, withViewer as run } from '#/server/access.server.ts'
import { auth } from '#/server/auth.server.ts'
import { db } from '#/server/db.server.ts'
import { emailEnabled, env } from '#/server/env.server.ts'
import { getRequestViewer } from '#/server/viewer.server.ts'

/**
 * Invitasjoner og lenker for nytt passord. Rettighetene sjekkes i @esaf/core
 * for hvert kall; her sjekkes bare formen.
 *
 * Alt som sender et token eller en e-postadresse, bruker POST, så de havner i
 * forespørselens innhold og ikke i adresser som kan bli logget.
 */

const tokenInput = z.string().min(1).max(100)

/** Lenken slik den deles: appens egen adresse og tokenet, som bare vises nå. */
function shareable(link: CreatedLink) {
  const path = link.kind === 'invite' ? '/invitasjon/' : '/nytt-passord/'
  return {
    url: new URL(path + link.token, env.BETTER_AUTH_URL).href,
    email: link.email,
    role: link.role,
    expiresAt: link.expiresAt,
  }
}

export type ShareableLink = ReturnType<typeof shareable>

/** Om folk kan registrere seg selv (krever e-post), eller bare kommer inn med invitasjon. */
export const fetchAuthOptions = createServerFn({ method: 'GET' }).handler(() => ({
  selfSignUp: emailEnabled,
}))

/** Det siden for en lenke viser. Tokenet er hemmeligheten; ingen innlogging kreves. */
export const fetchLinkDetails = createServerFn({ method: 'POST' })
  .validator(z.object({ token: tokenInput, kind: z.enum(['invite', 'password_reset']) }))
  .handler(({ data }) => describeInvitation(db, data.token, data.kind))

/** Tar imot en invitasjon med kontoen man er logget inn med. */
export const acceptInvitationSignedIn = createServerFn({ method: 'POST' })
  .validator(z.object({ token: tokenInput }))
  .handler(({ data }) => run((viewer) => acceptInvitationAsUser(db, viewer, data.token)))

export const fetchInvitations = createServerFn({ method: 'GET' }).handler(() =>
  run((viewer) => listInvitations(db, viewer)),
)

export const inviteTarget = createServerFn({ method: 'POST' })
  .validator(z.object({ email: z.string().max(254) }))
  .handler(({ data }) => run((viewer) => describeInviteTarget(db, viewer, data.email)))

export const createInvite = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      email: z.string().max(254),
      role: z.enum(roles),
      personId: z.uuid().nullable(),
    }),
  )
  .handler(({ data }) => run(async (viewer) => shareable(await createInvitation(db, viewer, data))))

export const createPasswordLink = createServerFn({ method: 'POST' })
  .validator(z.object({ personId: z.uuid(), reason: z.string().max(500) }))
  .handler(({ data }) =>
    run(async (viewer) => shareable(await createPasswordResetLink(db, viewer, data))),
  )

export const revokeLink = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.uuid() }))
  .handler(({ data }) => run((viewer) => revokeInvitation(db, viewer, data)))

/** Om kontoen har passord. Kontoer fra en invitasjon kan ha bare passkey. */
export const fetchSignInMethods = createServerFn({ method: 'GET' }).handler(async () => {
  try {
    const viewer = await getRequestViewer()
    if (!viewer) return { hasPassword: false }
    const accounts = await auth.api.listUserAccounts({ headers: getRequestHeaders() })
    return { hasPassword: accounts.some((a) => a.providerId === 'credential') }
  } catch (error) {
    return rethrowForClient(error)
  }
})

/**
 * Setter passord på en konto som ikke har det (bare passkey). Å legge til en
 * innloggingsmetode krever sterk innlogging når kontoen har passkey, som for
 * passkeys og tofaktor (`mayChangeSignInMethods`).
 */
export const setFirstPassword = createServerFn({ method: 'POST' })
  .validator(z.object({ password: z.string().max(200) }))
  .handler(async ({ data }) => {
    const viewer = await getRequestViewer()
    if (!viewer) throw new Error('Du må logge inn.')
    if (!mayChangeSignInMethods(viewer)) {
      throw new Error('Logg inn med en av passkeyene dine før du setter passord.')
    }
    try {
      await auth.api.setPassword({
        body: { newPassword: data.password },
        headers: getRequestHeaders(),
      })
    } catch (error) {
      if (!isAPIError(error)) throw error
      const code = (error.body as { code?: string } | undefined)?.code
      throw new Error(
        code === 'PASSWORD_TOO_SHORT'
          ? 'Passordet må ha minst 12 tegn.'
          : code === 'PASSWORD_ALREADY_SET'
            ? 'Kontoen har allerede et passord. Bytt det under «Konto».'
            : code === 'SESSION_NOT_FRESH'
              ? 'Logg ut og inn igjen før du setter passord.'
              : 'Kunne ikke sette passordet.',
        { cause: error },
      )
    }
  })
