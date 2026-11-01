import { createHmac, timingSafeEqual } from 'node:crypto'
import { schema, type Db, type NotificationEmailFrequency, type NotificationType } from '@esaf/db'
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm'
import { z } from 'zod'
import { assertMember, type Viewer } from './access.ts'
import { EmailError, type Mailer } from './email.ts'
import { notificationEmail, type NotificationEmailItem } from './email-templates.ts'
import { DomainError, NotFoundError } from './errors.ts'
import type { Tx } from './members.ts'
import { selectNotificationViews, type NotificationView } from './notifications.ts'

const { membership, notification, notificationEmailPreference, person, user } = schema

/**
 * Varsler på e-post. Reglene:
 *
 * - Varslene i appen (kommentarer, omtaler, selskaper, kullet) kan også komme på
 *   e-post. Hvert medlem velger per kategori: med en gang, daglig eller ukentlig
 *   oppsummering, eller av. Uten valg gjelder standarden for kategorien.
 * - «Med en gang» venter noen minutter, så flere varsler samles i én e-post, og
 *   så den som er i appen og leser varselet der, ikke får e-post i tillegg.
 *   Oppsummeringene sendes kl. 07 norsk tid: daglig hver morgen, ukentlig mandag.
 * - Et varsel som er lest i appen, sendes aldri på e-post. Hvert varsel sendes
 *   høyst én gang, og varsler eldre enn en drøy uke sendes ikke.
 * - Bare aktive medlemmer med egen konto og bekreftet e-postadresse får e-post,
 *   til adressen de logger inn med.
 * - Hver e-post har en lenke for å slutte med den slags e-post, som virker uten
 *   innlogging (signert, se `unsubscribeToken`), og `List-Unsubscribe` med ett
 *   klikk (RFC 8058), så e-postprogrammet kan tilby det selv.
 * - Velkomsten sendes aldri på e-post: den som blir godkjent, er i appen.
 */

export const notificationEmailFrequencies = [
  'instant',
  'daily',
  'weekly',
  'off',
] as const satisfies NotificationEmailFrequency[]

export const notificationEmailFrequencyNames: Record<NotificationEmailFrequency, string> = {
  instant: 'Med en gang',
  daily: 'Daglig oppsummering',
  weekly: 'Ukentlig oppsummering',
  off: 'Av',
}

export type NotificationCategory = {
  id: string
  label: string
  help: string
  types: readonly NotificationType[]
  default: NotificationEmailFrequency
}

/** Kategoriene medlemmene velger for, i rekkefølgen de vises. */
export const notificationCategories = [
  {
    id: 'post_comments',
    label: 'Kommentarer på innleggene dine',
    help: 'Når noen kommenterer noe du har skrevet.',
    types: ['comment_on_post'],
    default: 'instant',
  },
  {
    id: 'mentions',
    label: 'Når noen nevner deg',
    help: 'I et innlegg eller en kommentar.',
    types: ['mention'],
    default: 'instant',
  },
  {
    id: 'thread_comments',
    label: 'Nye svar i samtaler du er med i',
    help: 'Når noen kommenterer et innlegg du også har kommentert.',
    types: ['comment_on_thread'],
    default: 'daily',
  },
  {
    id: 'companies',
    label: 'Selskapene dine',
    help: 'Forslag til selskaper du er knyttet til, svar på forslagene dine, og når noen sier at du var med i et selskap.',
    types: [
      'company_suggestion',
      'suggestion_accepted',
      'suggestion_rejected',
      'company_link_request',
      'company_link_confirmed',
    ],
    default: 'instant',
  },
  {
    id: 'cohort',
    label: 'Nye fra kullet ditt',
    help: 'Når noen fra kullet ditt blir med i ESAF.',
    types: ['cohort_joined'],
    default: 'weekly',
  },
] as const satisfies readonly NotificationCategory[]

export type NotificationCategoryId = (typeof notificationCategories)[number]['id']

const categoryIds = notificationCategories.map((c) => c.id) as [
  NotificationCategoryId,
  ...NotificationCategoryId[],
]

const categoryOf = new Map<NotificationType, NotificationCategory>(
  notificationCategories.flatMap((c) => c.types.map((t) => [t, c] as const)),
)

// ---------------------------------------------------------------------------
// Valgene
// ---------------------------------------------------------------------------

