import {
  schema,
  type CompanyLinkRole,
  type CompanySuggestionChanges,
  type CompanySuggestionKind,
  type ContributionStatus,
  type Db,
} from '@esaf/db'
import { and, asc, count, eq, gt, isNull, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { z } from 'zod'
import { assertCan, assertMember, can, type Viewer } from './access.ts'
import {
  companyForEdit,
  companyInput,
  deleteOrphanCompanies,
  isConnected,
  lockCompany,
  pgCode,
  rethrowSlugConflict,
  writeCompanyValues,
  type CompanyInput,
} from './companies.ts'
import { insertArticle, parseArticle } from './company-articles.ts'
import { insertCompany } from './company-admin.ts'
import { companyEventInput, eventValues, resolveProgramme } from './company-events.ts'
import { DomainError, NotFoundError } from './errors.ts'
import { logoUrls, type CompanyLogoUrls } from './logos.ts'
import type { Tx } from './members.ts'
import { deliver } from './notifications.ts'
import { photoUrls, type ProfilePhoto } from './photos.ts'
import { recordFieldEdits } from './sources.ts'
import { optionalText, yearInput } from './validation.ts'

const {
  auditEvent,
  company,
  companyEvent,
  companyLinkRequest,
  companySuggestion,
  experience,
  membership,
  person,
} = schema

/**
 * Bidrag fra medlemmer til selskapssidene. Reglene:
 *
 * - **Seg selv:** Et aktivt medlem kan legge seg selv til i et selskap som
 *   gründer, ES-team eller ansatt (nå eller før). Det gjelder dem selv, så det
 *   lagres med en gang som erfaring eller ES-selskap, akkurat som på profilen.
 *   De kan også fjerne seg selv. Som gründer, ES-team eller ansatt, nå eller før, kan
 *   de redigere selskapet etter de vanlige reglene (`isConnected`).
 * - **Tillit:** Medlemmene er invitert eller godkjent, så det som bare legger til
 *   noe, trenger ingen godkjenning. Det gjelder hendelser, saker (se
 *   `company-events.ts` og `company-articles.ts`) og personer uten konto. Det som
 *   endrer eller fjerner noe andre står bak, gjør de som er knyttet til det.
 * - **Forslag:** Medlemmer som ikke kan redigere selskapet, kan foreslå endringer
 *   i selskapsinfoen (bare feltene som endres lagres, med verdien før og etter).
 *   De som kan redigere selskapet, og admins med `profiles.edit`, godtar eller
 *   avslår. Den som foreslo får varsel, og kan trekke forslaget så lenge det ikke
 *   er behandlet. Ingen behandler sine egne. Forslag om hendelser og saker fra før
 *   de kunne legges til direkte, behandles på samme måte.
 * - **Andre personer:** Sier et medlem at en annen med konto var med i et selskap,
 *   lagres det som en forespørsel personen selv må bekrefte (varsel og knapper
 *   på selskapssiden og profilen). Den vises ikke for andre før den er bekreftet.
 *   Har personen ingen konto, er det ingen å spørre: det vises med en gang og
 *   logges, og personen kan fjerne det når de tar profilen i bruk. Admins kan
 *   avslå forespørsler, for å rydde bort feil.
 * - **Grenser:** Høyst 10 åpne forslag per medlem, 3 per selskap og 20 nye i
 *   døgnet; høyst 20 åpne forespørsler om andre og 20 nye i døgnet.
 * - Admins som behandler noe uten å være knyttet til selskapet, logges.
 */

export const companyLinkRoles = schema.companyLinkRole.enumValues

const LIMITS = {
  pendingSuggestions: 10,
  pendingSuggestionsPerCompany: 3,
  suggestionsPerDay: 20,
  pendingLinks: 20,
  linksPerDay: 20,
}

const DAY_MS = 24 * 60 * 60 * 1000

const year = yearInput(1950)

/** Hva personen var i selskapet. ES-team har verken stilling eller årstall. */
export const companyLinkInput = z
  .object({
    role: z.enum(companyLinkRoles),
    title: optionalText(120),
    startYear: year,
    /** Null betyr at personen fortsatt er der. */
    endYear: year,
  })
  .refine((e) => e.startYear === null || e.endYear === null || e.endYear >= e.startYear, {
    message: 'Sluttåret kan ikke være før startåret.',
  })
  .transform((e) => (e.role === 'es' ? { ...e, title: null, startYear: null, endYear: null } : e))

export type CompanyLinkInput = z.input<typeof companyLinkInput>
type Link = z.output<typeof companyLinkInput>

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new DomainError(parsed.error.issues[0]?.message ?? 'Ugyldige felt.')
  return parsed.data
}

const roleNames: Record<CompanyLinkRole, string> = {
  founder: 'gründer',
  es: 'ES-team',
  employee: 'ansatt',
}

async function companyName(tx: Tx, companyId: string) {
  const [row] = await tx
    .select({ id: company.id, slug: company.slug, name: company.name })
    .from(company)
    .where(eq(company.id, companyId))
  if (!row) throw new NotFoundError('Fant ikke selskapet.')
  return row
}

