import { schema, type Db, type EmailKind } from '@esaf/db'
import { asc, eq, inArray, like } from 'drizzle-orm'
import { z } from 'zod'
import { assertCan, type Viewer } from './access.ts'
import { EmailError, type Mailer } from './email.ts'
import { DomainError } from './errors.ts'
import type { Tx } from './members.ts'

const { appSetting, auditEvent, emailBlock, person, personEmail, user } = schema

/**
 * Bryterne for e-post, som admins endrer i appen med en gang og uten deploy:
 *
 * - **All e-post** kan settes på pause.
 * - **Hver type e-post** (invitasjon, varsel, oppsummering …) kan slås av for seg.
 * - **En adresse** kan stoppes, så appen aldri sender dit.
 *
 * Reglene:
 *
 * - Det som er av, sendes ikke, og forsøket står i e-postloggen som feilet, med
 *   grunnen. Invitasjoner og lenker for nytt passord lages likevel, og admin
 *   deler lenken selv.
 * - Registrering krever bekreftelsen, og «Glemt passord?» krever sin e-post.
 *   Er e-posten de trenger av (eller all e-post på pause), er de stengt på
 *   serveren, som når appen ikke har e-post.
 * - Når noe slås på igjen, sendes ikke varslene som kom mens det var av, så
 *   ingen får en bunke gamle varsler. Velkomsten til nye medlemmer sendes.
 * - Til en stoppet adresse prøves det ikke igjen; varslene regnes som ferdige.
 * - Hver endring står i revisjonsloggen, med begrunnelsen.
 * - Uten `EMAIL_PROVIDER` er e-post av uansett; bryterne endrer ikke det.
 */

const PAUSE_KEY = 'email'
const KIND_PREFIX = 'email.kind.'

/** Typene som kan slås av. Testene fra admin følger bare pausen og stoppede adresser. */
export const switchableEmailKinds = [
  'invitation',
  'verification',
  'welcome',
  'password_reset',
  'password_link',
  'notification',
  'digest',
  'access_request',
] as const satisfies readonly EmailKind[]
export type SwitchableEmailKind = (typeof switchableEmailKinds)[number]

type PauseValue = { paused: boolean; reason?: string | null }
type KindValue = { enabled: boolean; reason?: string | null }

type Changed = { at: Date; by: { personId: string; fullName: string } | null }

export type EmailKindSwitch = {
  kind: SwitchableEmailKind
  enabled: boolean
  reason: string | null
  /** Sist endret, og av hvem. Null om den aldri er endret. */
  changed: Changed | null
}

export type EmailSwitch = {
  paused: boolean
  reason: string | null
  /** Sist endret, og av hvem. Null om bryteren aldri er brukt. */
  changedAt: Date | null
  changedBy: { personId: string; fullName: string } | null
  kinds: EmailKindSwitch[]
}

/** Alle bryterne, med hvem som endret dem sist. */
export async function getEmailSwitch(db: Db | Tx): Promise<EmailSwitch> {
  const rows = await db
    .select({
      key: appSetting.key,
      value: appSetting.value,
      updatedAt: appSetting.updatedAt,
      personId: person.id,
      fullName: person.fullName,
    })
    .from(appSetting)
    .leftJoin(person, eq(person.id, appSetting.updatedByPersonId))
    .where(like(appSetting.key, 'email%'))
  const changed = (r: (typeof rows)[number]): Changed => ({
    at: r.updatedAt,
    by: r.personId && r.fullName ? { personId: r.personId, fullName: r.fullName } : null,
  })
  const pause = rows.find((r) => r.key === PAUSE_KEY)
  const pauseValue = (pause?.value ?? { paused: false }) as PauseValue
  return {
    paused: pauseValue.paused === true,
    reason: pauseValue.reason ?? null,
    changedAt: pause ? pause.updatedAt : null,
    changedBy: pause ? changed(pause).by : null,
    kinds: switchableEmailKinds.map((kind) => {
      const row = rows.find((r) => r.key === KIND_PREFIX + kind)
      const value = (row?.value ?? { enabled: true }) as KindValue
      return {
        kind,
        enabled: value.enabled !== false,
        reason: value.reason ?? null,
        changed: row ? changed(row) : null,
      }
    }),
  }
}

