import { schema, type Db, type SourceConfidence } from '@esaf/db'
import { and, asc, desc, eq, isNull, ne, or, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { assertCan, assertMember, can, type Viewer } from './access.ts'
import { DomainError, NotFoundError } from './errors.ts'
import { logoUrls, type CompanyLogoUrls } from './logos.ts'
import { photoUrls, type ProfilePhoto } from './photos.ts'
import { hostLabel, optionalSourceUrl, optionalText, safeHttpUrl } from './validation.ts'

const { auditEvent, company, membership, person, quote } = schema

/**
 * Sitater fra ES-ere. Reglene:
 *
 * - Bare aktive medlemmer vises som talere, som ellers i appen. Er taleren en
 *   person som ikke er aktivt medlem (venter, deaktivert), vises ikke sitatet.
 * - Sitater der det er usikkert hvem som sa det (`confidence = 'low'`, f.eks.
 *   et navn hentet automatisk fra en nyhetssak), vises bare for admins med
 *   `profiles.edit`, merket «usikker taler», så de kan rette eller slette dem.
 *   Vanlige medlemmer ser dem aldri, heller ikke som tilfeldig sitat.
 * - Admins kan rette og slette sitater (logges). Den som er sitert, kan selv
 *   fjerne sitater som er knyttet til profilen sin.
 */

export const sourceConfidences = schema.sourceConfidence.enumValues

export type Quote = {
  id: string
  text: string
  speaker: {
    /** Satt når taleren er et aktivt medlem; da lenkes navnet til profilen. */
    personId: string | null
    name: string
    photo: ProfilePhoto | null
    claimed: boolean
  }
  /** Rollen slik kilden skriver den, f.eks. «Daglig leder i OptoScale». */
  role: string | null
  company: { slug: string; name: string; logo: CompanyLogoUrls | null } | null
  /** `YYYY-MM-DD`, når kilden har dato. */
  date: string | null
  source: { label: string; url: string | null } | null
  /** Usikker taler. Bare admins ser slike sitater. */
  review: boolean
  /** Hvor sikker kilden er, bare for admins. */
  confidence: SourceConfidence | null
  canEdit: boolean
  canRemove: boolean
}

const columns = {
  id: quote.id,
  text: quote.text,
  personId: quote.personId,
  speakerName: quote.speakerName,
  speakerRole: quote.speakerRole,
  date: quote.date,
  sourceUrl: quote.sourceUrl,
  sourceLabel: quote.sourceLabel,
  confidence: quote.confidence,
  fullName: person.fullName,
  photoKey: person.photoKey,
  userId: person.userId,
  companySlug: company.slug,
  companyName: company.name,
  companyLogoKey: company.logoKey,
}

/** Sitater uten taler, eller med en taler som er aktivt medlem. */
const speakerVisible = or(isNull(quote.personId), eq(membership.status, 'active'))

function query(db: Db, where: SQL | undefined) {
  return db
    .select(columns)
    .from(quote)
    .leftJoin(person, eq(person.id, quote.personId))
    .leftJoin(membership, eq(membership.personId, quote.personId))
    .leftJoin(company, eq(company.id, quote.companyId))
    .where(and(speakerVisible, where))
}

type Row = Awaited<ReturnType<typeof query>>[number]

function toQuote(viewer: NonNullable<Viewer> & { personId: string }, r: Row): Quote {
  const admin = can(viewer, 'profiles.edit')
  const url = safeHttpUrl(r.sourceUrl)
  const label = r.sourceLabel ?? hostLabel(url)
  return {
    id: r.id,
    text: r.text,
    speaker: {
      personId: r.personId,
      name: r.fullName ?? r.speakerName,
      photo: photoUrls(r.photoKey),
      claimed: r.userId !== null,
    },
    role: r.speakerRole,
    company:
      r.companySlug && r.companyName
        ? { slug: r.companySlug, name: r.companyName, logo: logoUrls(r.companyLogoKey) }
        : null,
    date: r.date,
    source: label ? { label, url } : null,
    review: r.confidence === 'low',
    confidence: admin ? r.confidence : null,
    canEdit: admin,
    canRemove: admin || r.personId === viewer.personId,
  }
}

/** Sitatene til en person eller om et selskap, nyeste først. */
export async function loadQuotes(
  db: Db,
  viewer: Viewer,
  about: { personId: string } | { companyId: string },
): Promise<Quote[]> {
  assertMember(viewer)
  const rows = await query(
    db,
    and(
      'personId' in about
        ? eq(quote.personId, about.personId)
        : eq(quote.companyId, about.companyId),
      can(viewer, 'profiles.edit') ? undefined : ne(quote.confidence, 'low'),
    ),
  ).orderBy(sql`${quote.date} desc nulls last`, asc(quote.createdAt))
  return rows.map((r) => toQuote(viewer, r))
}

/**
 * Et tilfeldig sitat til forsiden. Bare sitater med sikker taler, helst fra et
 * medlem med profil og kort nok til å leses i et lite kort.
 */
export async function randomQuote(db: Db, viewer: Viewer): Promise<Quote | null> {
  assertMember(viewer)
  const [row] = await query(db, ne(quote.confidence, 'low'))
    .orderBy(
      desc(sql`${quote.confidence} = 'high'`),
      desc(sql`${quote.personId} is not null`),
      desc(sql`length(${quote.text}) <= 320`),
      sql`random()`,
    )
    .limit(1)
  return row ? toQuote(viewer, row) : null
}

/** Felles validering når en admin retter et sitat. Tomme felt lagres som `null`. */
export const quoteInput = z.object({
  text: z.string().trim().min(1, 'Sitatet kan ikke være tomt.').max(2000, 'Maks 2000 tegn.'),
  speakerName: z.string().trim().min(2, 'Skriv hvem som sa det.').max(120),
  speakerRole: optionalText(160),
  /** `YYYY-MM-DD`, eller tomt. */
  date: optionalText(10).refine(
    (v) => v === null || (/^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v))),
    'Ugyldig dato.',
  ),
  sourceUrl: optionalSourceUrl,
  sourceLabel: optionalText(80),
  confidence: z.enum(sourceConfidences),
})