/**
 * Knytter personen til selskapet: ES-selskap for `es`, ellers en ny erfaring.
 * `owner` betyr at personen selv gjør det (eller bekrefter), så importerte kilder
 * for feltet regnes som bekreftet; ellers gjelder de ikke lenger.
 */
async function applyLink(
  tx: Tx,
  personId: string,
  target: { id: string; name: string },
  link: Link,
  { owner, you }: { owner: boolean; you: boolean },
) {
  const [row] = await tx
    .select({ esCompanyId: person.esCompanyId, esName: company.name })
    .from(person)
    .leftJoin(company, eq(company.id, person.esCompanyId))
    .where(eq(person.id, personId))
    .for('update', { of: person })
  if (!row) throw new NotFoundError('Fant ikke personen.')
  const who = you ? 'Du' : 'Personen'

  if (link.role === 'es') {
    if (row.esCompanyId === target.id) {
      throw new DomainError(`${who} står allerede i ES-teamet til ${target.name}.`)
    }
    if (row.esCompanyId) {
      throw new DomainError(
        `${who} har allerede ${row.esName} som selskap på Entreprenørskolen. Endre det på profilen.`,
      )
    }
    await tx.update(person).set({ esCompanyId: target.id }).where(eq(person.id, personId))
    await recordFieldEdits(tx, 'person', personId, ['esCompany'], owner ? 'confirm' : 'forget')
    return
  }

  const founder = link.role === 'founder'
  const existing = await tx
    .select({
      founder: experience.founder,
      position: experience.position,
      companyId: experience.companyId,
    })
    .from(experience)
    .where(eq(experience.personId, personId))
  if (existing.some((e) => e.companyId === target.id && e.founder === founder)) {
    throw new DomainError(
      `${who} står allerede som ${founder ? 'gründer' : 'ansatt'} i ${target.name}. Endre det på profilen.`,
    )
  }
  if (existing.length >= 30) throw new DomainError('Maks 30 erfaringer.')
  await tx.insert(experience).values({
    personId,
    companyId: target.id,
    founder,
    title: link.title,
    startYear: link.startYear,
    endYear: link.endYear,
    position: Math.max(-1, ...existing.map((e) => e.position)) + 1,
  })
  await recordFieldEdits(tx, 'person', personId, ['experience'], owner ? 'confirm' : 'forget')
}

/** «Jeg var med her»: den innloggede legger seg selv til i selskapet. Gjelder med en gang. */
export async function addSelfToCompany(
  db: Db,
  viewer: Viewer,
  companyId: string,
  input: CompanyLinkInput,
): Promise<void> {
  assertMember(viewer)
  const link = parse(companyLinkInput, input)
  await db.transaction(async (tx) => {
    const target = await companyName(tx, companyId)
    await applyLink(tx, viewer.personId, target, link, { owner: true, you: true })
  })
}

/** Høyst så mange nye selskaper per medlem i døgnet. Admins har ingen grense. */
const COMPANIES_PER_DAY = 5

export type StartCompanyInput = { name: string; link: CompanyLinkInput }

/**
 * «Nytt selskap» for alle medlemmer: lager selskapet og knytter den innloggede
 * til det i samme slengen, som gründer, ES-team eller ansatt. Da kan de fylle ut
 * selskapssiden med en gang. Finnes navnet fra før (også som tidligere navn),
 * skal de bruke «Jeg var med her» der i stedet.
 */
export async function startCompany(
  db: Db,
  viewer: Viewer,
  input: StartCompanyInput,
): Promise<{ id: string; slug: string }> {
  assertMember(viewer)
  const link = parse(companyLinkInput, input.link)
  // Navnet sjekkes som når en admin lager et selskap.
  const values = parse(companyInput, {
    name: input.name,
    tagline: '',
    description: '',
    website: '',
    foundedYear: null,
    location: '',
    industries: [],
    status: 'active',
  })
  try {
    return await db.transaction(async (tx) => {
      if (!can(viewer, 'profiles.edit')) {
        // Låst, så samtidige forespørsler ikke kan omgå grensen.
        await tx
          .select({ id: person.id })
          .from(person)
          .where(eq(person.id, viewer.personId))
          .for('update')
        const [recent] = await tx
          .select({ n: count() })
          .from(auditEvent)
          .where(
            and(
              eq(auditEvent.actorPersonId, viewer.personId),
              eq(auditEvent.action, 'company.create'),
              gt(auditEvent.createdAt, new Date(Date.now() - DAY_MS)),
            ),
          )
        if ((recent?.n ?? 0) >= COMPANIES_PER_DAY) {
          throw new DomainError(
            `Du har lagt til ${COMPANIES_PER_DAY} selskaper det siste døgnet. Prøv igjen i morgen.`,
          )
        }
      }
      const created = await insertCompany(tx, viewer.personId, values, {
        edited: false,
        details: { role: link.role },
      })
      await applyLink(tx, viewer.personId, { id: created.id, name: values.name }, link, {
        owner: true,
        you: true,
      })
      return created
    })
  } catch (error) {
    if (pgCode(error) === '23505') throw new DomainError('Selskapet finnes allerede.')
    throw error
  }
}

