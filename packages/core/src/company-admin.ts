import { schema, type CompanyStatus, type Db } from '@esaf/db'
import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm'
import { assertCan, type Viewer } from './access.ts'
import { deleteAssetsOf, purgeAssets } from './assets.ts'
import { companyInput, companySlug, lockCompany, pgCode, type CompanyInput } from './companies.ts'
import type { Tx } from './members.ts'
import type { z } from 'zod'
import { DomainError, NotFoundError } from './errors.ts'
import { deleteLogoFiles, logoUrls, type CompanyLogoUrls } from './logos.ts'
import { deleteFieldSources, recordFieldEdits } from './sources.ts'
import type { ObjectStorage } from './storage.ts'
import { optionalText } from './validation.ts'

const {
  auditEvent,
  cohort,
  company,
  companyEvent,
  companyLinkRequest,
  companySuggestion,
  experience,
  person,
  personCohort,
  quote,
} = schema

/**
 * Selskapene for admins (Admin → Selskaper): alle, også dem ingen er knyttet
 * til, med det som trengs for å finne hull og rydde. Krever `profiles.edit`,
 * som annen redigering av andres data. Oppretting og sletting logges.
 */

export type AdminCompany = {
  id: string
  slug: string
  name: string
  /** Navn selskapet hadde før, nyeste først. */
  formerNames: string[]
  logo: CompanyLogoUrls | null
  status: CompanyStatus
  tagline: string | null
  /** Har «om selskapet» eller kort beskrivelse. */
  hasDescription: boolean
  website: string | null
  /** Alle personer knyttet til selskapet, uansett medlemskap. */
  people: number
  founders: number
  /** Noen har selskapet som ES-selskap. */
  esCompany: boolean
  /** Kullene til gründerne og ES-teamet. */
  cohortYears: number[]
  events: number
  /** Åpne forslag fra medlemmer. */
  suggestions: number
  /** Sist noen redigerte selskapsinfoen. Null: bare opprettet fra et navn. */
  editedAt: Date | null
  createdAt: Date
}

/** Sluggen til et selskap, fra id-en (til adresser og oppslag). Bare admins. */
export async function companySlugById(db: Db, viewer: Viewer, companyId: string) {
  assertCan(viewer, 'profiles.edit')
  const [row] = await db
    .select({ slug: company.slug })
    .from(company)
    .where(eq(company.id, companyId))
  if (!row) throw new NotFoundError('Fant ikke selskapet.')
  return row.slug
}