export async function isEmailPaused(db: Db | Tx): Promise<boolean> {
  return (await getEmailSwitch(db)).paused
}

/** Om appen kan sende denne typen e-post nå: ikke på pause, og typen er på. */
export async function emailKindAvailable(db: Db | Tx, kind: SwitchableEmailKind): Promise<boolean> {
  const state = await getEmailSwitch(db)
  return !state.paused && state.kinds.find((k) => k.kind === kind)!.enabled
}

/** Når typen sist ble slått på igjen, eller pausen opphevet; det som kom før, sendes ikke. */
export function resumedAt(state: EmailSwitch, kind: SwitchableEmailKind): Date | null {
  const times = [state.changedAt, state.kinds.find((k) => k.kind === kind)!.changed?.at].filter(
    (t): t is Date => t instanceof Date,
  )
  return times.length ? new Date(Math.max(...times.map((t) => t.getTime()))) : null
}

const cleanReason = (reason: string | undefined) => reason?.trim().slice(0, 500) || null

async function saveSetting(
  tx: Tx,
  viewer: Viewer,
  key: string,
  value: PauseValue | KindValue,
  action: string,
  details: Record<string, unknown>,
) {
  await tx
    .insert(appSetting)
    .values({ key, value, updatedByPersonId: viewer!.personId })
    .onConflictDoUpdate({
      target: appSetting.key,
      set: { value, updatedByPersonId: viewer!.personId, updatedAt: new Date() },
    })
  await tx.insert(auditEvent).values({ actorPersonId: viewer!.personId, action, details })
}

/** Setter all e-post på pause eller slår den på igjen. Gjør ingenting om den allerede er slik. */
export async function setEmailPaused(
  db: Db,
  viewer: Viewer,
  input: { paused: boolean; reason?: string },
): Promise<EmailSwitch> {
  assertCan(viewer, 'email.manage')
  const reason = cleanReason(input.reason)
  await db.transaction(async (tx) => {
    if ((await getEmailSwitch(tx)).paused === input.paused) return
    await saveSetting(
      tx,
      viewer,
      PAUSE_KEY,
      { paused: input.paused, reason },
      input.paused ? 'email.pause' : 'email.resume',
      { reason },
    )
  })
  return getEmailSwitch(db)
}

const kindInput = z.object({
  kind: z.enum(switchableEmailKinds, 'Ukjent e-post.'),
  enabled: z.boolean(),
  reason: z.string().max(2000).optional(),
})

/** Slår én type e-post av eller på. Gjør ingenting om den allerede er slik. */
export async function setEmailKindEnabled(
  db: Db,
  viewer: Viewer,
  input: { kind: string; enabled: boolean; reason?: string },
): Promise<EmailSwitch> {
  assertCan(viewer, 'email.manage')
  const parsed = kindInput.safeParse(input)
  if (!parsed.success) throw new DomainError(parsed.error.issues[0]?.message ?? 'Ugyldig valg.')
  const { kind, enabled } = parsed.data
  const reason = cleanReason(parsed.data.reason)
  await db.transaction(async (tx) => {
    const current = (await getEmailSwitch(tx)).kinds.find((k) => k.kind === kind)!
    if (current.enabled === enabled) return
    await saveSetting(
      tx,
      viewer,
      KIND_PREFIX + kind,
      { enabled, reason },
      enabled ? 'email.kind_on' : 'email.kind_off',
      { kind, reason },
    )
  })
  return getEmailSwitch(db)
}

// ---------------------------------------------------------------------------
// Stoppede adresser
// ---------------------------------------------------------------------------

export type EmailBlock = {
  email: string
  reason: string | null
  createdAt: Date
  createdBy: { personId: string; fullName: string } | null
  /** Profilen adressen hører til, om den finnes. */
  person: { personId: string; fullName: string } | null
}

const normalize = (email: string) => email.trim().toLowerCase()

export async function isEmailBlocked(db: Db | Tx, email: string): Promise<boolean> {
  const [row] = await db
    .select({ email: emailBlock.email })
    .from(emailBlock)
    .where(eq(emailBlock.email, normalize(email)))
  return row !== undefined
}