export type CompanyToFill = {
  id: string
  slug: string
  name: string
  logo: CompanyLogoUrls | null
  /** Hvordan den innloggede er knyttet til selskapet. */
  role: 'founder' | 'es'
}

/**
 * Selskapene den innloggede har grunnlagt eller hadde på ES, og som ikke har noe
 * info ennå. Der er det de som bør fortelle hva selskapet gjør. Ansatte kan også
 * fylle ut, men får ingen påminnelse; et stort selskap er ikke deres ansvar.
 */
export async function companiesToFill(db: Db, viewer: Viewer): Promise<CompanyToFill[]> {
  assertMember(viewer)
  const bare = and(
    isNull(company.tagline),
    isNull(company.description),
    isNull(company.website),
    isNull(company.location),
    sql`cardinality(${company.industries}) = 0`,
  )
  const columns = {
    id: company.id,
    slug: company.slug,
    name: company.name,
    logoKey: company.logoKey,
  }
  const [founded, es] = await Promise.all([
    db
      .select(columns)
      .from(experience)
      .innerJoin(company, eq(company.id, experience.companyId))
      .where(and(eq(experience.personId, viewer.personId), eq(experience.founder, true), bare)),
    db
      .select(columns)
      .from(person)
      .innerJoin(company, eq(company.id, person.esCompanyId))
      .where(and(eq(person.id, viewer.personId), bare)),
  ])
  const byId = new Map<string, CompanyToFill>()
  for (const [rows, role] of [
    [es, 'es'],
    [founded, 'founder'],
  ] as const) {
    for (const { logoKey, ...row } of rows)
      byId.set(row.id, { ...row, logo: logoUrls(logoKey), role })
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'nb'))
}

/**
 * Fjerner den innloggede fra selskapet: all erfaring der, og ES-selskapet hvis det
 * er dette. Et selskap som bare fantes fordi noen skrev navnet, og som ingen
 * lenger er knyttet til, ryddes bort; da er `companyDeleted` sann.
 */
export async function removeSelfFromCompany(
  db: Db,
  viewer: Viewer,
  companyId: string,
): Promise<{ companyDeleted: boolean }> {
  assertMember(viewer)
  return db.transaction(async (tx) => {
    await companyName(tx, companyId)
    const removed = await tx
      .delete(experience)
      .where(and(eq(experience.personId, viewer.personId), eq(experience.companyId, companyId)))
      .returning({ id: experience.id })
    const es = await tx
      .update(person)
      .set({ esCompanyId: null })
      .where(and(eq(person.id, viewer.personId), eq(person.esCompanyId, companyId)))
      .returning({ id: person.id })
    if (!removed.length && !es.length) {
      throw new DomainError('Du er ikke knyttet til selskapet.')
    }
    // Eieren har selv endret feltene; det de har skrevet, er ikke fra en import.
    await recordFieldEdits(
      tx,
      'person',
      viewer.personId,
      [...(removed.length ? ['experience'] : []), ...(es.length ? ['esCompany'] : [])],
      'confirm',
    )
    await deleteOrphanCompanies(tx, [companyId])
    const [still] = await tx
      .select({ id: company.id })
      .from(company)
      .where(eq(company.id, companyId))
    return { companyDeleted: !still }
  })
}

// ---------------------------------------------------------------------------
// Forslag
// ---------------------------------------------------------------------------

/** En verdi i et forslag slik den vises: tekst, årstall, stikkord eller tomt. */
export type SuggestedValue = string | number | string[] | null

export type SuggestionView = {
  id: string
  kind: CompanySuggestionKind
  company: { id: string; slug: string; name: string; logo: CompanyLogoUrls | null }
  suggestedBy: { personId: string; fullName: string; photo: ProfilePhoto | null; claimed: boolean }
  note: string | null
  createdAt: Date
  /** For `info`: feltene som endres, med verdien da forslaget ble laget og nå. */
  fields: { field: string; from: SuggestedValue; to: SuggestedValue; current: SuggestedValue }[]
  /** For `event`: hendelsen som foreslås. */
  event: Extract<CompanySuggestionChanges, { kind: 'event' }>['event'] | null
  /** For `article`: saken som foreslås. */
  article: Extract<CompanySuggestionChanges, { kind: 'article' }>['article'] | null
  /** Den innloggede foreslo det, og kan trekke det. */
  own: boolean
}

const noteInput = optionalText(500)

/** Sjekker grensene for forslag fra den innloggede. */
async function assertSuggestionQuota(tx: Tx, personId: string, companyId: string) {
  const [pending] = await tx
    .select({
      total: count(),
      here: sql<number>`count(*) filter (where ${companySuggestion.companyId} = ${companyId})::int`,
    })
    .from(companySuggestion)
    .where(
      and(
        eq(companySuggestion.suggestedByPersonId, personId),
        eq(companySuggestion.status, 'pending'),
      ),
    )
  const [recent] = await tx
    .select({ total: count() })
    .from(companySuggestion)
    .where(
      and(
        eq(companySuggestion.suggestedByPersonId, personId),
        gt(companySuggestion.createdAt, new Date(Date.now() - DAY_MS)),
      ),
    )
  if ((pending?.here ?? 0) >= LIMITS.pendingSuggestionsPerCompany) {
    throw new DomainError(
      `Du har allerede ${LIMITS.pendingSuggestionsPerCompany} forslag som venter her. Vent til de er behandlet, eller trekk et av dem.`,
    )
  }
  if ((pending?.total ?? 0) >= LIMITS.pendingSuggestions) {
    throw new DomainError(
      `Du har ${LIMITS.pendingSuggestions} forslag som venter på behandling. Vent til noen av dem er behandlet.`,
    )
  }
  if ((recent?.total ?? 0) >= LIMITS.suggestionsPerDay) {
    throw new DomainError('Du har sendt mange forslag det siste døgnet. Prøv igjen i morgen.')
  }
}

