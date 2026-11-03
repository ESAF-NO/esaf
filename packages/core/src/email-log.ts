import {
  schema,
  type Db,
  type EmailKind,
  type EmailStatus,
  type NotificationEmailFrequency,
} from '@esaf/db'
import { and, desc, eq, ilike, lt, or, sql } from 'drizzle-orm'
import { assertCan, type Viewer } from './access.ts'
import { EmailError, type EmailMessage, type Mailer } from './email.ts'
import {
  invitationEmail,
  notificationEmail,
  passwordLinkEmail,
  passwordResetEmail,
  verificationEmail,
  welcomeEmail,
  type EmailContent,
} from './email-templates.ts'
import { DomainError } from './errors.ts'
import { INVITATION_TTL_DAYS, PASSWORD_REQUEST_TTL_MINUTES } from './invitations.ts'
import {
  INSTANT_DELAY_MS,
  DIGEST_HOUR,
  notificationCategories,
  notificationEmailFrequencies,
} from './notification-email.ts'

const {
  cohort,
  emailLog,
  membership,
  notificationEmailPreference,
  person,
  personCohort,
  personEmail,
  user,
} = schema

/**
 * Oversikten over e-post for admins: hvilke e-poster appen sender og når (med
 * eksempler), hva som er sendt, til hvem og hvordan det gikk. Reglene:
 *
 * - Alt appen sender, går gjennom `withEmailLog`, som skriver én rad per forsøk:
 *   hva slags e-post, adressen, profilen den hører til, emnet og utfallet.
 *   Innholdet lagres ikke, fordi lenkene i e-postene er hemmeligheter.
 * - Loggen slettes etter ett år (`pruneEmailLog`).
 * - Bare admins (`audit.read`) ser loggen og tallene, fordi den viser adresser.
 * - Eksemplene bruker oppdiktede personer og lenker som ikke virker.
 */

export const emailKinds = [
  'invitation',
  'password_link',
  'password_reset',
  'verification',
  'welcome',
  'notification',
  'digest',
  'test',
] as const satisfies readonly EmailKind[]

export const emailKindNames: Record<EmailKind, string> = {
  invitation: 'Invitasjon',
  password_link: 'Lenke for nytt passord fra admin',
  password_reset: 'Glemt passord',
  verification: 'Bekreft e-postadressen',
  welcome: 'Du er med i ESAF',
  notification: 'Varsel',
  digest: 'Oppsummering av varsler',
  test: 'Test fra admin',
}

export const emailStatuses = ['sent', 'bounced', 'failed'] as const satisfies readonly EmailStatus[]

export const emailStatusNames: Record<EmailStatus, string> = {
  sent: 'Sendt',
  bounced: 'Avvist av mottakeren',
  failed: 'Feilet',
}

/** Hvor lenge loggen beholdes. */
export const EMAIL_LOG_RETENTION_DAYS = 365

// ---------------------------------------------------------------------------
// Loggen
// ---------------------------------------------------------------------------

/** Profilen en adresse hører til: kontoen som logger inn med den, ellers adressen på en profil. */
async function personForAddress(db: Db, address: string): Promise<string | null> {
  const email = address.toLowerCase()
  const [own] = await db
    .select({ id: person.id })
    .from(person)
    .innerJoin(user, eq(user.id, person.userId))
    .where(eq(user.email, email))
    .limit(1)
  if (own) return own.id
  const [listed] = await db
    .select({ id: personEmail.personId })
    .from(personEmail)
    .where(eq(personEmail.email, email))
    .limit(1)
  return listed?.id ?? null
}

/**
 * Navnet til den som har en adresse, til hilsenen i e-posten: profilen til
 * kontoen som logger inn med den, ellers profilen adressen står på, ellers
 * navnet fra registreringen. Null når adressen er ukjent (som en ny invitasjon).
 */
export async function nameForAddress(db: Db, address: string): Promise<string | null> {
  const email = address.toLowerCase()
  const [own] = await db
    .select({ fullName: person.fullName })
    .from(person)
    .innerJoin(user, eq(user.id, person.userId))
    .where(eq(user.email, email))
    .limit(1)
  if (own) return own.fullName
  const [listed] = await db
    .select({ fullName: person.fullName })
    .from(personEmail)
    .innerJoin(person, eq(person.id, personEmail.personId))
    .where(eq(personEmail.email, email))
    .limit(1)
  if (listed) return listed.fullName
  const [account] = await db.select({ name: user.name }).from(user).where(eq(user.email, email))
  return account?.name?.trim() || null
}