export type EmailPreferences = {
  /** Adressen e-postene sendes til: den man logger inn med. */
  email: string
  categories: (NotificationCategory & { frequency: NotificationEmailFrequency })[]
}

/** Et valg, og når det sist ble endret. */
type Choice = { frequency: NotificationEmailFrequency; since: Date }

async function frequencies(
  db: Db | Tx,
  personIds: string[],
): Promise<Map<string, Map<string, Choice>>> {
  const byPerson = new Map<string, Map<string, Choice>>()
  if (!personIds.length) return byPerson
  const rows = await db
    .select()
    .from(notificationEmailPreference)
    .where(inArray(notificationEmailPreference.personId, [...new Set(personIds)]))
  for (const r of rows) {
    const own = byPerson.get(r.personId) ?? new Map()
    own.set(r.category, { frequency: r.frequency, since: r.updatedAt })
    byPerson.set(r.personId, own)
  }
  return byPerson
}

const frequencyFor = (own: Map<string, Choice> | undefined, category: NotificationCategory) =>
  own?.get(category.id)?.frequency ?? category.default

/** Den innloggedes valg for varsler på e-post. */
export async function getEmailPreferences(db: Db, viewer: Viewer): Promise<EmailPreferences> {
  assertMember(viewer)
  const [account] = await db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, viewer.userId))
  const own = (await frequencies(db, [viewer.personId])).get(viewer.personId)
  return {
    email: account?.email ?? '',
    categories: notificationCategories.map((c) => ({ ...c, frequency: frequencyFor(own, c) })),
  }
}

const preferenceInput = z.object({
  category: z.enum([...categoryIds, 'all'], 'Ukjent kategori.'),
  frequency: z.enum(notificationEmailFrequencies, 'Ugyldig valg.'),
})

async function setFrequency(
  db: Db,
  personId: string,
  category: NotificationCategoryId | 'all',
  frequency: NotificationEmailFrequency,
) {
  const ids = category === 'all' ? categoryIds : [category]
  await db
    .insert(notificationEmailPreference)
    .values(ids.map((c) => ({ personId, category: c, frequency })))
    .onConflictDoUpdate({
      target: [notificationEmailPreference.personId, notificationEmailPreference.category],
      set: { frequency, updatedAt: new Date() },
    })
}

/** Endrer hvor ofte en kategori (eller alle, `all`) sendes på e-post. */
export async function setEmailPreference(
  db: Db,
  viewer: Viewer,
  input: { category: string; frequency: string },
): Promise<void> {
  assertMember(viewer)
  const parsed = preferenceInput.safeParse(input)
  if (!parsed.success) throw new DomainError(parsed.error.issues[0]?.message ?? 'Ugyldig valg.')
  await setFrequency(db, viewer.personId, parsed.data.category, parsed.data.frequency)
}

// ---------------------------------------------------------------------------
// Avmelding uten innlogging
// ---------------------------------------------------------------------------

const sign = (secret: string, payload: string) =>
  createHmac('sha256', secret).update(`varsler-avmeld:${payload}`).digest('base64url')

/**
 * Lenken for å slutte med en kategori (eller alle, `all`) på e-post. Signert med
 * appens hemmelighet, så den virker uten innlogging og ikke kan lages for andre.
 * Den gjør ikke mer enn å slå av e-post; alt annet krever innlogging.
 */
export function unsubscribeToken(
  secret: string,
  personId: string,
  category: NotificationCategoryId | 'all',
): string {
  const payload = `${personId}.${category}`
  return `${Buffer.from(payload).toString('base64url')}.${sign(secret, payload)}`
}

function readUnsubscribeToken(secret: string, token: string) {
  const [encoded, signature] = token.split('.')
  if (!encoded || !signature) return null
  const payload = Buffer.from(encoded, 'base64url').toString('utf8')
  const expected = Buffer.from(sign(secret, payload))
  const given = Buffer.from(signature)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  const [personId, category] = payload.split('.')
  if (!personId || !z.uuid().safeParse(personId).success) return null
  if (category !== 'all' && !(categoryIds as string[]).includes(category ?? '')) return null
  return { personId, category: category as NotificationCategoryId | 'all' }
}

export type UnsubscribeTarget = {
  /** Det som slås av, slik det vises: «Kommentarer på innleggene dine» eller «alle varsler». */
  label: string
  category: NotificationCategoryId | 'all'
}