/**
 * Forslag kan bare komme fra medlemmer som ikke kan redigere selskapet selv.
 * Låser selskapet, så grensene ikke kan omgås med samtidige forslag.
 */
async function startSuggestion(
  tx: Tx,
  viewer: NonNullable<Viewer> & { personId: string },
  companyId: string,
) {
  const current = await lockCompany(tx, companyId)
  if (await isConnected(tx, viewer.personId, companyId)) {
    throw new DomainError('Du er knyttet til selskapet og kan redigere det selv.')
  }
  // Grensen per person gjelder på tvers av selskaper; låsen på personen hindrer samtidige forslag.
  await tx
    .select({ id: person.id })
    .from(person)
    .where(eq(person.id, viewer.personId))
    .for('update')
  await assertSuggestionQuota(tx, viewer.personId, companyId)
  return current
}

/** Varsler dem som kan godta forslaget: gründere, ES-teamet og ansatte, nå eller før. */
async function notifyConnected(
  tx: Tx,
  companyId: string,
  actorPersonId: string,
  suggestionId: string,
  kind: CompanySuggestionKind,
) {
  const roles = await tx
    .selectDistinct({ personId: experience.personId })
    .from(experience)
    .where(and(eq(experience.companyId, companyId)))
  const team = await tx
    .select({ personId: person.id })
    .from(person)
    .where(eq(person.esCompanyId, companyId))
  const recipients = [...new Set([...roles, ...team].map((r) => r.personId))]
  await deliver(
    tx,
    recipients.map((recipientPersonId) => ({
      recipientPersonId,
      type: 'company_suggestion' as const,
      actorPersonId,
      companyId,
      eventKey: `suggestion:${suggestionId}`,
      payload: { suggestionId, suggestionKind: kind },
    })),
  )
}

/**
 * Foreslår endringer i selskapsinfoen. `input` er hele skjemaet; bare feltene som
 * er forskjellige fra det som står nå, lagres, med verdien før og etter.
 */
export async function suggestCompanyInfo(
  db: Db,
  viewer: Viewer,
  companyId: string,
  input: CompanyInput,
  note?: string | null,
): Promise<{ id: string }> {
  assertMember(viewer)
  const values = parse(companyInput, input)
  const comment = parse(noteInput, note ?? '')
  return db.transaction(async (tx) => {
    const current = await startSuggestion(tx, viewer, companyId)
    const fields: Record<string, { from: unknown; to: unknown }> = {}
    for (const key of Object.keys(values) as (keyof typeof values)[]) {
      const changed =
        key === 'industries'
          ? JSON.stringify(values.industries) !== JSON.stringify(current.industries)
          : values[key] !== current[key]
      if (changed) fields[key] = { from: current[key], to: values[key] }
    }
    if (!Object.keys(fields).length) throw new DomainError('Du har ikke endret noe.')
    const [row] = await tx
      .insert(companySuggestion)
      .values({
        companyId,
        suggestedByPersonId: viewer.personId,
        kind: 'info',
        changes: { kind: 'info', fields },
        note: comment,
      })
      .returning({ id: companySuggestion.id })
    await notifyConnected(tx, companyId, viewer.personId, row!.id, 'info')
    return { id: row!.id }
  })
}

async function lockSuggestion(tx: Tx, suggestionId: string) {
  const [row] = await tx
    .select()
    .from(companySuggestion)
    .where(eq(companySuggestion.id, suggestionId))
    .for('update')
  if (!row) throw new NotFoundError('Fant ikke forslaget.')
  return row
}

/** Den som foreslo, trekker forslaget før det er behandlet. */
export async function withdrawSuggestion(db: Db, viewer: Viewer, suggestionId: string) {
  assertMember(viewer)
  await db.transaction(async (tx) => {
    const row = await lockSuggestion(tx, suggestionId)
    if (row.suggestedByPersonId !== viewer.personId) throw new NotFoundError('Fant ikke forslaget.')
    if (row.status !== 'pending') throw new DomainError('Forslaget er allerede behandlet.')
    await tx
      .update(companySuggestion)
      .set({ status: 'withdrawn', decidedAt: new Date(), decidedByPersonId: viewer.personId })
      .where(eq(companySuggestion.id, suggestionId))
  })
}

/**
 * Godtar eller avslår et forslag. Krever at man kan redigere selskapet. Et godtatt
 * forslag lagres som om den som godtar, hadde gjort endringen selv: knyttet til
 * selskapet bekrefter, admin erstatter kildene og logges.
 */