/** Adressene appen ikke sender til, eldste først, med profilen de hører til. */
export async function listEmailBlocks(db: Db, viewer: Viewer): Promise<EmailBlock[]> {
  assertCan(viewer, 'audit.read')
  const blocks = await db
    .select({
      email: emailBlock.email,
      reason: emailBlock.reason,
      createdAt: emailBlock.createdAt,
      byId: person.id,
      byName: person.fullName,
    })
    .from(emailBlock)
    .leftJoin(person, eq(person.id, emailBlock.createdByPersonId))
    .orderBy(asc(emailBlock.createdAt))
  if (!blocks.length) return []
  // Profilen: kontoen som logger inn med adressen, ellers adressen på en profil.
  const emails = blocks.map((b) => b.email)
  const accounts = await db
    .select({ email: user.email, personId: person.id, fullName: person.fullName })
    .from(person)
    .innerJoin(user, eq(user.id, person.userId))
    .where(inArray(user.email, emails))
  const listed = await db
    .select({ email: personEmail.email, personId: person.id, fullName: person.fullName })
    .from(personEmail)
    .innerJoin(person, eq(person.id, personEmail.personId))
    .where(inArray(personEmail.email, emails))
  const owner = new Map<string, { personId: string; fullName: string }>()
  for (const r of [...listed, ...accounts]) {
    owner.set(r.email.toLowerCase(), { personId: r.personId, fullName: r.fullName })
  }
  return blocks.map((b) => ({
    email: b.email,
    reason: b.reason,
    createdAt: b.createdAt,
    createdBy: b.byId && b.byName ? { personId: b.byId, fullName: b.byName } : null,
    person: owner.get(b.email) ?? null,
  }))
}

const blockInput = z.object({
  email: z.email('Ugyldig e-postadresse.').max(254),
  reason: z.string().max(2000).optional(),
})

/** Stopper all e-post til en adresse. Gjør ingenting om den allerede er stoppet. */
export async function blockEmailAddress(
  db: Db,
  viewer: Viewer,
  input: { email: string; reason?: string },
): Promise<void> {
  assertCan(viewer, 'email.manage')
  const parsed = blockInput.safeParse({ ...input, email: normalize(input.email) })
  if (!parsed.success) throw new DomainError(parsed.error.issues[0]?.message ?? 'Ugyldig adresse.')
  const { email } = parsed.data
  const reason = cleanReason(parsed.data.reason)
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(emailBlock)
      .values({ email, reason, createdByPersonId: viewer!.personId })
      .onConflictDoNothing()
      .returning({ email: emailBlock.email })
    if (!inserted.length) return
    await tx.insert(auditEvent).values({
      actorPersonId: viewer!.personId,
      action: 'email.block',
      details: { email, reason },
    })
  })
}

/** Sender til adressen igjen. */
export async function unblockEmailAddress(
  db: Db,
  viewer: Viewer,
  input: { email: string },
): Promise<void> {
  assertCan(viewer, 'email.manage')
  const email = normalize(input.email)
  await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(emailBlock)
      .where(eq(emailBlock.email, email))
      .returning({ email: emailBlock.email })
    if (!deleted.length) return
    await tx.insert(auditEvent).values({
      actorPersonId: viewer!.personId,
      action: 'email.unblock',
      details: { email },
    })
  })
}

// ---------------------------------------------------------------------------
// Håndhevingen
// ---------------------------------------------------------------------------

/**
 * Mailer som ikke sender det som er av: all e-post på pause (`paused`), typen
 * slått av (`disabled`), eller adressen stoppet (`blocked`). Kaster `EmailError`
 * med grunnen, så de som sender, håndterer det som en vanlig feil.
 */
export function withEmailSwitch(db: Db, mailer: Mailer): Mailer {
  return {
    provider: mailer.provider,
    async send(message) {
      const state = await getEmailSwitch(db)
      if (state.paused) throw new EmailError('paused')
      const kind = message.log?.kind
      const off = state.kinds.find((k) => k.kind === kind)
      if (off && !off.enabled) throw new EmailError('disabled')
      if (await isEmailBlocked(db, message.to)) throw new EmailError('blocked')
      await mailer.send(message)
    },
  }
}