async function record(
  db: Db,
  message: EmailMessage,
  provider: string,
  status: EmailStatus,
  errorReason: string | null,
) {
  const info = message.log
  if (!info) return
  const personId = info.personId ?? (await personForAddress(db, message.to))
  await db.insert(emailLog).values({
    kind: info.kind,
    toEmail: message.to.toLowerCase(),
    personId,
    subject: message.subject.slice(0, 300),
    status,
    errorReason,
    category: info.category ?? null,
    items: info.items ?? 0,
    provider,
  })
}

/**
 * Mailer som skriver hver sending i e-postloggen. Loggen skrives med egen
 * tilkobling, også når sendingen skjer inne i en transaksjon, så den viser hva
 * som faktisk ble sendt. Feiler loggen, sendes e-posten likevel.
 */
export function withEmailLog(
  db: Db,
  mailer: Mailer,
  log: Pick<Console, 'error'> = console,
): Mailer {
  return {
    provider: mailer.provider,
    async send(message) {
      let status: EmailStatus = 'sent'
      let errorReason: string | null = null
      try {
        await mailer.send(message)
      } catch (error) {
        status = error instanceof EmailError && error.reason === 'bounced' ? 'bounced' : 'failed'
        errorReason = error instanceof EmailError ? error.reason : 'error'
        throw error
      } finally {
        await record(db, message, mailer.provider, status, errorReason).catch((error) =>
          log.error('[esaf/e-post] Kunne ikke skrive e-postloggen:', error),
        )
      }
    },
  }
}

/** Sletter loggen eldre enn ett år. Gir hvor mange rader som ble slettet. */
export async function pruneEmailLog(db: Db, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - EMAIL_LOG_RETENTION_DAYS * 24 * 3600 * 1000)
  const deleted = await db
    .delete(emailLog)
    .where(lt(emailLog.createdAt, cutoff))
    .returning({ id: emailLog.id })
  return deleted.length
}

// ---------------------------------------------------------------------------
// Malene og når de sendes
// ---------------------------------------------------------------------------

export type EmailTemplate = {
  kind: Exclude<EmailKind, 'test'>
  name: string
  /** Hva som gjør at e-posten sendes. */
  trigger: string
  /** Hvem som får den. */
  recipient: string
  /** Når den sendes. */
  timing: string
  /** Hvordan man slutter å få den, eller null for e-poster som bare sendes når man ber om det. */
  unsubscribe: string | null
  /** Eksempelet, med oppdiktede personer og lenker. */
  sample: EmailContent
}

/** Mottakeren i eksemplene: oppdiktet, eller admin selv når det er en test til seg selv. */
export type SampleRecipient = { name: string; graduationYear: number | null }

const sampleRecipient: SampleRecipient = { name: 'Ingrid Berg', graduationYear: 2017 }

