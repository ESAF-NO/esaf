import { createAuth } from './auth-config.server.ts'
import { db } from './db.server.ts'
import { env } from './env.server.ts'

/**
 * Better Auth for appen. Oppsettet og reglene står i `auth-config.server.ts`.
 *
 * E-post: uten `EMAIL_PROVIDER` sendes ingen e-post, og registrering er slått
 * av; folk kommer inn med invitasjon. `console` (bare utenfor produksjon)
 * skriver bekreftelseslenkene i terminalen. En ekte leverandør legges til her
 * og i `env.server.ts`. Se README, «Før produksjon».
 */
export const auth = createAuth({
  db,
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  sendVerificationEmail:
    env.EMAIL_PROVIDER === 'console'
      ? async ({ user, url }) => {
          console.info(`\n[esaf/app] Bekreftelseslenke for ${user.email}:\n${url}\n`)
        }
      : undefined,
})
