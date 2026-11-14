import { schema, type Db, type NotificationPayload, type NotificationType } from '@esaf/db'
import { and, desc, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { z } from 'zod'
import { assertMember, type Viewer } from './access.ts'
import { NotFoundError } from './errors.ts'
import { mentionsToPlainText, reachablePeople } from './mentions.ts'
import type { Tx } from './members.ts'

const { cohort, comment, company, experience, notification, person, personCohort, post } = schema

/**
 * Varsler lages i samme transaksjon som det de handler om, så et varsel aldri
 * peker på noe som ikke ble lagret. Reglene:
 *
 * - Ingen får varsel om noe de selv gjorde.
 * - Bare aktive medlemmer med egen konto får varsler.
 * - Én hendelse gir høyst ett varsel per mottaker (unik `eventKey`). Nevner en
 *   kommentar forfatteren av innlegget, blir det ett varsel om omtalen.
 * - Varsler om slettede innlegg og kommentarer skjules.
 */

export const notificationTypes = schema.notificationType.enumValues

export type NewNotification = {
  recipientPersonId: string
  type: NotificationType
  actorPersonId: string | null
  postId?: string
  commentId?: string
  companyId?: string
  eventKey: string
  payload?: NotificationPayload
}

/** Lagrer varslene etter reglene over. Brukes også av forslag og tilknytninger (contributions.ts). */
export async function deliver(tx: Tx, rows: NewNotification[]) {
  const wanted = rows.filter((r) => r.recipientPersonId !== r.actorPersonId)
  if (!wanted.length) return
  const reachable = await reachablePeople(
    tx,
    wanted.map((r) => r.recipientPersonId),
  )
  const values = wanted.filter((r) => reachable.has(r.recipientPersonId))
  if (values.length) await tx.insert(notification).values(values).onConflictDoNothing()
}

/**
 * Noen som ikke er knyttet til selskapet, la til en hendelse, en sak eller en
 * person. Alle som er eller har vært knyttet til selskapet (erfaring eller
 * ES-team) får vite det, så de kan rette eller fjerne det om det er feil.
 * Endringer fra dem som er knyttet til selskapet, gir ikke varsel: de er like mye
 * selskapets som noen andres.
 */
export async function notifyCompanyAddition(
  tx: Tx,
  input: {
    companyId: string
    actorPersonId: string
    kind: NonNullable<NotificationPayload['additionKind']>
    /** Hendelsen, saken eller tilknytningen (forespørselen). */
    id: string
  },
): Promise<void> {
  const [roles, team] = await Promise.all([
    tx
      .selectDistinct({ personId: experience.personId })
      .from(experience)
      .where(eq(experience.companyId, input.companyId)),
    tx.select({ personId: person.id }).from(person).where(eq(person.esCompanyId, input.companyId)),
  ])
  const recipients = [...new Set([...roles, ...team].map((r) => r.personId))]
  await deliver(
    tx,
    recipients.map((recipientPersonId) => ({
      recipientPersonId,
      type: 'company_addition' as const,
      actorPersonId: input.actorPersonId,
      companyId: input.companyId,
      eventKey: `addition:${input.kind}:${input.id}`,
      payload: { additionKind: input.kind },
    })),
  )
}

const commentEvent = (commentId: string) => `comment:${commentId}`
const postEvent = (postId: string) => `post:${postId}`

/**
 * En ny kommentar varsler forfatteren av innlegget, alle som har kommentert
 * innlegget før og alle som er nevnt. Et svar varsler også dem det svares på
 * (`repliedTo`). Rekkefølgen er omtale, svar, kommentar på eget innlegg og til
 * sist kommentar der man selv har kommentert.
 */
export async function notifyComment(
  tx: Tx,
  input: {
    postId: string
    commentId: string
    actorPersonId: string
    mentioned: string[]
    repliedTo?: string[]
  },
): Promise<void> {
  const [target] = await tx
    .select({ authorPersonId: post.authorPersonId })
    .from(post)
    .where(eq(post.id, input.postId))
  const earlier = await tx
    .selectDistinct({ personId: comment.authorPersonId })
    .from(comment)
    .where(
      and(
        eq(comment.postId, input.postId),
        isNull(comment.deletedAt),
        ne(comment.id, input.commentId),
      ),
    )
  const types = new Map<string, NotificationType>()
  for (const { personId } of earlier) types.set(personId, 'comment_on_thread')
  if (target) types.set(target.authorPersonId, 'comment_on_post')
  for (const personId of input.repliedTo ?? []) types.set(personId, 'comment_reply')
  for (const personId of input.mentioned) types.set(personId, 'mention')
  await deliver(
    tx,
    [...types].map(([recipientPersonId, type]) => ({
      recipientPersonId,
      type,
      actorPersonId: input.actorPersonId,
      postId: input.postId,
      commentId: input.commentId,
      eventKey: commentEvent(input.commentId),
    })),
  )
}

/**
 * Varsler dem som er nevnt i et innlegg (uten `commentId`) eller en kommentar.
 * Kan kalles igjen når teksten redigeres: bare de som ikke alt har fått varsel
 * om innlegget eller kommentaren, får et nytt.
 */
export async function notifyMentions(
  tx: Tx,
  input: { postId: string; commentId?: string; actorPersonId: string; mentioned: string[] },
): Promise<void> {
  await deliver(
    tx,
    input.mentioned.map((recipientPersonId) => ({
      recipientPersonId,
      type: 'mention',
      actorPersonId: input.actorPersonId,
      postId: input.postId,
      commentId: input.commentId,
      eventKey: input.commentId ? commentEvent(input.commentId) : postEvent(input.postId),
    })),
  )
}

/**
 * Et nytt medlem er godkjent: velkomst til personen selv, og beskjed til dem
 * som gikk i samme kull og allerede er med. Kalles etter at medlemskapet er
 * aktivt og kontoen er koblet til profilen. Med `emailWelcome` sendes velkomsten
 * også på e-post (se `sendNotificationEmails`): personen ventet på en admin og
 * er ikke i appen nå. Den som tar imot en invitasjon, er i appen og får ingen.
 */
export async function notifyMemberApproved(
  tx: Tx,
  personId: string,
  options: { emailWelcome?: boolean } = {},
): Promise<void> {
  const own = await tx
    .select({ cohortId: personCohort.cohortId, year: cohort.graduationYear })
    .from(personCohort)
    .innerJoin(cohort, eq(cohort.id, personCohort.cohortId))
    .where(and(eq(personCohort.personId, personId), eq(personCohort.relation, 'student')))
    .orderBy(desc(cohort.graduationYear))
  const classmates = own.length
    ? await tx
        .select({ personId: personCohort.personId, year: cohort.graduationYear })
        .from(personCohort)
        .innerJoin(cohort, eq(cohort.id, personCohort.cohortId))
        .where(
          and(
            inArray(
              personCohort.cohortId,
              own.map((c) => c.cohortId),
            ),
            eq(personCohort.relation, 'student'),
            ne(personCohort.personId, personId),
          ),
        )
        .orderBy(desc(cohort.graduationYear))
    : []

  const rows: NewNotification[] = [
    {
      recipientPersonId: personId,
      type: 'welcome',
      actorPersonId: null,
      eventKey: 'welcome',
      payload: {
        ...(own[0] ? { graduationYear: own[0].year } : {}),
        ...(options.emailWelcome ? { emailWelcome: true } : {}),
      },
    },
  ]
  const seen = new Set<string>()
  for (const c of classmates) {
    if (seen.has(c.personId)) continue
    seen.add(c.personId)
    rows.push({
      recipientPersonId: c.personId,
      type: 'cohort_joined',
      actorPersonId: personId,
      eventKey: `joined:${personId}`,
      payload: { graduationYear: c.year },
    })
  }
  await deliver(tx, rows)
}

export type NotificationView = {
  id: string
  type: NotificationType
  createdAt: Date
  read: boolean
  /** Den som utløste varselet. Null for varsler fra ESAF selv. */
  actor: { personId: string; fullName: string; claimed: boolean } | null
  post: { id: string; title: string } | null
  commentId: string | null
  /** Selskapet, for forslag og tilknytninger. Navnet er det gjeldende. */
  company: { slug: string; name: string } | null
  /** Hva et forslag gjaldt: selskapsinfo eller en hendelse. */
  suggestionKind: NotificationPayload['suggestionKind'] | null
  /** Rollen i en tilknytning: gründer, ES-team eller ansatt. */
  linkRole: NotificationPayload['linkRole'] | null
  /** Hva som ble lagt til i selskapet, for `company_addition`. */
  additionKind: NotificationPayload['additionKind'] | null
  /** Starten på kommentaren eller innlegget, med omtaler som vanlig tekst. */
  excerpt: string | null
  graduationYear: number | null
}

export type NotificationPage = { items: NotificationView[]; hasMore: boolean }

const actor = alias(person, 'actor')

const visible = () =>
  and(
    or(isNull(notification.postId), isNull(post.deletedAt)),
    or(isNull(notification.commentId), isNull(comment.deletedAt)),
  )!

const EXCERPT_LENGTH = 160

function excerptOf(text: string | null): string | null {
  if (!text) return null
  const flat = mentionsToPlainText(text).replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > EXCERPT_LENGTH ? `${flat.slice(0, EXCERPT_LENGTH - 1).trimEnd()}…` : flat
}

const notificationId = z.uuid()

/** Den innloggedes varsler, nyeste først. `before` er id-en til det siste varselet på forrige side. */
export async function listNotifications(
  db: Db,
  viewer: Viewer,
  options: { limit?: number; before?: string } = {},
): Promise<NotificationPage> {
  assertMember(viewer)
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50)
  const conditions: SQL[] = [eq(notification.recipientPersonId, viewer.personId)]
  if (options.before !== undefined) {
    if (!notificationId.safeParse(options.before).success) throw new NotFoundError()
    // Rekkefølgen er tid og så id, så varsler fra samme øyeblikk ikke hoppes over.
    conditions.push(
      sql`(${notification.createdAt}, ${notification.id}) < (select n.created_at, n.id from ${notification} n where n.id = ${options.before} and n.recipient_person_id = ${viewer.personId})`,
    )
  }

  const rows = await selectNotificationViews(db, and(...conditions)!, limit + 1)
  return { hasMore: rows.length > limit, items: rows.slice(0, limit) }
}

