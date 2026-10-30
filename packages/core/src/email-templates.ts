import type { MemberRole } from '@esaf/db'

/**
 * E-postene appen sender, som ren tekst og enkel HTML med stilene inline (det
 * e-postprogrammer forstår). Begge lages fra de samme avsnittene, så de sier det
 * samme. Alt som settes inn, escapes i HTML-en. Korte og saklige: hva lenken
 * gjør, hvor lenge den virker, og hva man gjør om man ikke ba om den.
 */

export type EmailContent = { subject: string; text: string; html: string }

const SIGNATURE = 'Hilsen ESAF – Entreprenørskolens Alumniforening'

/** Som `roleNames` i appen, med liten forbokstav så de kan stå midt i en setning. */
const roleNames: Record<MemberRole, string> = {
  member: 'medlem',
  moderator: 'moderator',
  admin: 'admin',
  owner: 'hovedadmin',
}

// Tidspunktene står i norsk tid, uansett hvilken tidssone serveren har.
const zone = 'Europe/Oslo'
const stamp = new Intl.DateTimeFormat('nb-NO', {
  timeZone: zone,
  dateStyle: 'long',
  timeStyle: 'short',
})
const clock = new Intl.DateTimeFormat('nb-NO', { timeZone: zone, timeStyle: 'short' })

/** «5. november 2026 kl. 14:05». */
export const formatExpiry = (date: Date) => stamp.format(date)

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

type Template = {
  subject: string
  /** Avsnittene før knappen. */
  intro: string[]
  action: { label: string; url: string }
  /** Avsnittene etter knappen. */
  outro: string[]
}

function render({ subject, intro, action, outro }: Template): EmailContent {
  const text = ['Hei!', ...intro, `${action.label}:\n${action.url}`, ...outro, SIGNATURE].join(
    '\n\n',
  )

  const p = (value: string) =>
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#292524">${escapeHtml(value)}</p>`
  const url = escapeHtml(action.url)
  const html = `<!doctype html>
<html lang="nb">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#fafaf9">
<div style="max-width:520px;margin:0 auto;padding:32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<p style="margin:0 0 24px;font-size:15px;font-weight:600;color:#0c0a09">ESAF</p>
${p('Hei!')}
${intro.map(p).join('\n')}
<p style="margin:24px 0"><a href="${url}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#ea580c;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none">${escapeHtml(action.label)}</a></p>
<p style="margin:0 0 24px;font-size:13px;line-height:1.5;color:#78716c">Virker ikke knappen? Kopier lenken inn i nettleseren:<br><a href="${url}" style="color:#c2410c;word-break:break-all">${url}</a></p>
${outro.map(p).join('\n')}
<p style="margin:24px 0 0;font-size:13px;color:#78716c">${escapeHtml(SIGNATURE)}</p>
</div>
</body>
</html>
`
  return { subject, text, html }
}

/** Når personen logger inn etter å ha valgt nytt passord. Lik for begge slags lenker. */
const AFTER_RESET =
  'Når du har valgt nytt passord, blir du logget ut på alle enheter. Har du tofaktor, trenger du fortsatt koden når du logger inn.'

/** Invitasjon fra en admin (eller styret, fra kommandolinjen). */
export function invitationEmail(input: {
  url: string
  /** Den som inviterte, eller null for styret. */
  invitedBy: string | null
  role: MemberRole
  expiresAt: Date
}): EmailContent {
  const who = input.invitedBy ?? 'Styret i ESAF'
  return render({
    subject: 'Invitasjon til ESAF',
    intro: [
      input.role === 'member'
        ? `${who} har invitert deg til ESAF-appen.`
        : `${who} har invitert deg til ESAF-appen som ${roleNames[input.role]}.`,
      'Åpne lenken for å velge passord eller passkey. Da er du inne.',
    ],
    action: { label: 'Ta imot invitasjonen', url: input.url },
    outro: [
      `Lenken er personlig og gjelder bare denne e-postadressen. Den virker én gang, til ${formatExpiry(input.expiresAt)}.`,
      'Venter du ikke denne invitasjonen, kan du se bort fra e-posten.',
    ],
  })
}

/** Lenke for nytt passord som en admin har laget, etter at personen ba styret om det. */
export function passwordLinkEmail(input: {
  url: string
  /** Admin som laget lenken, eller null for styret. */
  createdBy: string | null
  expiresAt: Date
}): EmailContent {
  return render({
    subject: 'Nytt passord til ESAF',
    intro: [
      `${input.createdBy ?? 'Styret i ESAF'} har laget en lenke du kan bruke til å velge nytt passord i ESAF-appen.`,
    ],
    action: { label: 'Velg nytt passord', url: input.url },
    outro: [
      `Lenken virker én gang, til ${formatExpiry(input.expiresAt)}. ${AFTER_RESET}`,
      'Ba du ikke om dette, kan du se bort fra e-posten. Passordet ditt er ikke endret.',
    ],
  })
}

/** Lenke for nytt passord personen ba om selv («Glemt passord?»). */
export function passwordResetEmail(input: { url: string; expiresAt: Date }): EmailContent {
  return render({
    subject: 'Nytt passord til ESAF',
    intro: ['Noen ba om å få velge nytt passord til ESAF-kontoen med denne e-postadressen.'],
    action: { label: 'Velg nytt passord', url: input.url },
    outro: [
      `Lenken virker én gang, i én time (til kl. ${clock.format(input.expiresAt)}). ${AFTER_RESET}`,
      'Var det ikke deg, kan du se bort fra e-posten. Passordet ditt er ikke endret.',
    ],
  })
}

/** Bekreftelse av e-postadressen etter registrering. */
export function verificationEmail(input: { url: string; expiresInMinutes: number }): EmailContent {
  const duration = input.expiresInMinutes === 60 ? 'én time' : `${input.expiresInMinutes} minutter`
  return render({
    subject: 'Bekreft e-postadressen din',
    intro: [
      'Bekreft at dette er e-postadressen din, så kan du fortsette med å be om tilgang til ESAF-appen.',
    ],
    action: { label: 'Bekreft e-postadressen', url: input.url },
    outro: [
      `Lenken virker i ${duration}.`,
      'Var det ikke deg som registrerte deg, kan du se bort fra e-posten.',
    ],
  })
}