export async function decideSuggestion(
  db: Db,
  viewer: Viewer,
  suggestionId: string,
  decision: 'accept' | 'reject',
): Promise<{ slug: string }> {
  assertMember(viewer)
  try {
    return await db.transaction(async (tx) => {
      const row = await lockSuggestion(tx, suggestionId)
      const target = await companyForEdit(tx, viewer, row.companyId, { lock: true })
      if (row.suggestedByPersonId === viewer.personId) {
        throw new DomainError('Du kan ikke behandle ditt eget forslag. Trekk det i stedet.')
      }
      if (row.status !== 'pending') throw new DomainError('Forslaget er allerede behandlet.')

      let slug = target.slug
      const proposedFields = row.changes.kind === 'info' ? Object.keys(row.changes.fields) : []
      let fields = proposedFields
      if (decision === 'accept') {
        if (row.changes.kind === 'info') {
          const current = await lockCompany(tx, row.companyId)
          const proposed = Object.fromEntries(
            Object.entries(row.changes.fields).map(([key, change]) => [key, change.to]),
          )
          // Hele selskapet valideres på nytt, med de foreslåtte feltene på plass.
          const values = parse(companyInput, {
            name: current.name,
            tagline: current.tagline ?? '',
            description: current.description ?? '',
            website: current.website ?? '',
            foundedYear: current.foundedYear,
            location: current.location ?? '',
            industries: current.industries,
            status: current.status,
            ...proposed,
          })
          const picked = Object.fromEntries(
            proposedFields
              .filter((key) => key in values)
              .map((key) => [key, values[key as keyof typeof values]]),
          )
          const written = await writeCompanyValues(tx, viewer, current, picked, {
            connected: !target.adminEdit,
          })
          slug = written.slug
          fields = written.changed
        } else if (row.changes.kind === 'event') {
          const event = parse(companyEventInput, row.changes.event)
          await tx.insert(companyEvent).values({
            companyId: row.companyId,
            ...eventValues(event, await resolveProgramme(tx, row.companyId, event)),
            confidence: 'high',
          })
        } else {
          // Står saken der allerede (lagt inn mens forslaget ventet), er forslaget gjennomført.
          await insertArticle(tx, row.companyId, parseArticle(row.changes.article), {
            source: 'member',
            byPersonId: row.suggestedByPersonId,
          })
        }
      }
      await tx
        .update(companySuggestion)
        .set({
          status: decision === 'accept' ? 'accepted' : 'rejected',
          decidedAt: new Date(),
          decidedByPersonId: viewer.personId,
        })
        .where(eq(companySuggestion.id, suggestionId))
      await deliver(tx, [
        {
          recipientPersonId: row.suggestedByPersonId,
          type: decision === 'accept' ? 'suggestion_accepted' : 'suggestion_rejected',
          actorPersonId: viewer.personId,
          companyId: row.companyId,
          eventKey: `suggestion:${suggestionId}:${decision}`,
          payload: { suggestionId, suggestionKind: row.kind },
        },
      ])
      if (target.adminEdit) {
        await tx.insert(auditEvent).values({
          actorPersonId: viewer.personId,
          action:
            decision === 'accept'
              ? 'company.admin_suggestion_accept'
              : 'company.admin_suggestion_reject',
          subjectPersonId: row.suggestedByPersonId,
          details: {
            companyId: row.companyId,
            slug,
            name: target.name,
            suggestionId,
            kind: row.kind,
            ...(row.kind === 'info' ? { fields } : {}),
          },
        })
      }
      return { slug }
    })
  } catch (error) {
    return rethrowSlugConflict(error)
  }
}

const suggester = alias(person, 'suggester')

/** Henter forslag som visning. `viewerId` avgjør `own`. */
async function suggestionViews(
  db: Db | Tx,
  viewerId: string,
  where: ReturnType<typeof and>,
  { limit, offset }: { limit?: number; offset?: number } = {},
): Promise<SuggestionView[]> {
  const query = db
    .select({
      id: companySuggestion.id,
      kind: companySuggestion.kind,
      changes: companySuggestion.changes,
      note: companySuggestion.note,
      createdAt: companySuggestion.createdAt,
      companyId: company.id,
      slug: company.slug,
      name: company.name,
      logoKey: company.logoKey,
      tagline: company.tagline,
      description: company.description,
      website: company.website,
      foundedYear: company.foundedYear,
      location: company.location,
      industries: company.industries,
      status: company.status,
      byId: suggester.id,
      byName: suggester.fullName,
      byPhoto: suggester.photoKey,
      byUser: suggester.userId,
    })
    .from(companySuggestion)
    .innerJoin(company, eq(company.id, companySuggestion.companyId))
    .innerJoin(suggester, eq(suggester.id, companySuggestion.suggestedByPersonId))
    .where(where)
    .orderBy(asc(companySuggestion.createdAt))
  const rows = await (limit !== undefined ? query.limit(limit).offset(offset ?? 0) : query)
  return rows.map((r) => {
    const current: Record<string, unknown> = {
      name: r.name,
      tagline: r.tagline,
      description: r.description,
      website: r.website,
      foundedYear: r.foundedYear,
      location: r.location,
      industries: r.industries,
      status: r.status,
    }
    return {
      id: r.id,
      kind: r.kind,
      company: { id: r.companyId, slug: r.slug, name: r.name, logo: logoUrls(r.logoKey) },
      suggestedBy: {
        personId: r.byId,
        fullName: r.byName,
        photo: photoUrls(r.byPhoto),
        claimed: r.byUser !== null,
      },
      note: r.note,
      createdAt: r.createdAt,
      fields:
        r.changes.kind === 'info'
          ? Object.entries(r.changes.fields).map(([field, change]) => ({
              field,
              from: change.from as SuggestedValue,
              to: change.to as SuggestedValue,
              current: (current[field] ?? null) as SuggestedValue,
            }))
          : [],
      event: r.changes.kind === 'event' ? r.changes.event : null,
      article: r.changes.kind === 'article' ? r.changes.article : null,
      own: r.byId === viewerId,
    }
  })
}

