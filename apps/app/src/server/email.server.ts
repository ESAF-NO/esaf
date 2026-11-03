import {
  createMailer,
  EmailError,
  invitationEmail,
  passwordLinkEmail,
  passwordResetEmail,
  emailKindAvailable,
  verificationEmail,
  withEmailLog,
  withEmailSwitch,
  type CreatedLink,
  type Mailer,
} from '@esaf/core'
import { db } from './db.server.ts'
import { emailConfig, env } from './env.server.ts'

/**
 * E-postene appen sender, med leverandøren fra miljøet (`EMAIL_PROVIDER`).
 * Innholdet står i `email-templates.ts` og sendingen i `email.ts` i @esaf/core.
 * Uten leverandør er `mailer` null, og ingenting sendes. Alt som sendes, skrives
 * i e-postloggen (Admin → E-post).
 */
export const mailer: Mailer | null = emailConfig
  ? withEmailLog(db, withEmailSwitch(db, createMailer(emailConfig)))
  : null

/**
 * Om appen kan sende denne e-posten nå: leverandøren er satt opp, e-post er ikke
 * på pause, og typen er på (Admin → E-post). Registrering og «Glemt passord?»
 * krever sine.
 */
export async function emailAvailable(
  kind: 'verification' | 'password_reset' | 'invitation',
): Promise<boolean> {
  return mailer !== null && (await emailKindAvailable(db, kind))
}

/** Hvor lenge bekreftelseslenken etter registrering virker, i sekunder (som Better Auths standard). */
export const VERIFICATION_TTL_SECONDS = 60 * 60

/** Lenken slik den deles: appens egen adresse og tokenet. */
export function linkUrl(link: Pick<CreatedLink, 'kind' | 'token'>): string {
  const path = link.kind === 'invite' ? '/invitasjon/' : '/nytt-passord/'
  return new URL(path + link.token, env.BETTER_AUTH_URL).href
}

/** `EmailError` er allerede logget med detaljene fra leverandøren; andre feil logges her. */
export function logEmailFailure(error: unknown, what: string) {
  if (error instanceof EmailError) return
  console.error(`[esaf/e-post] Kunne ikke sende ${what}:`, error)
}

function requireMailer(): Mailer {
  if (!mailer) throw new Error('E-post er ikke satt opp (EMAIL_PROVIDER).')
  return mailer
}

/**
 * Sender en lenke som nettopp er laget: en invitasjon, en lenke for nytt passord
 * fra en admin, eller en personen ba om selv. Kaster `EmailError` om den ikke
 * kom fram til leverandøren.
 */
export async function sendLinkEmail(link: CreatedLink): Promise<void> {
  const url = linkUrl(link)
  const content =
    link.kind === 'invite'
      ? invitationEmail({
          url,
          invitedBy: link.createdByName,
          role: link.role,
          expiresAt: link.expiresAt,
        })
      : link.requestedBySelf
        ? passwordResetEmail({ url, expiresAt: link.expiresAt })
        : passwordLinkEmail({ url, createdBy: link.createdByName, expiresAt: link.expiresAt })
  const kind =
    link.kind === 'invite'
      ? 'invitation'
      : link.requestedBySelf
        ? 'password_reset'
        : 'password_link'
  await requireMailer().send({ to: link.email, ...content, log: { kind } })
}

/** Bekreftelseslenken etter registrering. Kalles av Better Auth. */
export async function sendVerificationEmail({
  user,
  url,
}: {
  user: { email: string }
  url: string
}): Promise<void> {
  const content = verificationEmail({ url, expiresInMinutes: VERIFICATION_TTL_SECONDS / 60 })
  await requireMailer().send({ to: user.email, ...content, log: { kind: 'verification' } })
}
