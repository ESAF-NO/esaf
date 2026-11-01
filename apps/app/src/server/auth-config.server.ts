import { oauthProvider } from '@better-auth/oauth-provider'
import { getAuthenticatorName, passkey } from '@better-auth/passkey'
import {
  assertMayApproveMcpClient,
  hashOAuthToken,
  loadViewer,
  mayChangeSignInMethods,
  MCP_OAUTH_SCOPES,
  OAUTH_ACCESS_TOKEN_PREFIX,
  OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  OAUTH_REFRESH_TOKEN_PREFIX,
  OAUTH_REFRESH_TOKEN_TTL_SECONDS,
  recordMcpConnect,
  type CreatedLink,
} from '@esaf/core'
import { schema, type Db } from '@esaf/db'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { twoFactor } from 'better-auth/plugins'
import { tanstackStartCookies } from 'better-auth/tanstack-start'
import { INVITATION_PATHS, invitations } from './invitations-plugin.server.ts'

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

/** Der nettleseren får utfordringen for å logge inn med passkey. */
const PASSKEY_SIGN_IN_OPTIONS = '/passkey/generate-authenticate-options'

/** Private og lokale nett: cloudflared, Traefik og Docker-nettverkene mellom dem. */
export const TRUSTED_PROXIES = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '::1/128',
  'fc00::/7',
]

/** Godkjenningen av en MCP-klient. Bare admins i en sterk økt kommer gjennom. */
const OAUTH_CONSENT = '/oauth2/consent'

/**
 * Endepunktene i OAuth-pluginen som ikke brukes: klienter registrerer seg selv
 * (`/oauth2/register`), og tilkoblinger vises og kobles fra i appen med reglene
 * i @esaf/core (`listMcpConnections`, `disconnectMcpClient`), som også logger.
 */
const UNUSED_OAUTH_PATHS = [
  '/oauth2/create-client',
  '/oauth2/get-client',
  '/oauth2/get-clients',
  '/oauth2/update-client',
  '/oauth2/delete-client',
  '/oauth2/client/rotate-secret',
  '/oauth2/public-client',
  '/oauth2/public-client-prelogin',
  '/oauth2/get-consent',
  '/oauth2/get-consents',
  '/oauth2/update-consent',
  '/oauth2/delete-consent',
  '/oauth2/userinfo',
  '/oauth2/end-session',
]