const labelFor = (category: NotificationCategoryId | 'all') =>
  category === 'all'
    ? 'alle varsler på e-post'
    : notificationCategories.find((c) => c.id === category)!.label

/** Hva lenken slår av, uten å gjøre det. Kaster for ugyldige lenker. */
export function describeUnsubscribe(secret: string, token: string): UnsubscribeTarget {
  const parsed = readUnsubscribeToken(secret, token)
  if (!parsed) throw new NotFoundError('Lenken er ikke gyldig.')
  return { category: parsed.category, label: labelFor(parsed.category) }
}

/** Slår av e-post for kategorien i lenken. Virker uten innlogging, og flere ganger. */
export async function unsubscribe(
  db: Db,
  secret: string,
  token: string,
): Promise<UnsubscribeTarget> {
  const parsed = readUnsubscribeToken(secret, token)
  if (!parsed) throw new NotFoundError('Lenken er ikke gyldig.')
  const [exists] = await db
    .select({ id: person.id })
    .from(person)
    .where(eq(person.id, parsed.personId))
  if (!exists) throw new NotFoundError('Lenken er ikke gyldig.')
  await setFrequency(db, parsed.personId, parsed.category, 'off')
  return { category: parsed.category, label: labelFor(parsed.category) }
}

// ---------------------------------------------------------------------------
// Når varsler skal sendes
// ---------------------------------------------------------------------------

/** Hvor lenge «med en gang» venter, så flere varsler samles og den som leser i appen slipper. */
export const INSTANT_DELAY_MS = 3 * 60 * 1000
/** Varsler eldre enn dette sendes ikke (en uke og litt, så ukesoppsummeringen rekker dem). */
export const EMAIL_WINDOW_MS = 8 * 24 * 60 * 60 * 1000
/** Klokkeslettet oppsummeringene sendes, norsk tid. */
export const DIGEST_HOUR = 7

const zone = 'Europe/Oslo'
const parts = new Intl.DateTimeFormat('en-GB', {
  timeZone: zone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  weekday: 'short',
  hourCycle: 'h23',
})

/** Dato, time og ukedag i norsk tid. */
function oslo(date: Date) {
  const p = Object.fromEntries(parts.formatToParts(date).map((x) => [x.type, x.value]))
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday!),
  }
}

/** Øyeblikket det er `hour`:00 norsk tid på datoen, også rundt sommertid. */
function osloTime(year: number, month: number, day: number, hour: number): Date {
  let guess = Date.UTC(year, month - 1, day, hour)
  for (let i = 0; i < 2; i++) {
    const seen = oslo(new Date(guess))
    const shown = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour)
    guess += Date.UTC(year, month - 1, day, hour) - shown
  }
  return new Date(guess)
}

/** Siste gang oppsummeringen skulle gå: kl. 07 i dag (eller i går), og for uka mandag kl. 07. */
export function digestBoundary(now: Date, frequency: 'daily' | 'weekly'): Date {
  const today = oslo(now)
  let boundary = osloTime(today.year, today.month, today.day, DIGEST_HOUR)
  if (boundary > now) boundary = new Date(boundary.getTime() - 24 * 3600 * 1000)
  if (frequency === 'daily') return boundary
  const day = oslo(boundary)
  const back = day.weekday // mandag = 0
  return osloTime(day.year, day.month, day.day - back, DIGEST_HOUR)
}

/** Om et varsel skal sendes nå, etter hvor ofte mottakeren vil ha det. */
export function isDue(createdAt: Date, frequency: NotificationEmailFrequency, now: Date): boolean {
  if (frequency === 'off') return false
  if (now.getTime() - createdAt.getTime() > EMAIL_WINDOW_MS) return false
  if (frequency === 'instant') return now.getTime() - createdAt.getTime() >= INSTANT_DELAY_MS
  return createdAt < digestBoundary(now, frequency)
}

// ---------------------------------------------------------------------------
// Teksten i e-postene
// ---------------------------------------------------------------------------

const linkRoleNames = { founder: 'gründer', es: 'ES-team', employee: 'ansatt' } as const

