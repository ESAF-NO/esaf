import {
  schema,
  type CompanyEventType,
  type CompanyStatus,
  type DatePrecision,
  type Db,
  type FieldSourceEntity,
  type MembershipStatus,
  type ReviewDismissalKind,
  type SourceConfidence,
} from '@esaf/db'
import { and, asc, count, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { assertCan, type Viewer } from './access.ts'
import { companySlug, deleteOrphanCompanies, lockCompany } from './companies.ts'
import {
  pendingSuggestions,
  pendingUnclaimedLinks,
  type LinkRequestView,
  type SuggestionView,
} from './contributions.ts'
import { DomainError, NotFoundError } from './errors.ts'
import { logoUrls, type CompanyLogoUrls } from './logos.ts'
import { normalizeLinkedinUrl } from './profiles.ts'
import { emailKey } from './members.ts'
import { normalizePersonName } from './people-admin.ts'
import { photoUrls, type ProfilePhoto } from './photos.ts'
import { companySourceFields, profileSourceFields } from './sources.ts'
import { hostLabel, safeHttpUrl } from './validation.ts'

const {
  auditEvent,
  cohort,
  company,
  companyEvent,
  experience,
  fieldSource,
  membership,
  person,
  personCohort,
  personEmail,
  quote,
  reviewDismissal,
} = schema

/**
 * Gjennomgang (Admin → Gjennomgang): alt som er usikkert, samlet ett sted, for
 * admins med `profiles.edit`. Køen er avledet av dataene, ikke lagret for seg:
 *
 * - **Hendelser** og **sitater** med lav sikkerhet fra import.
 * - **Kilder:** importerte felt ingen har bekreftet (`confirmed_at`) eller sett
 *   over (`reviewed_at`), samlet per person og selskap. «Ser riktig ut» tar dem
 *   ut av køen uten å late som eieren har bekreftet; «Fjern» tømmer feltet.
 * - **Mulige duplikater** av selskaper (samme navn uten selskapsform, nesten lik
 *   slug, samme nettside) og personer (samme navn og kull innenfor ett år,
 *   nesten likt etternavn, samme fornavn i samme selskap, samme e-post eller
 *   LinkedIn). Par en admin har avvist, foreslås ikke igjen.
 * - **Forslag** fra medlemmer, og **tilknytninger** til profiler ingen har tatt i
 *   bruk (personer med konto svarer selv).
 *
 * Handlingene logges som annen adminredigering.
 */

export const reviewKinds = [
  'events',
  'quotes',
  'sources',
  'companyDuplicates',
  'personDuplicates',
  'suggestions',
  'links',
] as const
export type ReviewKind = (typeof reviewKinds)[number]

export type ReviewCounts = Record<ReviewKind, number> & {
  total: number
  /**
   * Det som venter på svar fra en admin: forslag og tilknytninger fra medlemmer.
   * Vises i menyen; resten er opprydding etter importen og kan tas når det passer.
   */
  attention: number
}

export const REVIEW_PAGE_SIZE = 20

type CompanyBrief = { id: string; slug: string; name: string; logo: CompanyLogoUrls | null }

export type ReviewEvent = {
  id: string
  company: CompanyBrief
  date: string
  datePrecision: DatePrecision
  type: CompanyEventType
  text: string
  source: { label: string; url: string | null } | null
}

export type ReviewQuote = {
  id: string
  text: string
  speakerName: string
  speakerRole: string | null
  /** Personen taleren er koblet til, hvis noen. */
  person: { personId: string; fullName: string; active: boolean } | null
  company: { slug: string; name: string } | null
  date: string | null
  source: { label: string; url: string | null } | null
  confidence: SourceConfidence
}

export type ReviewSourceField = {
  field: string
  /** Verdien slik den står nå, kort, til å se om den stemmer. */
  value: string | null
  sources: {
    label: string
    url: string | null
    fetchedAt: Date | null
    confidence: SourceConfidence
  }[]
  /** Kan tømmes med ett klikk. Bilde, logo, navn og erfaring rettes på redigeringssiden. */
  clearable: boolean
}

export type ReviewSourceGroup = {
  entityType: FieldSourceEntity
  entityId: string
  name: string
  /** Selskapets slug, eller personens id, til lenker. */
  slug: string | null
  /** For personer: om de har tatt i bruk profilen og om de er aktive. */
  claimed: boolean
  status: MembershipStatus | null
  fields: ReviewSourceField[]
}

export type DuplicateCompany = CompanyBrief & {
  status: CompanyStatus
  website: string | null
  /** Personer knyttet til selskapet, uansett medlemskap. */
  people: number
}

export type CompanyDuplicateReason = 'name' | 'similar' | 'website'

export type ReviewCompanyPair = {
  first: DuplicateCompany
  second: DuplicateCompany
  reasons: CompanyDuplicateReason[]
}

export type DuplicatePerson = {
  personId: string
  fullName: string
  photo: ProfilePhoto | null
  claimed: boolean
  status: MembershipStatus | null
  cohortYears: number[]
  experience: number
}

export type PersonDuplicateReason =
  'name' | 'firstLast' | 'similarName' | 'company' | 'email' | 'linkedin'

export type ReviewPersonPair = {
  first: DuplicatePerson
  second: DuplicatePerson
  reasons: PersonDuplicateReason[]
  /** Begge har konto; da kan de ikke slås sammen. */
  bothClaimed: boolean
}

export type ReviewPage =
  | { kind: 'events'; items: ReviewEvent[]; total: number }
  | { kind: 'quotes'; items: ReviewQuote[]; total: number }
  | { kind: 'sources'; items: ReviewSourceGroup[]; total: number }
  | { kind: 'companyDuplicates'; items: ReviewCompanyPair[]; total: number }
  | { kind: 'personDuplicates'; items: ReviewPersonPair[]; total: number }
  | { kind: 'suggestions'; items: SuggestionView[]; total: number }
  | { kind: 'links'; items: LinkRequestView[]; total: number }

const lowEvent = eq(companyEvent.confidence, 'low')
const lowQuote = eq(quote.confidence, 'low')
/**
 * Felt som verken eieren har bekreftet eller en admin har sett over. Bare felt
 * appen viser kilder for; kontaktinfo er aldri med (se sources.ts).
 */
const openSource = and(
  isNull(fieldSource.confirmedAt),
  isNull(fieldSource.reviewedAt),
  or(
    and(eq(fieldSource.entityType, 'person'), inArray(fieldSource.field, [...profileSourceFields])),
    and(
      eq(fieldSource.entityType, 'company'),
      inArray(fieldSource.field, [...companySourceFields]),
    ),
  ),
)

const sourceLabel = (url: string | null, label: string | null) => {
  const safe = safeHttpUrl(url)
  const shown = label ?? hostLabel(safe)
  return shown ? { label: shown, url: safe } : null
}

// ---------------------------------------------------------------------------
// Kilder
// ---------------------------------------------------------------------------

/** Felt som kan tømmes med ett klikk fra køen. */
const clearableProfileFields = [
  'bio',
  'city',
  'studyBackground',
  'linkedinUrl',
  'expertise',
  'industries',
  'esCompany',
] as const
const clearableCompanyFields = [
  'tagline',
  'description',
  'website',
  'foundedYear',
  'location',
  'industries',
  'status',
  'lastSeenOnEsSite',
] as const

const isClearable = (entityType: FieldSourceEntity, field: string) =>
  entityType === 'person'
    ? (clearableProfileFields as readonly string[]).includes(field)
    : (clearableCompanyFields as readonly string[]).includes(field)

/** Personer og selskaper med åpne kilder. Slettede personer og selskaper tas ikke med. */
async function openSourceGroups(db: Db) {
  const rows = await db
    .select({ entityType: fieldSource.entityType, entityId: fieldSource.entityId })
    .from(fieldSource)
    .where(openSource)
    .groupBy(fieldSource.entityType, fieldSource.entityId)
  const personIds = rows.filter((r) => r.entityType === 'person').map((r) => r.entityId)
  const companyIds = rows.filter((r) => r.entityType === 'company').map((r) => r.entityId)
  const [people, companies] = await Promise.all([
    personIds.length
      ? db
          .select({
            id: person.id,
            name: person.fullName,
            userId: person.userId,
            status: membership.status,
          })
          .from(person)
          .leftJoin(membership, eq(membership.personId, person.id))
          .where(inArray(person.id, personIds))
      : [],
    companyIds.length
      ? db
          .select({ id: company.id, name: company.name, slug: company.slug })
          .from(company)
          .where(inArray(company.id, companyIds))
      : [],
  ])
  // Selskapene først (færre, og synlige for alle), så personene, alfabetisk.
  return [
    ...companies
      .sort((a, b) => a.name.localeCompare(b.name, 'nb'))
      .map((c) => ({
        entityType: 'company' as const,
        entityId: c.id,
        name: c.name,
        slug: c.slug,
        claimed: false,
        status: null,
      })),
    ...people
      .sort((a, b) => a.name.localeCompare(b.name, 'nb'))
      .map((p) => ({
        entityType: 'person' as const,
        entityId: p.id,
        name: p.name,
        slug: null,
        claimed: p.userId !== null,
        status: p.status,
      })),
  ]
}

const short = (v: string | null, max = 280) =>
  v && v.length > max ? `${v.slice(0, max - 1).trimEnd()}…` : v

/** Verdiene feltene har nå, som kort tekst. */
async function currentValues(
  db: Db,
  entityType: FieldSourceEntity,
  ids: string[],
): Promise<Map<string, Record<string, string | null>>> {
  const result = new Map<string, Record<string, string | null>>()
  if (!ids.length) return result
  const tags = (list: string[]) => (list.length ? list.join(', ') : null)
  if (entityType === 'company') {
    const rows = await db.select().from(company).where(inArray(company.id, ids))
    for (const c of rows) {
      result.set(c.id, {
        name: c.name,
        logo: c.logoKey ? 'Logo' : null,
        tagline: c.tagline,
        description: short(c.description),
        status: c.status,
        lastSeenOnEsSite: c.lastSeenOnEsSite,
        foundedYear: c.foundedYear === null ? null : String(c.foundedYear),
        location: c.location,
        website: c.website,
        industries: tags(c.industries),
      })
    }
    return result
  }
  const [rows, jobs] = await Promise.all([
    db
      .select({
        id: person.id,
        photoKey: person.photoKey,
        bio: person.bio,
        city: person.city,
        studyBackground: person.studyBackground,
        linkedinUrl: person.linkedinUrl,
        expertise: person.expertise,
        industries: person.industries,
        esCompany: company.name,
      })
      .from(person)
      .leftJoin(company, eq(company.id, person.esCompanyId))
      .where(inArray(person.id, ids)),
    db
      .select({
        personId: experience.personId,
        company: company.name,
        title: experience.title,
        founder: experience.founder,
      })
      .from(experience)
      .innerJoin(company, eq(company.id, experience.companyId))
      .where(inArray(experience.personId, ids))
      .orderBy(asc(experience.position)),
  ])
  for (const p of rows) {
    const roles = jobs
      .filter((j) => j.personId === p.id)
      .map((j) => [j.title ?? (j.founder ? 'Gründer' : null), j.company].filter(Boolean).join(', '))
    result.set(p.id, {
      photo: p.photoKey ? 'Bilde' : null,
      bio: short(p.bio),
      city: p.city,
      studyBackground: p.studyBackground,
      linkedinUrl: p.linkedinUrl,
      expertise: tags(p.expertise),
      industries: tags(p.industries),
      esCompany: p.esCompany,
      experience: roles.length ? roles.join(' · ') : null,
    })
  }
  return result
}

async function sourceGroups(db: Db, page: { limit: number; offset: number }) {
  const groups = await openSourceGroups(db)
  const shown = groups.slice(page.offset, page.offset + page.limit)
  if (!shown.length) return { items: [], total: groups.length }
  const rows = await db
    .select()
    .from(fieldSource)
    .where(
      and(
        openSource,
        inArray(
          fieldSource.entityId,
          shown.map((g) => g.entityId),
        ),
      ),
    )
    .orderBy(asc(fieldSource.createdAt))
  const [people, companies] = await Promise.all([
    currentValues(
      db,
      'person',
      shown.filter((g) => g.entityType === 'person').map((g) => g.entityId),
    ),
    currentValues(
      db,
      'company',
      shown.filter((g) => g.entityType === 'company').map((g) => g.entityId),
    ),
  ])
  const items: ReviewSourceGroup[] = shown.map((g) => {
    const order: readonly string[] =
      g.entityType === 'person' ? profileSourceFields : companySourceFields
    const own = rows.filter((r) => r.entityType === g.entityType && r.entityId === g.entityId)
    // Kontaktinfo har aldri kilder i appen (se sources.ts).
    const fields = [...new Set(own.map((r) => r.field))]
      .filter((f) => order.includes(f))
      .sort((a, b) => order.indexOf(a) - order.indexOf(b))
    const values = (g.entityType === 'person' ? people : companies).get(g.entityId) ?? {}
    return {
      ...g,
      fields: fields.map((field) => ({
        field,
        value: values[field] ?? null,
        sources: own
          .filter((r) => r.field === field)
          .map((r) => ({
            label: r.sourceLabel,
            url: safeHttpUrl(r.sourceUrl),
            fetchedAt: r.fetchedAt,
            confidence: r.confidence,
          })),
        clearable: isClearable(g.entityType, field),
      })),
    }
  })
  return { items, total: groups.length }
}

const entityFields = (entityType: FieldSourceEntity) =>
  (entityType === 'person' ? profileSourceFields : companySourceFields) as readonly string[]

/**
 * «Ser riktig ut»: feltene tas ut av køen. Det er ikke en bekreftelse fra eieren,
 * så profilen viser fortsatt «ikke bekreftet» til eieren selv bekrefter. Uten
 * `fields` gjelder det alle åpne felt for personen eller selskapet.
 */
export async function markSourcesReviewed(
  db: Db,
  viewer: Viewer,
  input: { entityType: FieldSourceEntity; entityId: string; fields?: string[] },
): Promise<number> {
  assertCan(viewer, 'profiles.edit')
  if (input.fields && !input.fields.every((f) => entityFields(input.entityType).includes(f))) {
    throw new DomainError('Ukjent felt.')
  }
  return db.transaction(async (tx) => {
    const reviewed = await tx
      .update(fieldSource)
      .set({ reviewedAt: new Date() })
      .where(
        and(
          eq(fieldSource.entityType, input.entityType),
          eq(fieldSource.entityId, input.entityId),
          input.fields ? inArray(fieldSource.field, input.fields) : undefined,
          openSource,
        ),
      )
      .returning({ field: fieldSource.field })
    const fields = [...new Set(reviewed.map((r) => r.field))]
    if (!fields.length) throw new DomainError('Feltene er allerede sett over.')
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'source.review',
      subjectPersonId: input.entityType === 'person' ? input.entityId : null,
      details: { entityType: input.entityType, entityId: input.entityId, fields },
    })
    return fields.length
  })
}