export async function listAdminCompanies(db: Db, viewer: Viewer): Promise<AdminCompany[]> {
  assertCan(viewer, 'profiles.edit')
  const [rows, roles, team, events, suggestions] = await Promise.all([
    db
      .select({
        id: company.id,
        slug: company.slug,
        name: company.name,
        formerNames: company.formerNames,
        logoKey: company.logoKey,
        status: company.status,
        tagline: company.tagline,
        description: company.description,
        website: company.website,
        editedAt: company.editedAt,
        createdAt: company.createdAt,
      })
      .from(company),
    db
      .select({
        companyId: experience.companyId,
        personId: experience.personId,
        founder: experience.founder,
      })
      .from(experience),
    db
      .select({ companyId: person.esCompanyId, personId: person.id })
      .from(person)
      .where(isNotNull(person.esCompanyId)),
    db
      .select({ companyId: companyEvent.companyId, n: sql<number>`count(*)::int` })
      .from(companyEvent)
      .groupBy(companyEvent.companyId),
    db
      .select({ companyId: companySuggestion.companyId, n: sql<number>`count(*)::int` })
      .from(companySuggestion)
      .where(eq(companySuggestion.status, 'pending'))
      .groupBy(companySuggestion.companyId),
  ])
  const teamIds = new Set([
    ...roles.filter((r) => r.founder).map((r) => r.personId),
    ...team.map((r) => r.personId),
  ])
  const years = teamIds.size
    ? await db
        .select({ personId: personCohort.personId, year: cohort.graduationYear })
        .from(personCohort)
        .innerJoin(cohort, eq(cohort.id, personCohort.cohortId))
        .where(inArray(personCohort.personId, [...teamIds]))
    : []
  const yearsOf = new Map<string, number[]>()
  for (const y of years) yearsOf.set(y.personId, [...(yearsOf.get(y.personId) ?? []), y.year])

  type Tally = { people: Set<string>; founders: Set<string>; es: Set<string> }
  const tally = new Map<string, Tally>()
  const of = (id: string) => {
    const t = tally.get(id) ?? { people: new Set(), founders: new Set(), es: new Set() }
    tally.set(id, t)
    return t
  }
  for (const r of roles) {
    of(r.companyId).people.add(r.personId)
    if (r.founder) of(r.companyId).founders.add(r.personId)
  }
  for (const r of team) {
    of(r.companyId!).people.add(r.personId)
    of(r.companyId!).es.add(r.personId)
  }
  const eventCount = new Map(events.map((e) => [e.companyId, e.n]))
  const suggestionCount = new Map(suggestions.map((s) => [s.companyId, s.n]))

  return rows
    .map(({ logoKey, description, ...row }) => {
      const t = tally.get(row.id)
      const leaders = [...(t?.founders ?? []), ...(t?.es ?? [])]
      return {
        ...row,
        logo: logoUrls(logoKey),
        hasDescription: Boolean(description || row.tagline),
        people: t?.people.size ?? 0,
        founders: t?.founders.size ?? 0,
        esCompany: (t?.es.size ?? 0) > 0,
        cohortYears: [...new Set(leaders.flatMap((id) => yearsOf.get(id) ?? []))].sort(),
        events: eventCount.get(row.id) ?? 0,
        suggestions: suggestionCount.get(row.id) ?? 0,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'nb'))
}

/**
 * Oppretter et selskap for hånd. Navnet kan ikke tilhøre et annet selskap, heller
 * ikke som tidligere navn. Selskapet regnes som redigert, så det ikke ryddes bort
 * selv om ingen er knyttet til det ennå.
 */
export async function createCompany(
  db: Db,
  viewer: Viewer,
  input: CompanyInput,
): Promise<{ id: string; slug: string }> {
  assertCan(viewer, 'profiles.edit')
  const parsed = companyInput.safeParse(input)
  if (!parsed.success) throw new DomainError(parsed.error.issues[0]?.message ?? 'Ugyldige felt.')
  try {
    return await db.transaction((tx) =>
      insertCompany(tx, viewer.personId, parsed.data, { edited: true }),
    )
  } catch (error) {
    if (pgCode(error) === '23505') throw new DomainError('Selskapet finnes allerede.')
    throw error
  }
}

/**
 * Lager selskapet, og logger det. Navnet kan ikke tilhøre et annet selskap, heller
 * ikke som tidligere navn. Felles for admins og medlemmer som starter et selskap.
 * `edited` holder det tomme selskapet unna oppryddingen; et medlem som lager et
 * selskap og fjerner seg fra det igjen, skal ikke etterlate et tomt selskap.
 */
export async function insertCompany(
  tx: Tx,
  actorPersonId: string,
  values: z.output<typeof companyInput>,
  { edited, details = {} }: { edited: boolean; details?: Record<string, unknown> },
): Promise<{ id: string; slug: string }> {
  const slug = companySlug(values.name)
  const [taken] = await tx
    .select({ name: company.name })
    .from(company)
    .where(or(eq(company.slug, slug), sql`${slug} = any(${company.aliasSlugs})`))
  if (taken) throw new DomainError(`Selskapet finnes allerede: ${taken.name}.`)
  const [row] = await tx
    .insert(company)
    .values({ ...values, slug, editedAt: edited ? new Date() : null })
    .returning({ id: company.id, slug: company.slug })
  await tx.insert(auditEvent).values({
    actorPersonId,
    action: 'company.create',
    details: { companyId: row!.id, slug, name: values.name, ...details },
  })
  return row!
}

export type CompanyDeletion = {
  /** Erfaringer og ES-team som peker på selskapet og må fjernes først. */
  experience: number
  esTeam: number
}

const reasonInput = optionalText(500)

/**
 * Sletter et selskap. Er noen knyttet til det (erfaring eller ES-selskap), må
 * `unlink` være satt, og da fjernes koblingene fra profilene; ellers avvises det.
 * Historikk, kilder, forslag og forespørsler slettes, sitater mister selskapet,
 * og logoen og dokumentene slettes fra lagringen. Logges med det som ble fjernet.
 */
export async function deleteCompany(
  db: Db,
  storage: ObjectStorage,
  viewer: Viewer,
  input: { companyId: string; unlink: boolean; reason?: string | null },
): Promise<void> {
  assertCan(viewer, 'profiles.edit')
  const reason = reasonInput.safeParse(input.reason ?? '')
  if (!reason.success) throw new DomainError('Begrunnelsen kan ha maks 500 tegn.')
  const { logoKey, files } = await db.transaction(async (tx) => {
    const current = await lockCompany(tx, input.companyId)
    // Én spørring om gangen: transaksjonen har bare én tilkobling.
    const jobs = await tx
      .select({ personId: experience.personId })
      .from(experience)
      .where(eq(experience.companyId, current.id))
    const team = await tx
      .select({ personId: person.id })
      .from(person)
      .where(eq(person.esCompanyId, current.id))
    if ((jobs.length || team.length) && !input.unlink) {
      throw new DomainError(
        `${current.name} er knyttet til ${jobs.length + team.length} profiler. Bekreft at koblingene skal fjernes, eller slå selskapet sammen med et annet i stedet.`,
      )
    }
    if ((jobs.length || team.length) && !reason.data) {
      throw new DomainError('Skriv en kort begrunnelse når koblinger fjernes. Den lagres i loggen.')
    }
    const events = await tx.$count(companyEvent, eq(companyEvent.companyId, current.id))
    const quotes = await tx.$count(quote, eq(quote.companyId, current.id))
    const suggestions = await tx.$count(
      companySuggestion,
      and(eq(companySuggestion.companyId, current.id), eq(companySuggestion.status, 'pending')),
    )
    const links = await tx.$count(
      companyLinkRequest,
      and(eq(companyLinkRequest.companyId, current.id), eq(companyLinkRequest.status, 'pending')),
    )

    await tx.delete(experience).where(eq(experience.companyId, current.id))
    await tx.update(person).set({ esCompanyId: null }).where(eq(person.esCompanyId, current.id))
    // En admin har endret profilene; importerte kilder for feltene gjelder ikke lenger.
    for (const personId of new Set(jobs.map((j) => j.personId))) {
      await recordFieldEdits(tx, 'person', personId, ['experience'], 'forget')
    }
    for (const { personId } of team) {
      await recordFieldEdits(tx, 'person', personId, ['esCompany'], 'forget')
    }
    await deleteFieldSources(tx, 'company', [current.id])
    const files = await deleteAssetsOf(tx, { companyId: current.id })
    await tx.delete(company).where(eq(company.id, current.id))
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'company.delete',
      details: {
        companyId: current.id,
        slug: current.slug,
        name: current.name,
        reason: reason.data,
        experience: jobs.length,
        esTeam: team.length,
        events,
        quotes,
        suggestions,
        links,
        documents: files.length,
        people: [...new Set([...jobs, ...team].map((p) => p.personId))],
      },
    })
    return { logoKey: current.logoKey, files }
  })
  if (logoKey) await deleteLogoFiles(storage, logoKey)
  await purgeAssets(db, storage, files)
}