/** Et varsel med mottakeren, til e-postene. */
export type NotificationViewFor = NotificationView & { recipientPersonId: string }

/**
 * Varslene som oppfyller vilkåret, slik de vises, nyeste først. Slettede innlegg
 * og kommentarer er alltid med i vilkåret, så de aldri vises. Brukes av lista i
 * appen og av e-postene.
 */
export async function selectNotificationViews(
  db: Db | Tx,
  where: SQL,
  limit: number,
): Promise<NotificationViewFor[]> {
  const rows = await db
    .select({
      id: notification.id,
      recipientPersonId: notification.recipientPersonId,
      type: notification.type,
      createdAt: notification.createdAt,
      readAt: notification.readAt,
      payload: notification.payload,
      commentId: notification.commentId,
      actorId: actor.id,
      actorName: actor.fullName,
      actorUserId: actor.userId,
      postId: post.id,
      postTitle: post.title,
      companySlug: company.slug,
      companyName: company.name,
      // Innholdet i innlegget trengs bare til utdrag når varselet gjelder selve innlegget.
      postBody: sql<
        string | null
      >`case when ${notification.commentId} is null then ${post.body} end`,
      commentBody: comment.body,
    })
    .from(notification)
    .leftJoin(actor, eq(actor.id, notification.actorPersonId))
    .leftJoin(post, eq(post.id, notification.postId))
    .leftJoin(comment, eq(comment.id, notification.commentId))
    .leftJoin(company, eq(company.id, notification.companyId))
    .where(and(where, visible()))
    .orderBy(desc(notification.createdAt), desc(notification.id))
    .limit(limit)

  return rows.map((r) => ({
    id: r.id,
    recipientPersonId: r.recipientPersonId,
    type: r.type,
    createdAt: r.createdAt,
    read: r.readAt !== null,
    actor:
      r.actorId && r.actorName
        ? { personId: r.actorId, fullName: r.actorName, claimed: r.actorUserId !== null }
        : null,
    post: r.postId && r.postTitle !== null ? { id: r.postId, title: r.postTitle } : null,
    commentId: r.commentId,
    company: r.companySlug && r.companyName ? { slug: r.companySlug, name: r.companyName } : null,
    suggestionKind: r.payload.suggestionKind ?? null,
    linkRole: r.payload.linkRole ?? null,
    additionKind: r.payload.additionKind ?? null,
    excerpt: excerptOf(r.commentBody ?? r.postBody),
    graduationYear: r.payload.graduationYear ?? null,
  }))
}