/** Alle e-postene appen sender, med eksempler. */
export function emailCatalog(
  appUrl: string,
  recipient: SampleRecipient = sampleRecipient,
): EmailTemplate[] {
  const name = recipient.name
  const url = (path: string) => new URL(path, appUrl).href
  const days = (n: number) => new Date(Date.now() + n * 24 * 3600 * 1000)
  const settings = 'Under Konto → Varsler på e-post, eller med lenken nederst i e-posten.'
  const sampleItems = [
    {
      text: 'Kari Nordmann kommenterte innlegget ditt «Vi lanserer i dag»',
      url: url('/feed/eksempel#kommentar-eksempel'),
      excerpt: 'Gratulerer med lanseringen! Gleder meg til å prøve.',
      reply: true,
    },
    {
      text: 'Ola Hansen fra ES 2017 er med i ESAF nå',
      url: url('/medlemmer/eksempel'),
      excerpt: null,
    },
    {
      text: 'Per Berg foreslår endringer i Eksempel AS',
      url: url('/selskaper/eksempel-as#forslag'),
      excerpt: null,
    },
  ]
  const notification = (summary: boolean, items: typeof sampleItems) =>
    notificationEmail({
      name,
      items,
      summary,
      settingsUrl: url('/konto#varsler'),
      unsubscribeUrl: url('/avmeld?t=eksempel'),
      unsubscribeLabel:
        items.length === 1 ? notificationCategories[0].label : 'alle varsler på e-post',
      allUrl: url('/varsler'),
    })
  return [
    {
      kind: 'invitation',
      name: emailKindNames.invitation,
      trigger:
        'En admin inviterer noen med e-postadresse under Admin → Invitasjoner (eller fra MCP).',
      recipient: 'Adressen admin skrev inn. Den trenger ikke ha konto.',
      timing: `Med en gang. Lenken virker én gang, i ${INVITATION_TTL_DAYS} dager.`,
      unsubscribe: null,
      sample: invitationEmail({
        name,
        url: url('/invitasjon/eksempel'),
        invitedBy: 'Kari Nordmann',
        role: 'member',
        expiresAt: days(INVITATION_TTL_DAYS),
      }),
    },
    {
      kind: 'verification',
      name: emailKindNames.verification,
      trigger: 'Noen registrerer seg selv på /registrer.',
      recipient: 'Adressen de registrerte seg med.',
      timing:
        'Med en gang, og på nytt når de prøver å logge inn uten å ha bekreftet. Lenken virker i én time.',
      unsubscribe: null,
      sample: verificationEmail({
        name,
        url: url('/api/auth/verify-email?token=eksempel'),
        expiresInMinutes: 60,
      }),
    },
    {
      kind: 'welcome',
      name: emailKindNames.welcome,
      trigger:
        'En admin godkjenner en forespørsel om tilgang (Admin → Forespørsler, MCP eller admin:grant).',
      recipient: 'Den som ba om tilgang, til den bekreftede adressen de logger inn med.',
      timing:
        'Innen et minutt. Ikke om de allerede har sett velkomsten i appen. Den som tar imot en invitasjon, får ingen.',
      unsubscribe: null,
      sample: welcomeEmail({ name, url: url('/'), graduationYear: recipient.graduationYear }),
    },
    {
      kind: 'password_reset',
      name: emailKindNames.password_reset,
      trigger: 'Noen trykker «Glemt passord?» på innloggingssiden.',
      recipient: 'Adressen de skrev inn, om den har en aktiv konto.',
      timing: `Med en gang, høyst hvert andre minutt per adresse. Lenken virker i ${PASSWORD_REQUEST_TTL_MINUTES} minutter.`,
      unsubscribe: null,
      sample: passwordResetEmail({
        name,
        url: url('/nytt-passord/eksempel'),
        expiresAt: new Date(Date.now() + PASSWORD_REQUEST_TTL_MINUTES * 60 * 1000),
      }),
    },
    {
      kind: 'password_link',
      name: emailKindNames.password_link,
      trigger: 'En admin lager en lenke for nytt passord til et medlem (Admin → Medlemmer).',
      recipient: 'Adressen medlemmet logger inn med.',
      timing: `Med en gang. Lenken virker én gang, i ${INVITATION_TTL_DAYS} dager.`,
      unsubscribe: null,
      sample: passwordLinkEmail({
        name,
        url: url('/nytt-passord/eksempel'),
        createdBy: 'Kari Nordmann',
        expiresAt: days(INVITATION_TTL_DAYS),
      }),
    },
    {
      kind: 'notification',
      name: emailKindNames.notification,
      trigger:
        'Varsler i appen i kategorier medlemmet har satt til «Med en gang»: kommentarer, omtaler og selskapene deres.',
      recipient: 'Aktive medlemmer med bekreftet e-postadresse, til adressen de logger inn med.',
      timing: `${INSTANT_DELAY_MS / 60_000} minutter etter varselet, så flere samles i én e-post. Ikke om varselet er lest i appen.`,
      unsubscribe: settings,
      sample: notification(false, sampleItems.slice(0, 1)),
    },
    {
      kind: 'digest',
      name: emailKindNames.digest,
      trigger:
        'Uleste varsler i kategorier satt til daglig eller ukentlig oppsummering, som svar i samtaler og nye fra kullet.',
      recipient: 'Aktive medlemmer med bekreftet e-postadresse, til adressen de logger inn med.',
      timing: `Daglig kl. ${String(DIGEST_HOUR).padStart(2, '0')}, ukentlig mandag kl. ${String(DIGEST_HOUR).padStart(2, '0')}, norsk tid. Bare om det er noe nytt.`,
      unsubscribe: settings,
      sample: notification(true, sampleItems),
    },
  ]
}

// ---------------------------------------------------------------------------
// Tallene
// ---------------------------------------------------------------------------

export type EmailCounts = Record<EmailStatus, number>

const noCounts = (): EmailCounts => ({ sent: 0, bounced: 0, failed: 0 })

