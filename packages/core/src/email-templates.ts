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

/**
 * «Hei Kari!» med fornavnet når vi vet hvem e-posten går til, ellers «Hei!».
 * Fornavnet er det første ordet i navnet.
 */
export function greeting(name: string | null | undefined): string {
  const first = name?.trim().split(/\s+/)[0]
  return first ? `Hei ${first}!` : 'Hei!'
}

/** Navnet til den e-posten går til, når vi vet det. Brukes i hilsenen. */
type To = { name?: string | null }

type Template = {
  subject: string
  /** Navnet til mottakeren, til hilsenen. */
  name?: string | null
  /** Avsnittene før knappen. */
  intro: string[]
  action: { label: string; url: string }
  /** Avsnittene etter knappen. */
  outro: string[]
  /** Små lenker nederst, for eksempel for å melde seg av. */
  links?: { label: string; url: string }[]
}

function render({ subject, name, intro, action, outro, links = [] }: Template): EmailContent {
  const text = [
    greeting(name),
    ...intro,
    `${action.label}:\n${action.url}`,
    ...outro,
    ...links.map((l) => `${l.label}:\n${l.url}`),
    SIGNATURE,
  ].join('\n\n')

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
${p(greeting(name))}
${intro.map(p).join('\n')}
<p style="margin:24px 0"><a href="${url}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#ea580c;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none">${escapeHtml(action.label)}</a></p>
<p style="margin:0 0 24px;font-size:13px;line-height:1.5;color:#78716c">Virker ikke knappen? Kopier lenken inn i nettleseren:<br><a href="${url}" style="color:#c2410c;word-break:break-all">${url}</a></p>
${outro.map(p).join('\n')}
${links.map((l) => `<p style="margin:0 0 8px;font-size:13px;line-height:1.5"><a href="${escapeHtml(l.url)}" style="color:#78716c">${escapeHtml(l.label)}</a></p>`).join('\n')}
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
export function invitationEmail(
  input: {
    url: string
    /** Den som inviterte, eller null for styret. */
    invitedBy: string | null
    role: MemberRole
    expiresAt: Date
  } & To,
): EmailContent {
  const who = input.invitedBy ?? 'Styret i ESAF'
  return render({
    name: input.name,
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
export function passwordLinkEmail(
  input: {
    url: string
    /** Admin som laget lenken, eller null for styret. */
    createdBy: string | null
    expiresAt: Date
  } & To,
): EmailContent {
  return render({
    name: input.name,
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
export function passwordResetEmail(input: { url: string; expiresAt: Date } & To): EmailContent {
  return render({
    name: input.name,
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
export function verificationEmail(
  input: { url: string; expiresInMinutes: number } & To,
): EmailContent {
  const duration = input.expiresInMinutes === 60 ? 'én time' : `${input.expiresInMinutes} minutter`
  return render({
    name: input.name,
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

/** Når en admin har godkjent forespørselen om tilgang. */
export function welcomeEmail(
  input: {
    url: string
    /** Kullet personen ble med i, om det er kjent. */
    graduationYear: number | null
  } & To,
): EmailContent {
  return render({
    name: input.name,
    subject: 'Du er med i ESAF',
    intro: [
      'Forespørselen din om tilgang til ESAF-appen er godkjent.',
      input.graduationYear
        ? `Logg inn for å se hvem fra ES ${input.graduationYear} og de andre kullene som er med, og fyll gjerne ut profilen din.`
        : 'Logg inn for å se hvem som er med, og fyll gjerne ut profilen din.',
    ],
    action: { label: 'Logg inn', url: input.url },
    outro: [
      'Du logger inn med samme e-postadresse og passord eller passkey som da du registrerte deg.',
    ],
  })
}

/**
 * Til adminene når noen venter på godkjenning. Bare antallet: navnet skriver den
 * som ber om tilgang selv, så det hører ikke hjemme i en e-post til adminene.
 */
export function accessRequestEmail(
  input: {
    /** Hvor mange som venter nå. */
    waiting: number
    url: string
    settingsUrl: string
    unsubscribeUrl: string
    /** Hvor mange timer det minst går mellom hver slik e-post. */
    cooldownHours: number
  } & To,
): EmailContent {
  const one = input.waiting === 1
  return render({
    name: input.name,
    subject: one
      ? 'En person venter på godkjenning i ESAF'
      : `${input.waiting} personer venter på godkjenning i ESAF`,
    intro: [
      `${one ? 'En person' : `${input.waiting} personer`} har bedt om tilgang til ESAF-appen. Se hva som er bekreftet før du godkjenner eller avslår.`,
    ],
    action: { label: one ? 'Se forespørselen' : 'Se forespørslene', url: input.url },
    outro: [
      `Alle admins får denne e-posten, så en annen kan ha rukket å svare. Kommer det flere, samles de, så du får høyst én slik e-post hver ${input.cooldownHours}. time.`,
    ],
    links: [
      { label: 'Endre hvilke varsler du får på e-post', url: input.settingsUrl },
      { label: 'Slutt å få forespørsler om tilgang på e-post', url: input.unsubscribeUrl },
    ],
  })
}

/** Ett varsel i en e-post: setningen, lenken og eventuelt starten på teksten. */
export type NotificationEmailItem = {
  /** «Kari Nordmann kommenterte innlegget ditt «Lansering»». */
  text: string
  url: string
  /** Starten på kommentaren eller innlegget. */
  excerpt: string | null
  /** Noe man kan svare på i appen (kommentarer og omtaler). */
  reply?: boolean
}

const MAX_SUBJECT = 120

/**
 * Varsler på e-post: ett varsel med setningen som emne og en knapp, eller flere
 * (samlet, eller i en daglig eller ukentlig oppsummering) som en liste. Under
 * står hvordan man endrer det, og en lenke for å slutte med det.
 */
export function notificationEmail(
  input: {
    items: NotificationEmailItem[]
    /** Fra en daglig eller ukentlig oppsummering. */
    summary: boolean
    settingsUrl: string
    unsubscribeUrl: string
    /** Det avmeldingslenken slår av: «Kommentarer på innleggene dine» eller «alle varsler på e-post». */
    unsubscribeLabel: string
    /** Alle varslene i appen. */
    allUrl: string
  } & To,
): EmailContent {
  const { items } = input
  const one = items.length === 1 ? items[0]! : null
  const count = `${items.length} ${items.length === 1 ? 'varsel' : 'varsler'}`
  const subject = input.summary
    ? `Oppsummering fra ESAF: ${count}`
    : one
      ? one.text.length > MAX_SUBJECT
        ? `${one.text.slice(0, MAX_SUBJECT - 1).trimEnd()}…`
        : one.text
      : `${count} fra ESAF`
  const intro = input.summary
    ? 'Dette har skjedd i ESAF siden sist:'
    : one
      ? null
      : 'Dette har skjedd i ESAF:'
  const action = one
    ? { label: one.reply ? 'Svar i ESAF' : 'Åpne i ESAF', url: one.url }
    : { label: 'Se alle varsler', url: input.allUrl }
  const replyNote = items.some((i) => i.reply)
    ? 'Svar på denne e-posten går til styret i ESAF, ikke til den som skrev. Svar i appen i stedet.'
    : null
  const unsubscribe = `Slutt å få ${input.unsubscribeLabel.toLocaleLowerCase('nb')} på e-post`

  const hello = greeting(input.name)
  const text = [
    hello,
    ...(intro ? [intro] : []),
    ...items.map((i) =>
      [one ? i.text : `• ${i.text}`, i.excerpt && `  «${i.excerpt}»`, one ? null : `  ${i.url}`]
        .filter(Boolean)
        .join('\n'),
    ),
    `${action.label}:\n${action.url}`,
    ...(replyNote ? [replyNote] : []),
    `Endre hvilke varsler du får på e-post:\n${input.settingsUrl}`,
    `${unsubscribe}:\n${input.unsubscribeUrl}`,
    SIGNATURE,
  ].join('\n\n')

  const small = (value: string) =>
    `<p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#78716c">${value}</p>`
  const item = (
    i: NotificationEmailItem,
  ) => `<div style="margin:0 0 16px;padding:14px 16px;border-radius:12px;background:#ffffff;border:1px solid #e7e5e4">
<p style="margin:0;font-size:15px;line-height:1.5;color:#0c0a09"><a href="${escapeHtml(i.url)}" style="color:#0c0a09;text-decoration:none;font-weight:600">${escapeHtml(i.text)}</a></p>
${i.excerpt ? `<p style="margin:6px 0 0;font-size:14px;line-height:1.5;color:#57534e">«${escapeHtml(i.excerpt)}»</p>` : ''}
</div>`
  const url = escapeHtml(action.url)
  const html = `<!doctype html>
<html lang="nb">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#fafaf9">
<div style="max-width:560px;margin:0 auto;padding:32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<p style="margin:0 0 24px;font-size:15px;font-weight:600;color:#0c0a09">ESAF</p>
<p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#292524">${escapeHtml(hello)}</p>
${intro ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#292524">${escapeHtml(intro)}</p>` : ''}
${items.map(item).join('\n')}
<p style="margin:24px 0"><a href="${url}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#ea580c;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none">${escapeHtml(action.label)}</a></p>
<div style="margin:32px 0 0;padding-top:16px;border-top:1px solid #e7e5e4">
${replyNote ? small(escapeHtml(replyNote)) : ''}
${small(`<a href="${escapeHtml(input.settingsUrl)}" style="color:#c2410c">Endre hvilke varsler du får på e-post</a> · <a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#78716c">${escapeHtml(unsubscribe)}</a>`)}
${small(escapeHtml(SIGNATURE))}
</div>
</div>
</body>
</html>
`
  return { subject, text, html }
}