export type QuoteInput = z.input<typeof quoteInput>

/** Sitatet slik en admin redigerer det. */
export type EditableQuote = z.output<typeof quoteInput> & { id: string }

async function findQuote(db: Db, quoteId: string) {
  const [row] = await db.select().from(quote).where(eq(quote.id, quoteId))
  if (!row) throw new NotFoundError('Fant ikke sitatet.')
  return row
}

export async function getEditableQuote(
  db: Db,
  viewer: Viewer,
  quoteId: string,
): Promise<EditableQuote> {
  assertCan(viewer, 'profiles.edit')
  const { id, text, speakerName, speakerRole, date, sourceUrl, sourceLabel, confidence } =
    await findQuote(db, quoteId)
  return { id, text, speakerName, speakerRole, date, sourceUrl, sourceLabel, confidence }
}

/** Retter et sitat. Bare admins, og det logges. */
export async function updateQuote(
  db: Db,
  viewer: Viewer,
  quoteId: string,
  input: QuoteInput,
): Promise<void> {
  assertCan(viewer, 'profiles.edit')
  const parsed = quoteInput.safeParse(input)
  if (!parsed.success) throw new DomainError(parsed.error.issues[0]?.message ?? 'Ugyldige felt.')
  const values = parsed.data
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(quote).where(eq(quote.id, quoteId)).for('update')
    if (!current) throw new NotFoundError('Fant ikke sitatet.')
    const changed = (Object.keys(values) as (keyof typeof values)[]).filter(
      (key) => values[key] !== current[key],
    )
    if (!changed.length) return
    await tx.update(quote).set(values).where(eq(quote.id, quoteId))
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'quote.edit',
      subjectPersonId: current.personId,
      details: { quoteId, speaker: values.speakerName, fields: changed },
    })
  })
}

/**
 * Sletter et sitat. Admins kan slette alle (logges); den som er sitert, kan
 * fjerne sitater som er knyttet til profilen sin.
 */
export async function deleteQuote(db: Db, viewer: Viewer, quoteId: string): Promise<void> {
  assertMember(viewer)
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(quote).where(eq(quote.id, quoteId)).for('update')
    if (!current) throw new NotFoundError('Fant ikke sitatet.')
    const own = current.personId !== null && current.personId === viewer.personId
    if (!own) assertCan(viewer, 'profiles.edit')
    await tx.delete(quote).where(eq(quote.id, quoteId))
    if (!own) {
      await tx.insert(auditEvent).values({
        actorPersonId: viewer.personId,
        action: 'quote.remove',
        subjectPersonId: current.personId,
        details: { quoteId, speaker: current.speakerName, text: current.text.slice(0, 200) },
      })
    }
  })
}