/** Varselet som én setning og en lenke, som i appen (se `Notifications.tsx`). */
export function describeNotification(
  n: NotificationView,
  appUrl: string,
): Omit<NotificationEmailItem, 'excerpt'> | null {
  const who = n.actor?.fullName ?? 'Noen'
  const title = n.post ? `«${n.post.title}»` : 'et innlegg'
  const company = n.company?.name ?? 'et selskap'
  const role = n.linkRole ? linkRoleNames[n.linkRole] : 'med'
  const url = (path: string) => new URL(path, appUrl).href
  const postUrl = n.post
    ? url(`/feed/${n.post.id}${n.commentId ? `#kommentar-${n.commentId}` : ''}`)
    : url('/varsler')
  const companyUrl = (hash = '') =>
    n.company ? url(`/selskaper/${n.company.slug}${hash}`) : url('/varsler')
  switch (n.type) {
    case 'comment_on_post':
      return { text: `${who} kommenterte innlegget ditt ${title}`, url: postUrl, reply: true }
    case 'comment_on_thread':
      return { text: `${who} kommenterte også ${title}`, url: postUrl, reply: true }
    case 'mention':
      return {
        text: n.commentId
          ? `${who} nevnte deg i en kommentar til ${title}`
          : `${who} nevnte deg i ${title}`,
        url: postUrl,
        reply: true,
      }
    case 'company_suggestion':
      return {
        text:
          n.suggestionKind === 'event'
            ? `${who} foreslår en ny hendelse i historikken til ${company}`
            : n.suggestionKind === 'article'
              ? `${who} foreslår en sak om ${company} under «I media»`
              : `${who} foreslår endringer i ${company}`,
        url: companyUrl('#forslag'),
      }
    case 'suggestion_accepted':
      return { text: `${who} godtok forslaget ditt til ${company}`, url: companyUrl() }
    case 'suggestion_rejected':
      return { text: `${who} avslo forslaget ditt til ${company}`, url: companyUrl() }
    case 'company_link_request':
      return {
        text: `${who} sier at du var ${role === 'med' ? 'med' : role} i ${company}. Stemmer det?`,
        url: url('/varsler'),
      }
    case 'company_link_confirmed':
      return { text: `${who} bekreftet at de var ${role} i ${company}`, url: companyUrl() }
    case 'cohort_joined':
      return {
        text: `${who}${n.graduationYear ? ` fra ES ${n.graduationYear}` : ''} er med i ESAF nå`,
        url: n.actor ? url(`/medlemmer/${n.actor.personId}`) : url('/medlemmer'),
      }
    case 'welcome':
      return null
  }
}

// ---------------------------------------------------------------------------
// Utsendingen
// ---------------------------------------------------------------------------

export type NotificationEmailRun = {
  /** En annen utsending kjørte allerede. */
  skipped: boolean
  /** E-poster sendt. */
  emails: number
  /** Varsler sendt i dem. */
  notifications: number
  /** E-poster som feilet. */
  failed: number
}

/** Høyst så mange mottakere per runde, så en runde aldri tar lang tid. */
const MAX_RECIPIENTS = 50

/**
 * Sender varslene som skal ut nå, én e-post per mottaker. Kjøres jevnlig av
 * serveren; to samtidige runder (f.eks. under en deploy) sender aldri det samme
 * to ganger, fordi bare én får låsen. Et varsel merkes som sendt først når
 * e-posten er levert til Cloudflare; feiler leverandøren, prøves det igjen neste
 * runde. En adresse som avviser e-posten permanent, prøves ikke igjen.
 */
export async function sendNotificationEmails(
  db: Db,
  options: {
    mailer: Mailer
    /** Appens adresse, f.eks. `https://app.esaf.no`. */
    appUrl: string
    /** Til avmeldingslenkene (`BETTER_AUTH_SECRET`). */
    secret: string
    now?: Date
    log?: Pick<Console, 'error'>
  },
): Promise<NotificationEmailRun> {
  const now = options.now ?? new Date()
  const log = options.log ?? console
  const run: NotificationEmailRun = { skipped: false, emails: 0, notifications: 0, failed: 0 }
  return db.transaction(async (tx) => {
    const [{ locked }] = (
      await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtext('notification_email')) as locked`,
      )
    ).rows as [{ locked: boolean }]
    if (!locked) return { ...run, skipped: true }

    // Uleste, ikke sendte varsler innenfor vinduet, til aktive medlemmer med bekreftet konto.
    const candidates = await tx
      .select({
        id: notification.id,
        recipientPersonId: notification.recipientPersonId,
        type: notification.type,
        createdAt: notification.createdAt,
      })
      .from(notification)
      .innerJoin(person, eq(person.id, notification.recipientPersonId))
      .innerJoin(user, eq(user.id, person.userId))
      .innerJoin(membership, eq(membership.personId, person.id))
      .where(
        and(
          isNull(notification.readAt),
          isNull(notification.emailedAt),
          gte(notification.createdAt, new Date(now.getTime() - EMAIL_WINDOW_MS)),
          lte(notification.createdAt, new Date(now.getTime() - INSTANT_DELAY_MS)),
          eq(membership.status, 'active'),
          eq(user.emailVerified, true),
          isNotNull(person.userId),
        ),
      )
      .orderBy(asc(notification.createdAt))
      .limit(5000)
    if (!candidates.length) return run

    const prefs = await frequencies(
      tx,
      candidates.map((c) => c.recipientPersonId),
    )
    const due = new Map<string, { ids: string[]; categories: Set<string>; digest: boolean }>()
    for (const c of candidates) {
      const category = categoryOf.get(c.type)
      if (!category) continue
      const own = prefs.get(c.recipientPersonId)
      const frequency = frequencyFor(own, category)
      if (!isDue(c.createdAt, frequency, now)) continue
      // Slås e-post på igjen, sendes ikke det som kom mens den var av.
      const since = own?.get(category.id)?.since
      if (since && c.createdAt < since) continue
      const entry = due.get(c.recipientPersonId) ?? {
        ids: [],
        categories: new Set<string>(),
        digest: false,
      }
      entry.ids.push(c.id)
      entry.categories.add(category.id)
      entry.digest ||= frequency !== 'instant'
      due.set(c.recipientPersonId, entry)
    }
    const recipients = [...due.keys()].slice(0, MAX_RECIPIENTS)
    if (!recipients.length) return run

    // Etter hverandre: én tilkobling i transaksjonen kan bare ha én spørring om gangen.
    const accounts = await tx
      .select({ personId: person.id, email: user.email })
      .from(person)
      .innerJoin(user, eq(user.id, person.userId))
      .where(inArray(person.id, recipients))
    const views = await selectNotificationViews(
      tx,
      inArray(
        notification.id,
        recipients.flatMap((r) => due.get(r)!.ids),
      ),
      5000,
    )
    const accountOf = new Map(accounts.map((a) => [a.personId, a]))

    for (const personId of recipients) {
      const account = accountOf.get(personId)
      const entry = due.get(personId)!
      // Nyeste først, som i appen. Varsler om slettet innhold er ikke med i `views`.
      const items = views
        .filter((v) => v.recipientPersonId === personId)
        .flatMap((v) => {
          const described = describeNotification(v, options.appUrl)
          return described ? [{ ...described, excerpt: v.excerpt }] : []
        })
      const sentIds = entry.ids
      if (!account || !items.length) {
        // Ingenting å vise (innholdet er slettet): merkes, så de ikke vurderes igjen.
        await markEmailed(tx, sentIds, now)
        continue
      }
      const single =
        entry.categories.size === 1 ? ([...entry.categories][0] as NotificationCategoryId) : null
      const token = unsubscribeToken(options.secret, personId, single ?? 'all')
      const content = notificationEmail({
        items,
        summary: entry.digest,
        settingsUrl: new URL('/konto#varsler', options.appUrl).href,
        unsubscribeUrl: new URL(`/avmeld?t=${token}`, options.appUrl).href,
        unsubscribeLabel: labelFor(single ?? 'all'),
        allUrl: new URL('/varsler', options.appUrl).href,
      })
      try {
        await options.mailer.send({
          to: account.email,
          ...content,
          headers: {
            'List-Unsubscribe': `<${new URL(`/api/varsler/avmeld?t=${token}`, options.appUrl).href}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        })
        await markEmailed(tx, sentIds, now)
        run.emails++
        run.notifications += items.length
      } catch (error) {
        run.failed++
        if (error instanceof EmailError && error.reason === 'bounced') {
          // Adressen tar ikke imot e-post; prøves ikke igjen.
          await markEmailed(tx, sentIds, now)
          continue
        }
        if (!(error instanceof EmailError)) log.error('[esaf/varsler] E-posten feilet:', error)
        // Leverandøren er nede eller avviser oppsettet: prøv igjen neste runde.
        break
      }
    }
    return run
  })
}

async function markEmailed(tx: Tx, ids: string[], now: Date) {
  if (!ids.length) return
  await tx.update(notification).set({ emailedAt: now }).where(inArray(notification.id, ids))
}
