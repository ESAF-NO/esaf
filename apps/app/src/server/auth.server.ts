import { isEmailPaused } from '@esaf/core'
import { createAuth } from './auth-config.server.ts'
import { db } from './db.server.ts'
import {
  logEmailFailure,
  mailer,
  sendLinkEmail,
  sendVerificationEmail,
  VERIFICATION_TTL_SECONDS,
} from './email.server.ts'
import { env } from './env.server.ts'

/**
 * Better Auth for appen. Oppsettet og reglene står i `auth-config.server.ts`.
 *
 * E-post: uten `EMAIL_PROVIDER` sendes ingen e-post, og registrering og «Glemt
 * passord?» er slått av; folk kommer inn med invitasjon. Med leverandør
 * (`console` utenfor produksjon, `cloudflare`) sendes bekreftelseslenken ved
 * registrering og lenker for nytt passord. Se `email.server.ts` og README, «E-post».
 */
export const auth = createAuth({
  db,
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  sendVerificationEmail: mailer
    ? async (data) => {
        // Feilen vises ikke: registreringen svarer likt om adressen har konto fra
        // før, og en ny lenke sendes når personen prøver å logge inn.
        await sendVerificationEmail(data).catch((error) =>
          logEmailFailure(error, 'bekreftelseslenke'),
        )
      }
    : undefined,
  verificationTtlSeconds: VERIFICATION_TTL_SECONDS,
  sendPasswordReset: mailer ? sendLinkEmail : undefined,
  emailPaused: () => isEmailPaused(db),
})