/**
 * «Fjern»: tømmer et importert felt som ikke stemmer, og kildene for det. For
 * personer og selskaper med samme regler som når en admin retter feltet.
 */
export async function clearImportedField(
  db: Db,
  viewer: Viewer,
  input: { entityType: FieldSourceEntity; entityId: string; field: string },
): Promise<void> {
  assertCan(viewer, 'profiles.edit')
  if (!isClearable(input.entityType, input.field)) {
    throw new DomainError('Feltet kan ikke tømmes herfra. Rett det på redigeringssiden.')
  }
  await db.transaction(async (tx) => {
    const sources = and(
      eq(fieldSource.entityType, input.entityType),
      eq(fieldSource.entityId, input.entityId),
      eq(fieldSource.field, input.field),
    )
    if (input.entityType === 'company') {
      const current = await lockCompany(tx, input.entityId)
      const cleared: Record<string, unknown> = {
        tagline: { tagline: null },
        description: { description: null },
        website: { website: null },
        foundedYear: { foundedYear: null },
        location: { location: null },
        industries: { industries: [] },
        status: { status: 'unknown' },
        lastSeenOnEsSite: { lastSeenOnEsSite: null },
      }[input.field]!
      await tx
        .update(company)
        .set({ ...(cleared as object), editedAt: new Date() })
        .where(eq(company.id, current.id))
      await tx.delete(fieldSource).where(sources)
      await tx.insert(auditEvent).values({
        actorPersonId: viewer.personId,
        action: 'company.admin_clear_field',
        details: {
          companyId: current.id,
          slug: current.slug,
          name: current.name,
          field: input.field,
        },
      })
      return
    }
    const [current] = await tx
      .select({ id: person.id, esCompanyId: person.esCompanyId })
      .from(person)
      .where(eq(person.id, input.entityId))
      .for('update')
    if (!current) throw new NotFoundError('Fant ikke personen.')
    const cleared = {
      bio: { bio: null },
      city: { city: null },
      studyBackground: { studyBackground: null },
      linkedinUrl: { linkedinUrl: null },
      expertise: { expertise: [] },
      industries: { industries: [] },
      esCompany: { esCompanyId: null },
    }[input.field as (typeof clearableProfileFields)[number]]
    await tx.update(person).set(cleared).where(eq(person.id, current.id))
    await tx.delete(fieldSource).where(sources)
    if (input.field === 'esCompany') await deleteOrphanCompanies(tx, [current.esCompanyId])
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'profile.admin_clear_field',
      subjectPersonId: current.id,
      details: { field: input.field },
    })
  })
}

