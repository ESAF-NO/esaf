import { schema } from '@esaf/db'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { tanstackStartCookies } from 'better-auth/tanstack-start'
import { db } from './db.server.ts'
import { env } from './env.server.ts'

/**
 * Innlogging med e-post og passord, og e-postbekreftelse før kontoen kan
 * brukes. En konto gir aldri medlemsinnsyn alene; det styres av `membership`
 * i @esaf/core. Better Auths admin-plugin er bevisst ikke i bruk, og
 * `user`-tabellen har ingen rollefelt som kan settes ved registrering.
 */
export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 12,
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      if (env.NODE_ENV === 'production') {
        // Ingen e-postleverandør er valgt ennå. Uten den kan ingen bekrefte
        // kontoen i produksjon, og dermed heller ikke logge inn. Se README.
        throw new Error('E-postutsending er ikke konfigurert. Se README, «Før produksjon».')
      }
      console.info(`\n[esaf/app] Bekreftelseslenke for ${user.email}:\n${url}\n`)
    },
  },
  plugins: [tanstackStartCookies()],
})