export type EmailOverview = {
  kinds: {
    kind: EmailKind
    name: string
    last7: EmailCounts
    last30: EmailCounts
    total: EmailCounts
    lastAt: Date | null
  }[]
  last30: EmailCounts
  /** De siste 30 dagene, eldste først, med dag i norsk tid (`YYYY-MM-DD`). */
  daily: { day: string; sent: number; failed: number }[]
  /** Aktive medlemmer med bekreftet konto, som kan få varsler på e-post. */
  recipients: number
  /** Hva de har valgt per kategori. De uten eget valg har standarden. */
  preferences: {
    id: string
    label: string
    default: NotificationEmailFrequency
    counts: Record<NotificationEmailFrequency, number>
  }[]
}

const osloDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Oslo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** Antall sendte e-poster per type og dag, og hva medlemmene har valgt for varsler. */
export async function emailOverview(
  db: Db,
  viewer: Viewer,
  now = new Date(),
): Promise<EmailOverview> {
  assertCan(viewer, 'audit.read')
  const since7 = new Date(now.getTime() - 7 * 24 * 3600 * 1000)
  const since30 = new Date(now.getTime() - 30 * 24 * 3600 * 1000)

  // Etter hverandre, som ellers i core: det holder med én tilkobling.
  const byKind = await db
    .select({
      kind: emailLog.kind,
      status: emailLog.status,
      last7: sql<number>`count(*) filter (where ${emailLog.createdAt} >= ${since7})::int`,
      last30: sql<number>`count(*) filter (where ${emailLog.createdAt} >= ${since30})::int`,
      total: sql<number>`count(*)::int`,
      lastAt: sql<Date>`max(${emailLog.createdAt})`,
    })
    .from(emailLog)
    .groupBy(emailLog.kind, emailLog.status)
  const day = sql<string>`to_char(${emailLog.createdAt} at time zone 'Europe/Oslo', 'YYYY-MM-DD')`
  const perDay = await db
    .select({
      day,
      sent: sql<number>`count(*) filter (where ${emailLog.status} = 'sent')::int`,
      failed: sql<number>`count(*) filter (where ${emailLog.status} <> 'sent')::int`,
    })
    .from(emailLog)
    .where(sql`${emailLog.createdAt} >= ${since30}`)
    .groupBy(day)
  const eligible = and(eq(membership.status, 'active'), eq(user.emailVerified, true))
  const [{ recipients }] = (await db
    .select({ recipients: sql<number>`count(*)::int` })
    .from(person)
    .innerJoin(user, eq(user.id, person.userId))
    .innerJoin(membership, eq(membership.personId, person.id))
    .where(eligible)) as [{ recipients: number }]
  const chosen = await db
    .select({
      category: notificationEmailPreference.category,
      frequency: notificationEmailPreference.frequency,
      people: sql<number>`count(*)::int`,
    })
    .from(notificationEmailPreference)
    .innerJoin(person, eq(person.id, notificationEmailPreference.personId))
    .innerJoin(user, eq(user.id, person.userId))
    .innerJoin(membership, eq(membership.personId, person.id))
    .where(eligible)
    .groupBy(notificationEmailPreference.category, notificationEmailPreference.frequency)

  const kinds = emailKinds.map((kind) => {
    const rows = byKind.filter((r) => r.kind === kind)
    const entry = {
      kind,
      name: emailKindNames[kind],
      last7: noCounts(),
      last30: noCounts(),
      total: noCounts(),
      lastAt: null as Date | null,
    }
    for (const r of rows) {
      entry.last7[r.status] = r.last7
      entry.last30[r.status] = r.last30
      entry.total[r.status] = r.total
      const at = new Date(r.lastAt)
      if (!entry.lastAt || at > entry.lastAt) entry.lastAt = at
    }
    return entry
  })
  const last30 = noCounts()
  for (const k of kinds) for (const s of emailStatuses) last30[s] += k.last30[s]

  const counted = new Map(perDay.map((d) => [d.day, d]))
  const daily = Array.from({ length: 30 }, (_, i) => {
    const key = osloDay.format(new Date(now.getTime() - (29 - i) * 24 * 3600 * 1000))
    const found = counted.get(key)
    return { day: key, sent: found?.sent ?? 0, failed: found?.failed ?? 0 }
  })

  const preferences = notificationCategories.map((c) => {
    const counts = Object.fromEntries(notificationEmailFrequencies.map((f) => [f, 0])) as Record<
      NotificationEmailFrequency,
      number
    >
    let explicit = 0
    for (const r of chosen.filter((r) => r.category === c.id)) {
      counts[r.frequency] += r.people
      explicit += r.people
    }
    counts[c.default] += Math.max(0, recipients - explicit)
    return { id: c.id, label: c.label, default: c.default, counts }
  })

  return { kinds, last30, daily, recipients, preferences }
}