/**
 * Fjerner én kilde som ikke stemmer, og lar verdien i feltet stå. Brukes når én
 * oppføring i en liste er rettet, men kilden til den står igjen på feltet.
 * Uten `url` må navnet være entydig; `null` betyr kilden uten lenke.
 *
 * Resten av kildene på feltet regnes som sett over. Står de åpne, eier importen
 * fortsatt feltet, og neste import legger kilden inn igjen. Logges som `source.remove`.
 */
export async function removeFieldSource(
  db: Db,
  viewer: Viewer,
  input: {
    entityType: FieldSourceEntity
    entityId: string
    field: string
    label: string
    url?: string | null
  },
): Promise<void> {
  assertCan(viewer, 'profiles.edit')
  if (!entityFields(input.entityType).includes(input.field)) {
    throw new DomainError('Ukjent felt.')
  }
  await db.transaction(async (tx) => {
    const onField = and(
      eq(fieldSource.entityType, input.entityType),
      eq(fieldSource.entityId, input.entityId),
      eq(fieldSource.field, input.field),
    )
    const named = await tx
      .select({ id: fieldSource.id, url: fieldSource.sourceUrl })
      .from(fieldSource)
      .where(and(onField, eq(fieldSource.sourceLabel, input.label)))
      .for('update')
    const matches =
      input.url === undefined
        ? named
        : named.filter((s) => s.url === input.url || safeHttpUrl(s.url) === input.url)
    if (!matches.length) throw new NotFoundError('Fant ikke kilden.')
    if (matches.length > 1) {
      throw new DomainError('Flere kilder har dette navnet. Oppgi lenken til den som skal bort.')
    }
    const [source] = matches
    await tx.delete(fieldSource).where(eq(fieldSource.id, source!.id))
    await tx
      .update(fieldSource)
      .set({ reviewedAt: new Date() })
      .where(and(onField, isNull(fieldSource.reviewedAt)))
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'source.remove',
      subjectPersonId: input.entityType === 'person' ? input.entityId : null,
      details: {
        entityType: input.entityType,
        ...(input.entityType === 'company' ? { companyId: input.entityId } : {}),
        field: input.field,
        label: input.label,
        url: source!.url,
      },
    })
  })
}