/** Adressen til MCP-serveren: ressursen OAuth-nøklene utstedes for (RFC 8707). */
export const mcpResourceUrl = (baseURL: string) => new URL('/api/mcp', baseURL).href

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
  /** Hvor lenge bekreftelseslenken virker, i sekunder. */
  verificationTtlSeconds?: number
  /**
   * Sender en lenke for nytt passord personen ba om selv («Glemt passord?»).
   * Uten den (ingen e-postleverandør) finnes ikke endepunktet.
   */
  sendPasswordReset?: (link: CreatedLink) => Promise<void>
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
 * Appen er også OAuth-server for MCP-klienter (se `oauthProvider` under og
 * `mcp-oauth.ts` i @esaf/core): klienter registrerer seg selv, en admin logger
 * inn og godkjenner på `/mcp/godkjenn`, og klienten får en tilgangsnøkkel for
 * `/api/mcp`.
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
        oauthClient: schema.oauthClient,
        oauthResource: schema.oauthResource,
        oauthClientResource: schema.oauthClientResource,
        oauthRefreshToken: schema.oauthRefreshToken,
        oauthAccessToken: schema.oauthAccessToken,
        oauthConsent: schema.oauthConsent,
        oauthClientAssertion: schema.oauthClientAssertion,
      },
    }),
    disabledPaths: UNUSED_OAUTH_PATHS,
    advanced: {
      ipAddress: {
        // I produksjon går forespørslene gjennom Cloudflare-tunnelen og Traefik,
        // som hver legger sin adresse til i X-Forwarded-For. Uten disse som
        // betrodde mellomledd finner Better Auth ingen klientadresse, og alle
        // deler én grense for innloggingsforsøk. Den bakerste adressen som ikke
        // er et privat nett, er klienten. Den kan ikke forfalskes ved å sende
        // headeren selv, for mellomleddene legger alltid til den de så.
        trustedProxies: TRUSTED_PROXIES,
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 12,
      // Håndheves av endepunktet selv, ikke bare ved at skjemaet er skjult.
      disableSignUp: !selfSignUp,
    },
    emailVerification: {
      sendOnSignUp: selfSignUp,
      // Gikk lenken ut før den ble brukt, sendes en ny når personen prøver å logge inn.
      sendOnSignIn: selfSignUp,
      autoSignInAfterVerification: true,
      expiresIn: config.verificationTtlSeconds ?? 60 * 60,
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
      customRules: {
        // Som Better Auths egne grenser for /sign-in/*: tre forsøk per ti sekunder.
        [PASSKEY_SIGN_IN]: { window: 10, max: 3 },
        // Hver forespørsel kan sende en e-post. Grensen per adresse står i @esaf/core.
        [INVITATION_PATHS.requestPasswordReset]: { window: 60, max: 3 },
      },
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
        if (ctx.path === OAUTH_CONSENT && ctx.body?.accept === true) {
          // Godkjenningssiden sjekker det samme, men her avgjøres det.
          const current = await getSessionFromCtx(ctx)
          const viewer = current
            ? await loadViewer(config.db, current.user.id, {
                signedInWithPasskey: current.session.signedInWithPasskey === true,
              })
            : null
          try {
            assertMayApproveMcpClient(viewer)
          } catch {
            throw APIError.from('FORBIDDEN', {
              code: STRONG_AUTH_REQUIRED,
              message: 'Only admins signed in with a passkey or two-factor can approve MCP clients',
            })
          }
          return
        }
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
        if (ctx.path === OAUTH_CONSENT && ctx.body?.accept === true) {
          // Godkjent: i loggen, med klienten og rettighetene som ble gitt.
          if (ctx.context.returned instanceof Error) return
          const current = await getSessionFromCtx(ctx)
          const query = new URLSearchParams(String(ctx.body.oauth_query ?? ''))
          const clientId = query.get('client_id')
          if (!current || !clientId) return
          const viewer = await loadViewer(config.db, current.user.id, {
            signedInWithPasskey: current.session.signedInWithPasskey === true,
          })
          const scopes = String(ctx.body.scope ?? query.get('scope') ?? '').split(' ')
          await recordMcpConnect(config.db, viewer, { clientId, scopes })
          return
        }
        if (ctx.path === PASSKEY_SIGN_IN_OPTIONS) {
          // Pluginen ber bare om at personen bekreftes («preferred»), men vi
          // krever det (se `afterVerification` under). Da hopper Chrome og Google
          // Passordlagring over PIN og fingeravtrykk, og innloggingen avvises
          // etterpå. Med «required» spør nettleseren alltid.
          const options = ctx.context.returned
          if (!options || options instanceof Error || typeof options !== 'object') return
          return ctx.json({ ...options, userVerification: 'required' })
        }
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
      invitations(config.db, { sendPasswordReset: config.sendPasswordReset }),
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
      oauthProvider({
        loginPage: '/api/mcp-oauth/logg-inn',
        consentPage: '/api/mcp-oauth/godkjenn',
        scopes: [...MCP_OAUTH_SCOPES],
        grantTypes: ['authorization_code', 'refresh_token'],
        // Ugjennomsiktige nøkler som slås opp i databasen ved hver forespørsel,
        // så en frakobling eller tapt adminrolle virker med en gang. JWT-er kan
        // ikke trekkes tilbake før de går ut.
        disableJwtPlugin: true,
        storeTokens: { hash: (token) => hashOAuthToken(token) },
        prefix: {
          opaqueAccessToken: OAUTH_ACCESS_TOKEN_PREFIX,
          refreshToken: OAUTH_REFRESH_TOKEN_PREFIX,
        },
        accessTokenExpiresIn: OAUTH_ACCESS_TOKEN_TTL_SECONDS,
        refreshTokenExpiresIn: OAUTH_REFRESH_TOKEN_TTL_SECONDS,
        // En klient som prøver fornyelsen på nytt (f.eks. etter et brudd), får
        // samme svar i 30 sekunder i stedet for å bli logget ut.
        refreshTokenReuseInterval: 30,
        // MCP-klienter registrerer seg selv før innloggingen (RFC 7591). Det gir
        // ingen tilgang: det krever en admins godkjenning.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        // Klienter på maskinen (Claude Code, Codex) sender ofte ikke
        // `application_type`, men bruker http://localhost som tilbakeadresse.
        clientRegistrationDefaultApplicationType: 'infer',
        clientRegistrationDefaultScopes: [...MCP_OAUTH_SCOPES],
        resources: [
          {
            identifier: mcpResourceUrl(config.baseURL),
            name: 'ESAF admin (MCP)',
            allowedScopes: [...MCP_OAUTH_SCOPES],
          },
        ],
        clientRegistrationDefaultResources: [mcpResourceUrl(config.baseURL)],
        // Klienter håndteres ikke fra en økt; de registrerer seg selv.
        clientPrivileges: () => false,
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