// ---------------------------------------------------------------------------
// Det som er sendt
// ---------------------------------------------------------------------------

export type EmailLogEntry = {
  id: string
  kind: EmailKind
  toEmail: string
  subject: string
  status: EmailStatus
  errorReason: string | null
  category: string | null
  items: number
  provider: string
  createdAt: Date
  person: { personId: string; fullName: string } | null
}

export const EMAIL_LOG_PAGE_SIZE = 50

/**
 * E-postene som er sendt, nyeste først. Bla bakover med `beforeId`. Kan avgrenses
 * til én type, ett utfall, én profil, eller søk i adresse, navn og emne.
 */
export async function listEmailLog(
  db: Db,
  viewer: Viewer,
  options: {
    kind?: EmailKind
    status?: EmailStatus
    personId?: string
    q?: string
    beforeId?: string
    limit?: number
  } = {},
): Promise<EmailLogEntry[]> {
  assertCan(viewer, 'audit.read')
  const q = options.q?.trim()
  const pattern = q ? `%${q.replace(/[%_\\]/g, '\\$&')}%` : null
  const rows = await db
    .select({
      id: emailLog.id,
      kind: emailLog.kind,
      toEmail: emailLog.toEmail,
      subject: emailLog.subject,
      status: emailLog.status,
      errorReason: emailLog.errorReason,
      category: emailLog.category,
      items: emailLog.items,
      provider: emailLog.provider,
      createdAt: emailLog.createdAt,
      personId: person.id,
      fullName: person.fullName,
    })
    .from(emailLog)
    .leftJoin(person, eq(person.id, emailLog.personId))
    .where(
      and(
        options.kind ? eq(emailLog.kind, options.kind) : undefined,
        options.status ? eq(emailLog.status, options.status) : undefined,
        options.personId ? eq(emailLog.personId, options.personId) : undefined,
        pattern
          ? or(
              ilike(emailLog.toEmail, pattern),
              ilike(emailLog.subject, pattern),
              ilike(person.fullName, pattern),
            )
          : undefined,
        options.beforeId
          ? sql`(${emailLog.createdAt}, ${emailLog.id}) < (select cursor.created_at, cursor.id from email_log as cursor where cursor.id = ${options.beforeId}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(emailLog.createdAt), desc(emailLog.id))
    .limit(Math.min(options.limit ?? EMAIL_LOG_PAGE_SIZE, 200))
  return rows.map(({ personId, fullName, ...r }) => ({
    ...r,
    person: personId && fullName ? { personId, fullName } : null,
  }))
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

/**
 * Sender eksempelet på en e-post til adressen admin selv logger inn med, med
 * «[Test]» foran emnet. Til å se hvordan den ser ut i et ekte e-postprogram.
 */
export async function sendTestEmail(
  db: Db,
  viewer: Viewer,
  mailer: Mailer | null,
  input: { kind: string; appUrl: string },
): Promise<{ to: string }> {
  assertCan(viewer, 'audit.read')
  if (!mailer) throw new DomainError('E-post er ikke satt opp på serveren.')
  const [account] = await db
    .select({ email: user.email, fullName: person.fullName })
    .from(user)
    .innerJoin(person, eq(person.userId, user.id))
    .where(eq(user.id, viewer!.userId))
  if (!account) throw new DomainError('Fant ikke kontoen din.')
  // Testen er personlig: navnet ditt, og kullet ditt i velkomsten.
  const [own] = await db
    .select({ year: cohort.graduationYear })
    .from(personCohort)
    .innerJoin(cohort, eq(cohort.id, personCohort.cohortId))
    .where(and(eq(personCohort.personId, viewer!.personId!), eq(personCohort.relation, 'student')))
    .orderBy(desc(cohort.graduationYear))
    .limit(1)
  const template = emailCatalog(input.appUrl, {
    name: account.fullName,
    graduationYear: own?.year ?? null,
  }).find((t) => t.kind === input.kind)
  if (!template) throw new DomainError('Ukjent e-post.')
  try {
    await mailer.send({
      to: account.email,
      ...template.sample,
      subject: `[Test] ${template.sample.subject}`,
      log: { kind: 'test', personId: viewer!.personId },
    })
  } catch (error) {
    // Meldingen sier hva som skjedde, uten adresser eller nøkler.
    if (error instanceof EmailError) throw new DomainError(error.message)
    throw error
  }
  return { to: account.email }
}