// ---------------------------------------------------------------------------
// Duplikater
// ---------------------------------------------------------------------------

/** Selskapsformer og ord som ikke skiller selskaper fra hverandre. */
const companySuffixes = new Set([
  'as',
  'asa',
  'sa',
  'ab',
  'aps',
  'oy',
  'da',
  'ans',
  'nuf',
  'ltd',
  'limited',
  'inc',
  'llc',
  'gmbh',
  'bv',
  'holding',
  'holdings',
  'group',
  'norge',
  'norway',
])

/** Slugen uten selskapsform: «statkraft-as» og «statkraft» blir «statkraft». */
export function companyCoreKey(name: string) {
  const parts = companySlug(name).split('-')
  while (parts.length > 1 && companySuffixes.has(parts.at(-1)!)) parts.pop()
  return parts.join('-')
}

/** Nettsteder mange selskaper deler, som ikke sier noe om at de er like. */
const sharedHosts = new Set([
  'linkedin.com',
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'github.com',
  'youtube.com',
  'medium.com',
  'entreprenorskolen.no',
  'ntnu.no',
])

function websiteKey(website: string | null) {
  if (!website) return null
  try {
    const host = new URL(website).hostname.toLowerCase().replace(/^www\./, '')
    return sharedHosts.has(host) ? null : host
  } catch {
    return null
  }
}

