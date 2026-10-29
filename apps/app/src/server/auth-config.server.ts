import { getAuthenticatorName, passkey } from '@better-auth/passkey'
import { mayChangeSignInMethods } from '@esaf/core'
import { schema, type Db } from '@esaf/db'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { twoFactor } from 'better-auth/plugins'
import { tanstackStartCookies } from 'better-auth/tanstack-start'
import { invitations } from './invitations-plugin.server.ts'

/** Stiene der en passkey-innlogging skjer. Bare her kan en økt bli merket som passkey-økt. */
const PASSKEY_SIGN_IN = '/passkey/verify-authentication'

/**
 * Endepunktene som legger til eller fjerner en innloggingsmetode. Har kontoen
 * passkey, krever de sterk innlogging (se `mayChangeSignInMethods` i @esaf/core).
 * Å gi en passkey nytt navn er ufarlig og er ikke med.
 */
const CHANGES_SIGN_IN_METHODS = new Set([
  '/passkey/generate-register-options',
  '/passkey/verify-registration',
  '/passkey/delete-passkey',
  '/two-factor/enable',
])

export const STRONG_AUTH_REQUIRED = 'STRONG_AUTH_REQUIRED'
export const USER_VERIFICATION_REQUIRED = 'USER_VERIFICATION_REQUIRED'

export type AuthConfig = {
  db: Db
  /** `BETTER_AUTH_URL`. Opprinnelsen og vertsnavnet er også WebAuthn-identiteten. */
  baseURL: string
  secret: string
  /**
   * Sender bekreftelseslenken ved registrering. Uten den (ingen e-postleverandør)
   * er registrering slått av på serveren, og veien inn er en invitasjon.
   */
  sendVerificationEmail?: (data: { user: { email: string }; url: string }) => Promise<void>
}

/**
 * Innlogging med e-post og passord, og e-postbekreftelse før kontoen kan
 * brukes. Uten e-postleverandør er registrering slått av, og kontoer lages bare
 * fra invitasjoner (se `invitations-plugin.server.ts`). Tofaktor med autentiseringsapp (TOTP) og reservekoder, og passkeys
 * (WebAuthn). Admins må være sterkt innlogget: passkey i denne økten, eller
 * tofaktor på kontoen (se `strongAuth` i @esaf/core). En konto gir aldri
 * medlemsinnsyn alene; det styres av `membership` i @esaf/core. Better Auths
 * admin-plugin er bevisst ikke i bruk, og `user`-tabellen har ingen rollefelt
 * som kan settes ved registrering.
 *
 * Egen fabrikk, så integrasjonstestene kan lage en instans mot testdatabasen.
 */
export function createAuth(config: AuthConfig) {
  const base = new URL(config.baseURL)
  const selfSignUp = config.sendVerificationEmail !== undefined

  return betterAuth({
    appName: 'ESAF',
    baseURL: config.baseURL,
    secret: config.secret,
    database: drizzleAdapter(config.db, {
      provider: 'pg',
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        twoFactor: schema.twoFactor,
        passkey: schema.passkey,
      },
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 12,
      // Håndheves av endepunktet selv, ikke bare ved at skjemaet er skjult.
      disableSignUp: !selfSignUp,
    },
    emailVerification: {
      sendOnSignUp: selfSignUp,
      autoSignInAfterVerification: true,
      sendVerificationEmail: config.sendVerificationEmail,
    },
    session: {
      additionalFields: {
        // Settes av hooken under, aldri fra det klienten sender.
        signedInWithPasskey: {
          type: 'boolean',
          required: false,
          defaultValue: false,
          input: false,
        },
      },
    },
    rateLimit: {
      // Som Better Auths egne grenser for /sign-in/*: tre forsøk per ti sekunder.
      customRules: { [PASSKEY_SIGN_IN]: { window: 10, max: 3 } },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session, ctx) => {
            if (ctx?.path !== PASSKEY_SIGN_IN) return
            // Passkey-pluginen sjekker ikke e-postbekreftelsen. Det gjør vi, som
            // innlogging med passord. En passkey kan bare legges til fra en
            // innlogget (og dermed bekreftet) konto, så dette er et ekstra lag.
            const user = await ctx.context.internalAdapter.findUserById(session.userId)
            if (!user?.emailVerified) {
              throw APIError.from('FORBIDDEN', {
                code: 'EMAIL_NOT_VERIFIED',
                message: 'Email not verified',
              })
            }
            return { data: { ...session, signedInWithPasskey: true } }
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (!CHANGES_SIGN_IN_METHODS.has(ctx.path)) return
        const current = await getSessionFromCtx(ctx)
        // Uten økt avviser endepunktet selv forespørselen.
        if (!current) return
        const existing = await ctx.context.adapter.findOne({
          model: 'passkey',
          where: [{ field: 'userId', value: current.user.id }],
        })
        const allowed = mayChangeSignInMethods({
          twoFactorEnabled: current.user.twoFactorEnabled === true,
          passkeySession: current.session.signedInWithPasskey === true,
          hasPasskey: existing !== null,
        })
        if (!allowed) {
          throw APIError.from('FORBIDDEN', {
            code: STRONG_AUTH_REQUIRED,
            message: 'Sign in with a passkey to change sign-in methods',
          })
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        // Den som logger inn med passkey mens de allerede er innlogget (for å
        // oppgradere økten til adminverktøyene), får en ny økt. Den gamle
        // slettes, så den ikke blir liggende igjen uten at noen ser den.
        if (ctx.path !== PASSKEY_SIGN_IN) return
        const created = ctx.context.newSession
        if (!created) return
        const previous = await ctx.getSignedCookie(
          ctx.context.authCookies.sessionToken.name,
          ctx.context.secret,
        )
        if (previous && previous !== created.session.token) {
          await ctx.context.internalAdapter.deleteSession(previous)
        }
      }),
    },
    plugins: [
      invitations(config.db),
      twoFactor({
        issuer: 'ESAF',
        // Ti feil koder på rad låser tofaktor i et kvarter.
        accountLockout: { maxFailedAttempts: 10, durationSeconds: 15 * 60 },
      }),
      passkey({
        rpName: 'ESAF',
        // localhost i utvikling, app.esaf.no i produksjon. Passkeys er bundet til
        // vertsnavnet og virker ikke om appen flyttes til et annet domene.
        rpID: base.hostname,
        // Bare svar fra appens egen opprinnelse godtas, ikke det klienten oppgir.
        origin: base.origin,
        authenticatorSelection: {
          // Lagres i passordhåndtereren, så innlogging kan skje uten e-post først.
          residentKey: 'required',
          // Ansikt, fingeravtrykk eller PIN hver gang: passkeyen er da to faktorer i ett.
          userVerification: 'required',
        },
        registration: {
          afterVerification: ({ verification }) => {
            if (!verification.registrationInfo?.userVerified) throw userVerificationRequired()
            // Navn etter passordhåndtereren når den er kjent, til personen gir et eget.
            const name = getAuthenticatorName(verification.registrationInfo.aaguid)
            return name ? { name } : undefined
          },
        },
        authentication: {
          afterVerification: ({ verification }) => {
            if (!verification.authenticationInfo.userVerified) throw userVerificationRequired()
          },
        },
      }),
      // Må stå sist, så cookiene fra pluginene over også settes.
      tanstackStartCookies(),
    ],
  })
}

function userVerificationRequired() {
  return APIError.from('UNAUTHORIZED', {
    code: USER_VERIFICATION_REQUIRED,
    message: 'The passkey must verify the user (biometrics or PIN)',
  })
}