/** Antall uleste varsler, til klokka i toppen. */
export async function countUnreadNotifications(db: Db, viewer: Viewer): Promise<number> {
  assertMember(viewer)
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notification)
    .leftJoin(post, eq(post.id, notification.postId))
    .leftJoin(comment, eq(comment.id, notification.commentId))
    .where(
      and(
        eq(notification.recipientPersonId, viewer.personId),
        isNull(notification.readAt),
        visible(),
      ),
    )
  return row?.count ?? 0
}

/**
 * Merker et av den innloggedes varsler som lest. Gjelder det et innlegg, merkes
 * også de andre varslene om samme innlegg: den som åpner innlegget, ser alle
 * kommentarene der.
 */
export async function markNotificationRead(db: Db, viewer: Viewer, id: string): Promise<void> {
  assertMember(viewer)
  if (!notificationId.safeParse(id).success) throw new NotFoundError('Fant ikke varselet.')
  const [target] = await db
    .select({ postId: notification.postId })
    .from(notification)
    .where(and(eq(notification.id, id), eq(notification.recipientPersonId, viewer.personId)))
  if (!target) throw new NotFoundError('Fant ikke varselet.')
  await db
    .update(notification)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notification.recipientPersonId, viewer.personId),
        isNull(notification.readAt),
        target.postId
          ? or(eq(notification.id, id), eq(notification.postId, target.postId))
          : eq(notification.id, id),
      ),
    )
}

export async function markAllNotificationsRead(db: Db, viewer: Viewer): Promise<void> {
  assertMember(viewer)
  await db
    .update(notification)
    .set({ readAt: new Date() })
    .where(and(eq(notification.recipientPersonId, viewer.personId), isNull(notification.readAt)))
}