/**
 * Åpne forslag til selskapssiden: alle for dem som kan redigere selskapet, ellers
 * bare den innloggedes egne.
 */
export async function loadCompanySuggestions(
  db: Db,
  viewer: NonNullable<Viewer> & { personId: string },
  companyId: string,
  { canEdit }: { canEdit: boolean },
): Promise<SuggestionView[]> {
  return suggestionViews(
    db,
    viewer.personId,
    and(
      eq(companySuggestion.companyId, companyId),
      eq(companySuggestion.status, 'pending'),
      canEdit ? undefined : eq(companySuggestion.suggestedByPersonId, viewer.personId),
    ),
  )
}

/** Alle åpne forslag, eldste først, til Gjennomgang. Tilgangen sjekkes av review.ts. */
export async function pendingSuggestions(
  db: Db,
  viewerId: string,
  page: { limit: number; offset: number },
): Promise<{ items: SuggestionView[]; total: number }> {
  const where = and(eq(companySuggestion.status, 'pending'))
  const [items, [total]] = await Promise.all([
    suggestionViews(db, viewerId, where, page),
    db.select({ n: count() }).from(companySuggestion).where(where),
  ])
  return { items, total: total?.n ?? 0 }
}

// ---------------------------------------------------------------------------
// Andre personer
// ---------------------------------------------------------------------------

export type LinkRequestView = {
  id: string
  role: CompanyLinkRole
  title: string | null
  startYear: number | null
  endYear: number | null
  status: ContributionStatus
  createdAt: Date
  company: { id: string; slug: string; name: string; logo: CompanyLogoUrls | null }
  person: { personId: string; fullName: string; photo: ProfilePhoto | null; claimed: boolean }
  requestedBy: { personId: string; fullName: string; claimed: boolean }
}

/**
 * Sier at en annen person var med i selskapet. Har de konto, må de bekrefte før
 * det vises, og får varsel. Uten konto vises det med en gang (`added`).
 */
export async function requestCompanyLink(
  db: Db,
  viewer: Viewer,
  companyId: string,
  input: CompanyLinkInput & { personId: string },
): Promise<{ id: string; added: boolean }> {
  assertMember(viewer)
  const link = parse(companyLinkInput, input)
  const personId = parse(z.uuid(), input.personId)
  if (personId === viewer.personId) {
    throw new DomainError('Bruk «Jeg var med her» for å legge til deg selv.')
  }
  return db.transaction(async (tx) => {
    const target = await companyName(tx, companyId)
    const [named] = await tx
      .select({
        fullName: person.fullName,
        esCompanyId: person.esCompanyId,
        userId: person.userId,
      })
      .from(person)
      .innerJoin(
        membership,
        and(eq(membership.personId, person.id), eq(membership.status, 'active')),
      )
      .where(eq(person.id, personId))
    if (!named) throw new NotFoundError('Fant ikke personen.')
    if (link.role === 'es' && named.esCompanyId === companyId) {
      throw new DomainError(`${named.fullName} står allerede i ES-teamet.`)
    }
    if (link.role !== 'es') {
      const [already] = await tx
        .select({ id: experience.id })
        .from(experience)
        .where(
          and(
            eq(experience.personId, personId),
            eq(experience.companyId, companyId),
            eq(experience.founder, link.role === 'founder'),
          ),
        )
        .limit(1)
      if (already) {
        throw new DomainError(
          `${named.fullName} står allerede som ${roleNames[link.role]} i ${target.name}.`,
        )
      }
    }

    // Grensene, med personen låst så samtidige forespørsler ikke kan omgå dem.
    await tx
      .select({ id: person.id })
      .from(person)
      .where(eq(person.id, viewer.personId))
      .for('update')
    const [pending] = await tx
      .select({ n: count() })
      .from(companyLinkRequest)
      .where(
        and(
          eq(companyLinkRequest.requestedByPersonId, viewer.personId),
          eq(companyLinkRequest.status, 'pending'),
        ),
      )
    const [recent] = await tx
      .select({ n: count() })
      .from(companyLinkRequest)
      .where(
        and(
          eq(companyLinkRequest.requestedByPersonId, viewer.personId),
          gt(companyLinkRequest.createdAt, new Date(Date.now() - DAY_MS)),
        ),
      )
    if ((pending?.n ?? 0) >= LIMITS.pendingLinks) {
      throw new DomainError(
        `Du har ${LIMITS.pendingLinks} forespørsler som venter på svar. Vent til noen av dem er besvart.`,
      )
    }
    if ((recent?.n ?? 0) >= LIMITS.linksPerDay) {
      throw new DomainError('Du har lagt til mange personer det siste døgnet. Prøv igjen i morgen.')
    }

    // Uten konto er det ingen å spørre. Raden teller mot grensen per døgn.
    if (!named.userId) {
      await applyLink(tx, personId, target, link, { owner: false, you: false })
      const [added] = await tx
        .insert(companyLinkRequest)
        .values({
          companyId,
          personId,
          requestedByPersonId: viewer.personId,
          ...link,
          status: 'accepted',
          decidedAt: new Date(),
          decidedByPersonId: viewer.personId,
        })
        .returning({ id: companyLinkRequest.id })
      await tx.insert(auditEvent).values({
        actorPersonId: viewer.personId,
        action: 'company.member_link_add',
        subjectPersonId: personId,
        details: {
          companyId: target.id,
          slug: target.slug,
          name: target.name,
          role: link.role,
          requestId: added!.id,
        },
      })
      return { id: added!.id, added: true }
    }

    const [row] = await tx
      .insert(companyLinkRequest)
      .values({ companyId, personId, requestedByPersonId: viewer.personId, ...link })
      .onConflictDoNothing()
      .returning({ id: companyLinkRequest.id })
    if (!row) {
      throw new DomainError(
        `${named.fullName} har allerede en forespørsel om dette som venter på svar.`,
      )
    }
    await deliver(tx, [
      {
        recipientPersonId: personId,
        type: 'company_link_request',
        actorPersonId: viewer.personId,
        companyId,
        eventKey: `link:${row.id}`,
        payload: { linkRequestId: row.id, linkRole: link.role },
      },
    ])
    return { id: row.id, added: false }
  })
}

