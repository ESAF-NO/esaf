import { createAuth } from './auth-config.server.ts'
import { db } from './db.server.ts'
import { env } from './env.server.ts'

/** Better Auth for appen. Oppsettet og reglene står i `auth-config.server.ts`. */
export const auth = createAuth({
  db,
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  sendVerificationEmail: async ({ user, url }) => {
    if (env.NODE_ENV === 'production') {
      // Ingen e-postleverandør er valgt ennå. Uten den kan ingen bekrefte
      // kontoen i produksjon, og dermed heller ikke logge inn. Se README.
      throw new Error('E-postutsending er ikke konfigurert. Se README, «Før produksjon».')
    }
    console.info(`\n[esaf/app] Bekreftelseslenke for ${user.email}:\n${url}\n`)
  },
})
