import { acceptInvitation, InvitationError, resetPasswordWithLink } from '@esaf/core'
import type { Db } from '@esaf/db'
import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthEndpoint } from 'better-auth/api'
import { deleteSessionCookie, setSessionCookie } from 'better-auth/cookies'
import { z } from 'zod'

/** Stiene under, som Better Auth ser dem (uten `/api/auth`). */
export const INVITATION_PATHS = {
  accept: '/invitation/accept',
  resetPassword: '/invitation/reset-password',
} as const

const token = z.string().min(1).max(100)

/** Passordreglene fra Better Auth-oppsettet (minst 12 tegn), som ved registrering. */
function assertPasswordLength(
  password: string,
  config: { minPasswordLength: number; maxPasswordLength: number },
) {
  if (password.length < config.minPasswordLength) {
    throw APIError.from('BAD_REQUEST', {
      code: 'PASSWORD_TOO_SHORT',
      message: 'Password is too short',
    })
  }
  if (password.length > config.maxPasswordLength) {
    throw APIError.from('BAD_REQUEST', {
      code: 'PASSWORD_TOO_LONG',
      message: 'Password is too long',
    })
  }
}

/** Feil ved bruk av lenken, med en kode klienten kan vise norsk tekst for. */
function rethrow(error: unknown): never {
  if (error instanceof InvitationError) {
    throw APIError.from('BAD_REQUEST', {
      code: `INVITATION_${error.code.toUpperCase()}`,
      message: error.message,
    })
  }
  throw error
}

/**
 * Invitasjoner og lenker for nytt passord som Better Auth-endepunkter, så de får
 * Better Auths passordhashing, økter, cookies, opprinnelsessjekk og rate-grenser.
 * Reglene og alt som skrives til databasen, ligger i `invitations.ts` i
 * @esaf/core, i én transaksjon per handling.
 *
 * - `POST /invitation/accept` lager kontoen fra en invitasjon, med passord eller
 *   uten (da legger personen til en passkey rett etterpå), og logger inn.
 * - `POST /invitation/reset-password` setter nytt passord og logger ut alle
 *   økter. Den logger ikke inn: da kunne lenken brukes til å komme forbi tofaktor.
 */
export function invitations(db: Db) {
  return {
    id: 'esaf-invitations',
    endpoints: {
      acceptInvitation: createAuthEndpoint(
        INVITATION_PATHS.accept,
        {
          method: 'POST',
          body: z.object({
            token,
            password: z.string().optional(),
            fullName: z.string().max(200).optional(),
          }),
        },
        async (ctx) => {
          const { password, fullName } = ctx.body
          let passwordHash: string | null = null
          if (password !== undefined) {
            assertPasswordLength(password, ctx.context.password.config)
            passwordHash = await ctx.context.password.hash(password)
          }
          const { userId } = await acceptInvitation(db, {
            token: ctx.body.token,
            passwordHash,
            fullName,
          }).catch(rethrow)
          const user = await ctx.context.internalAdapter.findUserById(userId)
          const session = await ctx.context.internalAdapter.createSession(userId)
          if (!user || !session) {
            throw APIError.from('INTERNAL_SERVER_ERROR', {
              code: 'FAILED_TO_CREATE_SESSION',
              message: 'Failed to create session',
            })
          }
          await setSessionCookie(ctx, { session, user })
          return ctx.json({ status: true })
        },
      ),
      resetPasswordWithLink: createAuthEndpoint(
        INVITATION_PATHS.resetPassword,
        { method: 'POST', body: z.object({ token, password: z.string() }) },
        async (ctx) => {
          assertPasswordLength(ctx.body.password, ctx.context.password.config)
          const passwordHash = await ctx.context.password.hash(ctx.body.password)
          await resetPasswordWithLink(db, { token: ctx.body.token, passwordHash }).catch(rethrow)
          // Alle økter er slettet; også cookien i denne nettleseren fjernes.
          deleteSessionCookie(ctx)
          return ctx.json({ status: true })
        },
      ),
    },
    // Tokenene kan ikke gjettes (256 bit). Grensen er mot misbruk og passordhashing i bulk.
    rateLimit: [
      {
        pathMatcher: (path: string) => path.startsWith('/invitation/'),
        window: 60,
        max: 10,
      },
    ],
  } satisfies BetterAuthPlugin
}