async function lockLinkRequest(tx: Tx, id: string) {
  const [row] = await tx
    .select({
      id: companyLinkRequest.id,
      companyId: companyLinkRequest.companyId,
      personId: companyLinkRequest.personId,
      requestedByPersonId: companyLinkRequest.requestedByPersonId,
      role: companyLinkRequest.role,
      title: companyLinkRequest.title,
      startYear: companyLinkRequest.startYear,
      endYear: companyLinkRequest.endYear,
      status: companyLinkRequest.status,
      claimed: sql<boolean>`${person.userId} is not null`,
      fullName: person.fullName,
    })
    .from(companyLinkRequest)
    .innerJoin(person, eq(person.id, companyLinkRequest.personId))
    .where(eq(companyLinkRequest.id, id))
    .for('update', { of: companyLinkRequest })
  if (!row) throw new NotFoundError('Fant ikke forespørselen.')
  return row
}

/**
 * Personen som er nevnt, bekrefter eller avslår. En admin kan gjøre det samme for
 * profiler ingen har tatt i bruk, og avslå alle (logges). Ved bekreftelse blir det
 * erfaring eller ES-selskap på profilen.
 */
export async function decideCompanyLink(
  db: Db,
  viewer: Viewer,
  requestId: string,
  decision: 'accept' | 'reject',
): Promise<void> {
  assertMember(viewer)
  await db.transaction(async (tx) => {
    const row = await lockLinkRequest(tx, requestId)
    const own = row.personId === viewer.personId
    // Andre enn personen selv må være admin (og sterkt innlogget).
    if (!own) assertCan(viewer, 'profiles.edit')
    if (!own && decision === 'accept' && row.claimed) {
      throw new DomainError(`${row.fullName} har konto og må bekrefte selv.`)
    }
    if (row.status !== 'pending') throw new DomainError('Forespørselen er allerede besvart.')
    const target = await companyName(tx, row.companyId)
    if (decision === 'accept') {
      await applyLink(
        tx,
        row.personId,
        target,
        { role: row.role, title: row.title, startYear: row.startYear, endYear: row.endYear },
        { owner: own, you: own },
      )
    }
    await tx
      .update(companyLinkRequest)
      .set({
        status: decision === 'accept' ? 'accepted' : 'rejected',
        decidedAt: new Date(),
        decidedByPersonId: viewer.personId,
      })
      .where(eq(companyLinkRequest.id, requestId))
    if (decision === 'accept') {
      await deliver(tx, [
        {
          recipientPersonId: row.requestedByPersonId,
          type: 'company_link_confirmed',
          actorPersonId: row.personId,
          companyId: row.companyId,
          eventKey: `link:${requestId}:confirmed`,
          payload: { linkRequestId: requestId, linkRole: row.role },
        },
      ])
    }
    if (!own) {
      await tx.insert(auditEvent).values({
        actorPersonId: viewer.personId,
        action: decision === 'accept' ? 'company.admin_link_accept' : 'company.admin_link_reject',
        subjectPersonId: row.personId,
        details: {
          companyId: target.id,
          slug: target.slug,
          name: target.name,
          role: row.role,
          requestId,
          requestedByPersonId: row.requestedByPersonId,
        },
      })
    }
  })
}

