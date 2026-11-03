import { schema, type Db } from '@esaf/db'
import { eq } from 'drizzle-orm'
import { assertCan, type Viewer } from './access.ts'
import { EmailError, type Mailer } from './email.ts'
import type { Tx } from './members.ts'

const { appSetting, auditEvent, person } = schema

/**
 * Bryteren for e-post: en admin kan sette all e-post fra appen på pause, og slå
 * den på igjen, med en gang og uten deploy. Reglene:
 *
 * - På pause sendes ingenting. Invitasjoner og lenker for nytt passord lages som
 *   før, og admin deler lenken selv. Registrering og «Glemt passord?» er stengt,
 *   som når appen ikke har e-post, fordi de ikke virker uten.
 * - Forsøkene står i e-postloggen som feilet, med grunnen «på pause».
 * - Når e-post slås på igjen, sendes ikke varslene som kom mens den var av, så
 *   ingen får en bunke gamle varsler. Velkomsten til nye medlemmer sendes.
 * - Hver endring står i revisjonsloggen, med begrunnelsen.
 * - Uten `EMAIL_PROVIDER` er e-post av uansett; bryteren endrer ikke det.
 */

const KEY = 'email'

type EmailSwitchValue = { paused: boolean; reason?: string | null }

export type EmailSwitch = {
  paused: boolean
  reason: string | null
  /** Sist endret, og av hvem. Null om bryteren aldri er brukt. */
  changedAt: Date | null
  changedBy: { personId: string; fullName: string } | null
}

export async function getEmailSwitch(db: Db | Tx): Promise<EmailSwitch> {
  const [row] = await db
    .select({
      value: appSetting.value,
      updatedAt: appSetting.updatedAt,
      personId: person.id,
      fullName: person.fullName,
    })
    .from(appSetting)
    .leftJoin(person, eq(person.id, appSetting.updatedByPersonId))
    .where(eq(appSetting.key, KEY))
  if (!row) return { paused: false, reason: null, changedAt: null, changedBy: null }
  const value = row.value as EmailSwitchValue
  return {
    paused: value.paused === true,
    reason: value.reason ?? null,
    changedAt: row.updatedAt,
    changedBy:
      row.personId && row.fullName ? { personId: row.personId, fullName: row.fullName } : null,
  }
}

export async function isEmailPaused(db: Db | Tx): Promise<boolean> {
  return (await getEmailSwitch(db)).paused
}

/** Setter e-post på pause eller slår den på igjen. Gjør ingenting om den allerede er slik. */
export async function setEmailPaused(
  db: Db,
  viewer: Viewer,
  input: { paused: boolean; reason?: string },
): Promise<EmailSwitch> {
  assertCan(viewer, 'email.manage')
  const reason = input.reason?.trim().slice(0, 500) || null
  await db.transaction(async (tx) => {
    const current = await getEmailSwitch(tx)
    if (current.paused === input.paused) return
    const value: EmailSwitchValue = { paused: input.paused, reason }
    await tx
      .insert(appSetting)
      .values({ key: KEY, value, updatedByPersonId: viewer.personId })
      .onConflictDoUpdate({
        target: appSetting.key,
        set: { value, updatedByPersonId: viewer.personId, updatedAt: new Date() },
      })
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: input.paused ? 'email.pause' : 'email.resume',
      details: { reason },
    })
  })
  return getEmailSwitch(db)
}

/**
 * Mailer som ikke sender mens e-post er på pause, men kaster `EmailError` med
 * grunnen `paused`, så de som sender, håndterer det som en vanlig feil.
 */
export function withEmailPause(db: Db, mailer: Mailer): Mailer {
  return {
    provider: mailer.provider,
    async send(message) {
      if (await isEmailPaused(db)) throw new EmailError('paused')
      await mailer.send(message)
    },
  }
}