/** Antall endringer mellom to korte strenger, avbrutt når det blir mer enn `max`. */
function editDistance(a: string, b: string, max: number) {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      best = Math.min(best, row[j]!)
    }
    if (best > max) return max + 1
    prev = row
  }
  return prev[b.length]!
}

const pairKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`)

async function dismissedPairs(db: Db, kind: ReviewDismissalKind) {
  const rows = await db
    .select({ a: reviewDismissal.firstId, b: reviewDismissal.secondId })
    .from(reviewDismissal)
    .where(eq(reviewDismissal.kind, kind))
  return new Set(rows.map((r) => pairKey(r.a, r.b)))
}

/** Grupperer på en nøkkel og gir alle par innenfor hver gruppe. */
function pairsBy<T extends { id: string }>(
  items: T[],
  key: (item: T) => string | null,
  add: (a: T, b: T) => void,
  largest = 8,
) {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    if (!k) continue
    groups.set(k, [...(groups.get(k) ?? []), item])
  }
  for (const group of groups.values()) {
    // En nøkkel mange deler (f.eks. et vanlig navn), er ikke et tegn på duplikat.
    if (group.length > largest) continue
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) add(group[i]!, group[j]!)
    }
  }
}

async function companyPairs(db: Db): Promise<ReviewCompanyPair[]> {
  const [rows, links, dismissed] = await Promise.all([
    db
      .select({
        id: company.id,
        slug: company.slug,
        name: company.name,
        logoKey: company.logoKey,
        status: company.status,
        website: company.website,
      })
      .from(company),
    db.execute<{ company_id: string; people: number }>(sql`
      select company_id, count(distinct person_id)::int as people from (
        select company_id, person_id from ${experience}
        union all
        select es_company_id as company_id, id as person_id from ${person} where es_company_id is not null
      ) linked group by company_id`),
    dismissedPairs(db, 'company_duplicate'),
  ])
  const people = new Map(links.rows.map((r) => [r.company_id, Number(r.people)]))
  const companies = rows.map(({ logoKey, ...r }) => ({
    ...r,
    logo: logoUrls(logoKey),
    people: people.get(r.id) ?? 0,
    core: companyCoreKey(r.name),
  }))
  const found = new Map<string, ReviewCompanyPair>()
  const add =
    (reason: CompanyDuplicateReason) =>
    (a: (typeof companies)[number], b: (typeof companies)[number]) => {
      const key = pairKey(a.id, b.id)
      if (dismissed.has(key)) return
      const [first, second] = a.id < b.id ? [a, b] : [b, a]
      const pair = found.get(key) ?? {
        first: strip(first),
        second: strip(second),
        reasons: [],
      }
      if (!pair.reasons.includes(reason)) pair.reasons.push(reason)
      found.set(key, pair)
    }
  const strip = ({ core: _core, ...c }: (typeof companies)[number]): DuplicateCompany => c

  pairsBy(companies, (c) => c.core, add('name'))
  pairsBy(companies, (c) => websiteKey(c.website), add('website'))
  // Nesten like navn (én bokstav forskjell), bare for navn som er lange nok til at det betyr noe.
  const byStart = new Map<string, typeof companies>()
  for (const c of companies) {
    if (c.core.length < 6) continue
    const k = c.core.slice(0, 2)
    byStart.set(k, [...(byStart.get(k) ?? []), c])
  }
  for (const group of byStart.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!
        const b = group[j]!
        if (a.core !== b.core && editDistance(a.core, b.core, 1) <= 1) add('similar')(a, b)
      }
    }
  }
  return [...found.values()].sort(
    (a, b) => b.reasons.length - a.reasons.length || a.first.name.localeCompare(b.first.name, 'nb'),
  )
}

function linkedinKey(url: string | null) {
  if (!url) return null
  const normalized = normalizeLinkedinUrl(url)
  if (!normalized) return null
  return decodeURIComponent(new URL(normalized).pathname).toLowerCase().replace(/\/$/, '')
}

async function personPairs(db: Db): Promise<ReviewPersonPair[]> {
  const [rows, years, emails, jobs, workplaces, dismissed] = await Promise.all([
    db
      .select({
        id: person.id,
        fullName: person.fullName,
        photoKey: person.photoKey,
        userId: person.userId,
        linkedinUrl: person.linkedinUrl,
        contactEmail: person.contactEmail,
        esCompanyId: person.esCompanyId,
        status: membership.status,
      })
      .from(person)
      .leftJoin(membership, eq(membership.personId, person.id)),
    db
      .select({ personId: personCohort.personId, year: cohort.graduationYear })
      .from(personCohort)
      .innerJoin(cohort, eq(cohort.id, personCohort.cohortId)),
    db.select({ personId: personEmail.personId, email: personEmail.email }).from(personEmail),
    db
      .select({ personId: experience.personId, n: count() })
      .from(experience)
      .groupBy(experience.personId),
    db
      .selectDistinct({ personId: experience.personId, companyId: experience.companyId })
      .from(experience),
    dismissedPairs(db, 'person_duplicate'),
  ])
  const yearsOf = new Map<string, number[]>()
  for (const y of years) yearsOf.set(y.personId, [...(yearsOf.get(y.personId) ?? []), y.year])
  const emailsOf = new Map<string, Set<string>>()
  for (const e of emails) {
    emailsOf.set(e.personId, (emailsOf.get(e.personId) ?? new Set()).add(emailKey(e.email)))
  }
  const jobsOf = new Map(jobs.map((j) => [j.personId, j.n]))
  const companiesOf = new Map<string, Set<string>>()
  for (const w of workplaces) {
    companiesOf.set(w.personId, (companiesOf.get(w.personId) ?? new Set()).add(w.companyId))
  }
  const people = rows.map((r) => {
    const name = normalizePersonName(r.fullName)
    const parts = name.split(' ')
    const own = emailsOf.get(r.id) ?? new Set<string>()
    if (r.contactEmail) own.add(emailKey(r.contactEmail))
    const companies = companiesOf.get(r.id) ?? new Set<string>()
    if (r.esCompanyId) companies.add(r.esCompanyId)
    return {
      ...r,
      name,
      first: parts[0]!,
      last: parts.length > 1 ? parts.at(-1)! : null,
      companies,
      firstLast: parts.length > 2 ? `${parts[0]} ${parts.at(-1)}` : name,
      emails: own,
      linkedin: linkedinKey(r.linkedinUrl),
      years: (yearsOf.get(r.id) ?? []).sort(),
    }
  })
  type P = (typeof people)[number]
  const brief = (p: P): DuplicatePerson => ({
    personId: p.id,
    fullName: p.fullName,
    photo: photoUrls(p.photoKey),
    claimed: p.userId !== null,
    status: p.status,
    cohortYears: p.years,
    experience: jobsOf.get(p.id) ?? 0,
  })
  // Samme navn er bare et tegn når kullene er like nære, eller en av dem mangler kull.
  const closeCohorts = (a: P, b: P) =>
    !a.years.length ||
    !b.years.length ||
    a.years.some((x) => b.years.some((y) => Math.abs(x - y) <= 1))

  const found = new Map<string, ReviewPersonPair>()
  const add = (reason: PersonDuplicateReason) => (a: P, b: P) => {
    const key = pairKey(a.id, b.id)
    if (dismissed.has(key)) return
    if (reason !== 'email' && reason !== 'linkedin' && !closeCohorts(a, b)) return
    // To navn med fornavn og etternavn felles må begge ha kull som passer.
    if (reason === 'firstLast' && (!a.years.length || !b.years.length)) return
    const [first, second] = a.id < b.id ? [a, b] : [b, a]
    const pair = found.get(key) ?? {
      first: brief(first),
      second: brief(second),
      reasons: [],
      bothClaimed: a.userId !== null && b.userId !== null,
    }
    if (!pair.reasons.includes(reason)) pair.reasons.push(reason)
    found.set(key, pair)
  }
  pairsBy(people, (p) => (p.name.length >= 3 ? p.name : null), add('name'))
  // «Ola Johan Nordmann» og «Ola Nordmann»: samme fornavn og etternavn, ulikt fullt navn.
  pairsBy(
    people,
    (p) => p.firstLast,
    (a, b) => a.name !== b.name && add('firstLast')(a, b),
  )
  pairsBy(
    people.flatMap((p) => [...p.emails].map((email) => ({ ...p, email }))),
    (p) => p.email,
    (a, b) => a.id !== b.id && add('email')(a, b),
  )
  // «Jonas Holm» og «Jonas Berg Holme»: samme fornavn og et etternavn
  // med én skrivefeil.
  pairsBy(
    people,
    (p) => (p.first.length >= 2 && p.last ? p.first : null),
    (a, b) =>
      a.last !== b.last &&
      a.last!.length >= 4 &&
      b.last!.length >= 4 &&
      editDistance(a.last!, b.last!, 1) <= 1 &&
      add('similarName')(a, b),
    Infinity,
  )
  // Samme fornavn i samme selskap, for eksempel en konto laget uten å koble den til
  // profilen fra kullisten.
  pairsBy(
    people.flatMap((p) => [...p.companies].map((companyId) => ({ ...p, companyId }))),
    (p) => (p.first.length >= 2 ? `${p.first}:${p.companyId}` : null),
    (a, b) => a.id !== b.id && add('company')(a, b),
  )
  pairsBy(people, (p) => p.linkedin, add('linkedin'))
  const weight: Record<PersonDuplicateReason, number> = {
    email: 3,
    linkedin: 3,
    name: 2,
    company: 2,
    firstLast: 1,
    similarName: 1,
  }
  const score = (p: ReviewPersonPair) => p.reasons.reduce((sum, r) => sum + weight[r], 0)
  return [...found.values()].sort(
    (a, b) => score(b) - score(a) || a.first.fullName.localeCompare(b.first.fullName, 'nb'),
  )
}

/**
 * Avviser et mulig duplikat: de to er ikke det samme, og paret foreslås ikke igjen.
 */
export async function dismissDuplicate(
  db: Db,
  viewer: Viewer,
  input: { kind: ReviewDismissalKind; firstId: string; secondId: string },
): Promise<void> {
  assertCan(viewer, 'profiles.edit')
  if (input.firstId === input.secondId) throw new DomainError('Velg to forskjellige.')
  const [firstId, secondId] =
    input.firstId < input.secondId
      ? [input.firstId, input.secondId]
      : [input.secondId, input.firstId]
  const table = input.kind === 'company_duplicate' ? company : person
  const names = await db
    .select({
      id: table.id,
      name: input.kind === 'company_duplicate' ? company.name : person.fullName,
    })
    .from(table)
    .where(inArray(table.id, [firstId, secondId]))
  if (names.length !== 2) throw new NotFoundError()
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(reviewDismissal)
      .values({ kind: input.kind, firstId, secondId, dismissedByPersonId: viewer.personId })
      .onConflictDoNothing()
      .returning({ kind: reviewDismissal.kind })
    if (!inserted.length) return
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'review.dismiss_duplicate',
      details: {
        kind: input.kind,
        first: { id: firstId, name: names.find((n) => n.id === firstId)!.name },
        second: { id: secondId, name: names.find((n) => n.id === secondId)!.name },
      },
    })
  })
}

// ---------------------------------------------------------------------------
// Køen
// ---------------------------------------------------------------------------

async function countSourceGroups(db: Db) {
  return (await openSourceGroups(db)).length
}

/** Antall i hver del av køen, til fanen og menyen. */
export async function reviewCounts(db: Db, viewer: Viewer): Promise<ReviewCounts> {
  assertCan(viewer, 'profiles.edit')
  const [events, quotes, sources, companies, people, suggestions, links] = await Promise.all([
    db.$count(companyEvent, lowEvent),
    db.$count(quote, lowQuote),
    countSourceGroups(db),
    companyPairs(db),
    personPairs(db),
    pendingSuggestions(db, viewer.personId, { limit: 0, offset: 0 }),
    pendingUnclaimedLinks(db, { limit: 0, offset: 0 }),
  ])
  const counts = {
    events,
    quotes,
    sources,
    companyDuplicates: companies.length,
    personDuplicates: people.length,
    suggestions: suggestions.total,
    links: links.total,
  }
  return {
    ...counts,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    attention: counts.suggestions + counts.links,
  }
}

/** Én side av en del av køen. `page` starter på 1. */
export async function listReview(
  db: Db,
  viewer: Viewer,
  kind: ReviewKind,
  page = 1,
): Promise<ReviewPage> {
  assertCan(viewer, 'profiles.edit')
  const limit = REVIEW_PAGE_SIZE
  const offset = (Math.max(1, Math.floor(page)) - 1) * limit
  switch (kind) {
    case 'events': {
      const [rows, total] = await Promise.all([
        db
          .select({
            id: companyEvent.id,
            date: companyEvent.date,
            datePrecision: companyEvent.datePrecision,
            type: companyEvent.type,
            text: companyEvent.text,
            sourceUrl: companyEvent.sourceUrl,
            sourceLabel: companyEvent.sourceLabel,
            companyId: company.id,
            slug: company.slug,
            name: company.name,
            logoKey: company.logoKey,
          })
          .from(companyEvent)
          .innerJoin(company, eq(company.id, companyEvent.companyId))
          .where(lowEvent)
          .orderBy(asc(company.name), asc(companyEvent.date), asc(companyEvent.id))
          .limit(limit)
          .offset(offset),
        db.$count(companyEvent, lowEvent),
      ])
      return {
        kind,
        total,
        items: rows.map((r) => ({
          id: r.id,
          company: { id: r.companyId, slug: r.slug, name: r.name, logo: logoUrls(r.logoKey) },
          date: r.date,
          datePrecision: r.datePrecision,
          type: r.type,
          text: r.text,
          source: sourceLabel(r.sourceUrl, r.sourceLabel),
        })),
      }
    }
    case 'quotes': {
      const [rows, total] = await Promise.all([
        db
          .select({
            id: quote.id,
            text: quote.text,
            speakerName: quote.speakerName,
            speakerRole: quote.speakerRole,
            date: quote.date,
            sourceUrl: quote.sourceUrl,
            sourceLabel: quote.sourceLabel,
            confidence: quote.confidence,
            personId: person.id,
            fullName: person.fullName,
            status: membership.status,
            slug: company.slug,
            name: company.name,
          })
          .from(quote)
          .leftJoin(person, eq(person.id, quote.personId))
          .leftJoin(membership, eq(membership.personId, quote.personId))
          .leftJoin(company, eq(company.id, quote.companyId))
          .where(lowQuote)
          .orderBy(asc(quote.speakerName), asc(quote.id))
          .limit(limit)
          .offset(offset),
        db.$count(quote, lowQuote),
      ])
      return {
        kind,
        total,
        items: rows.map((r) => ({
          id: r.id,
          text: r.text,
          speakerName: r.speakerName,
          speakerRole: r.speakerRole,
          person:
            r.personId && r.fullName
              ? { personId: r.personId, fullName: r.fullName, active: r.status === 'active' }
              : null,
          company: r.slug && r.name ? { slug: r.slug, name: r.name } : null,
          date: r.date,
          source: sourceLabel(r.sourceUrl, r.sourceLabel),
          confidence: r.confidence,
        })),
      }
    }
    case 'sources':
      return { kind, ...(await sourceGroups(db, { limit, offset })) }
    case 'companyDuplicates': {
      const all = await companyPairs(db)
      return { kind, total: all.length, items: all.slice(offset, offset + limit) }
    }
    case 'personDuplicates': {
      const all = await personPairs(db)
      return { kind, total: all.length, items: all.slice(offset, offset + limit) }
    }
    case 'suggestions':
      return { kind, ...(await pendingSuggestions(db, viewer.personId, { limit, offset })) }
    case 'links':
      return { kind, ...(await pendingUnclaimedLinks(db, { limit, offset })) }
  }
}

// ---------------------------------------------------------------------------
// Godta alle
// ---------------------------------------------------------------------------

/**
 * Det «Godta alle» kan gjelde: bare importerte felt, som medlemmene allerede ser.
 * Hendelser og sitater fra importen er hentet automatisk fra artikler og er ofte
 * feil (avkuttede navn, tilfeldige setninger, feil taler); de må tas ett og ett.
 */
export const bulkReviewKinds = ['sources'] as const
export type BulkReviewKind = (typeof bulkReviewKinds)[number]

export type BulkReviewResult = {
  /** Felt som ble satt som sett over. */
  accepted: number
}

/**
 * «Godta alle» for importerte felt, i én transaksjon og med én linje i loggen:
 * feltene tas ut av køen, som «Ser riktig ut». Medlemmene så dem allerede, og
 * profilen viser fortsatt «ikke bekreftet» til eieren bekrefter.
 */
export async function acceptAllReview(
  db: Db,
  viewer: Viewer,
  kind: BulkReviewKind,
): Promise<BulkReviewResult> {
  assertCan(viewer, 'profiles.edit')
  return db.transaction(async (tx) => {
    const reviewed = await tx
      .update(fieldSource)
      .set({ reviewedAt: new Date() })
      .where(openSource)
      .returning({ id: fieldSource.id })
    const result: BulkReviewResult = { accepted: reviewed.length }
    if (result.accepted) {
      await tx.insert(auditEvent).values({
        actorPersonId: viewer.personId,
        action: 'review.accept_all',
        details: { kind, ...result },
      })
    }
    return result
  })
}