/** Den som spurte, trekker forespørselen før personen har svart. */
export async function withdrawCompanyLink(db: Db, viewer: Viewer, requestId: string) {
  assertMember(viewer)
  await db.transaction(async (tx) => {
    const row = await lockLinkRequest(tx, requestId)
    if (row.requestedByPersonId !== viewer.personId) {
      throw new NotFoundError('Fant ikke forespørselen.')
    }
    if (row.status !== 'pending') throw new DomainError('Forespørselen er allerede besvart.')
    await tx
      .update(companyLinkRequest)
      .set({ status: 'withdrawn', decidedAt: new Date(), decidedByPersonId: viewer.personId })
      .where(eq(companyLinkRequest.id, requestId))
  })
}

const named = alias(person, 'named')
const requester = alias(person, 'requester')

async function linkViews(
  db: Db | Tx,
  where: ReturnType<typeof and>,
  { limit, offset }: { limit?: number; offset?: number } = {},
): Promise<LinkRequestView[]> {
  const query = db
    .select({
      id: companyLinkRequest.id,
      role: companyLinkRequest.role,
      title: companyLinkRequest.title,
      startYear: companyLinkRequest.startYear,
      endYear: companyLinkRequest.endYear,
      status: companyLinkRequest.status,
      createdAt: companyLinkRequest.createdAt,
      companyId: company.id,
      slug: company.slug,
      name: company.name,
      logoKey: company.logoKey,
      personId: named.id,
      fullName: named.fullName,
      photoKey: named.photoKey,
      userId: named.userId,
      byId: requester.id,
      byName: requester.fullName,
      byUser: requester.userId,
    })
    .from(companyLinkRequest)
    .innerJoin(company, eq(company.id, companyLinkRequest.companyId))
    .innerJoin(named, eq(named.id, companyLinkRequest.personId))
    .innerJoin(requester, eq(requester.id, companyLinkRequest.requestedByPersonId))
    .where(where)
    .orderBy(asc(companyLinkRequest.createdAt))
  const rows = await (limit !== undefined ? query.limit(limit).offset(offset ?? 0) : query)
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    title: r.title,
    startYear: r.startYear,
    endYear: r.endYear,
    status: r.status,
    createdAt: r.createdAt,
    company: { id: r.companyId, slug: r.slug, name: r.name, logo: logoUrls(r.logoKey) },
    person: {
      personId: r.personId,
      fullName: r.fullName,
      photo: photoUrls(r.photoKey),
      claimed: r.userId !== null,
    },
    requestedBy: { personId: r.byId, fullName: r.byName, claimed: r.byUser !== null },
  }))
}

/** Åpne forespørsler om den innloggede, til profilen og selskapssiden. */
export async function listMyLinkRequests(
  db: Db,
  viewer: Viewer,
  options: { companyId?: string } = {},
): Promise<LinkRequestView[]> {
  assertMember(viewer)
  return linkViews(
    db,
    and(
      eq(companyLinkRequest.personId, viewer.personId),
      eq(companyLinkRequest.status, 'pending'),
      options.companyId ? eq(companyLinkRequest.companyId, options.companyId) : undefined,
    ),
  )
}

/** Åpne forespørsler den innloggede har sendt om andre i selskapet. */
export async function loadRequestedLinks(
  db: Db,
  viewer: NonNullable<Viewer> & { personId: string },
  companyId: string,
): Promise<LinkRequestView[]> {
  return linkViews(
    db,
    and(
      eq(companyLinkRequest.requestedByPersonId, viewer.personId),
      eq(companyLinkRequest.companyId, companyId),
      eq(companyLinkRequest.status, 'pending'),
    ),
  )
}

/**
 * Åpne forespørsler om profiler ingen har tatt i bruk, eldste først, til
 * Gjennomgang. Personer med konto svarer selv. Tilgangen sjekkes av review.ts.
 */
export async function pendingUnclaimedLinks(
  db: Db,
  page: { limit: number; offset: number },
): Promise<{ items: LinkRequestView[]; total: number }> {
  const where = and(eq(companyLinkRequest.status, 'pending'), isNull(named.userId))
  const [items, [total]] = await Promise.all([
    linkViews(db, where, page),
    db
      .select({ n: count() })
      .from(companyLinkRequest)
      .innerJoin(named, eq(named.id, companyLinkRequest.personId))
      .where(where),
  ])
  return { items, total: total?.n ?? 0 }
}

/** Hvordan den innloggede selv er knyttet til selskapet, til «Jeg var med her». */
export async function viewerCompanyRoles(
  db: Db,
  personId: string,
  companyId: string,
): Promise<{ founder: boolean; employee: boolean; es: boolean }> {
  const [rows, [es]] = await Promise.all([
    db
      .select({ founder: experience.founder })
      .from(experience)
      .where(and(eq(experience.personId, personId), eq(experience.companyId, companyId))),
    db
      .select({ id: person.id })
      .from(person)
      .where(and(eq(person.id, personId), eq(person.esCompanyId, companyId))),
  ])
  return {
    founder: rows.some((r) => r.founder),
    employee: rows.some((r) => !r.founder),
    es: Boolean(es),
  }
}
