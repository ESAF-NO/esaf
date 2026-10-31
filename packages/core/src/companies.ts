import { createHash } from 'node:crypto'
import { domainToUnicode } from 'node:url'
import { schema, type CompanyStatus, type Db } from '@esaf/db'
import { and, arrayOverlaps, asc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { assertCan, assertMember, can, type Viewer } from './access.ts'
import { assetViews, loadAssets, type AssetView } from './assets.ts'
import { DomainError, NotFoundError } from './errors.ts'
import {
  loadCompanyArticles,
  moveCompanyArticles,
  type CompanyArticle,
} from './company-articles.ts'
import { loadCompanyEvents, type CompanyEvent } from './company-events.ts'
import {
  listMyLinkRequests,
  loadCompanySuggestions,
  loadRequestedLinks,
  viewerCompanyRoles,
  type LinkRequestView,
  type SuggestionView,
} from './contributions.ts'
import { deleteLogoFiles, logoUrls, type CompanyLogoUrls } from './logos.ts'
import type { Tx } from './members.ts'
import { loadQuotes, type Quote } from './quotes.ts'
import {
  companySourceFields,
  deleteFieldSources,
  loadFieldSources,
  moveCompanySources,
  recordFieldEdits,
  type CompanySourceField,
  type FieldSource,
} from './sources.ts'
import {
  companyName,
  isCompanyName,
  optionalCompanyName,
  optionalText,
  tagList,
  yearInput,
} from './validation.ts'
import { photoUrls, type ProfilePhoto } from './photos.ts'
import type { ObjectStorage } from './storage.ts'

const {
  asset,
  auditEvent,
  cohort,
  company,
  companyEvent,
  companyLinkRequest,
  companySuggestion,
  experience,
  membership,
  notification,
  person,
  personCohort,
  quote,
} = schema

/**
 * URL-vennlig nøkkel for et selskapsnavn. Samme selskap får samme slug uansett
 * skrivemåte («Kahoot!», «kahoot»), og nye navn kobles til selskapet med samme
 * slug. Migreringen som laget selskapene bruker samme regel (SQL-funksjonen
 * `company_slug`), og en test sjekker at de er like.
 */
export function companySlug(name: string) {
  const lower = name.trim().toLocaleLowerCase('nb')
  const slug = lower
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ø/g, 'o')
    .replace(/æ/g, 'ae')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  // Navn uten latinske bokstaver eller tall (f.eks. «Яндекс») får en slug avledet av navnet.
  return slug || `selskap-${createHash('md5').update(lower).digest('hex').slice(0, 8)}`
}

/** Selskapsformer på slutten av et navn: «Syrlig AS» er samme navn som «Syrlig». */
const legalForm = /-(as|asa|ab|aps|oy|nuf|da|ans|sa|bv|gmbh|inc|ltd|llc|plc)$/

/** Om to navn er det samme navnet, bare skrevet annerledes eller med selskapsform. */
export function sameCompanyName(a: string, b: string) {
  return companySlug(a).replace(legalForm, '') === companySlug(b).replace(legalForm, '')
}

/**
 * Tidligere navn med `added` først, uten doble og uten navnet selskapet har nå.
 * Høyst ti.
 */
export function formerNamesWith(existing: string[], added: string[], currentName: string) {
  const kept: string[] = []
  for (const name of [...added, ...existing]) {
    if (sameCompanyName(name, currentName) || kept.some((k) => sameCompanyName(k, name))) continue
    kept.push(name)
  }
  return kept.slice(0, 10)
}

export const companyStatuses = schema.companyStatus.enumValues

// Ligger i validation.ts, så profilene kan bruke dem uten å laste selskapene
// (det ga en importsirkel via vedleggene).
export { companyName, isCompanyName, optionalCompanyName }

const collapseSpaces = (v: string) => v.replace(/\s+/g, ' ')

/**
 * Gjør om det folk skriver («syrlig.no», «http://www.syrlig.no/») til en full
 * lenke. Bare http og https, så lenken aldri kan kjøre kode. Returnerer `null`
 * hvis det ikke er en nettadresse.
 */
export function normalizeWebsite(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
  if (!/^[^.]+(\.[^.]+)+$/.test(url.hostname)) return null
  return url.pathname === '/' && !url.search && !url.hash ? url.origin : url.href
}

/** Felles validering av selskapsinfo, brukt av webappen og senere MCP. Tomme felt lagres som `null`. */
export const companyInput = z.object({
  name: companyName,
  /** Én linje om hva selskapet gjør. */
  tagline: optionalText(140).transform((v) => (v === null ? null : collapseSpaces(v))),
  description: optionalText(3000),
  website: optionalText(300).transform((v, ctx) => {
    if (v === null) return null
    const url = normalizeWebsite(v)
    if (!url) {
      ctx.addIssue({
        code: 'custom',
        message: 'Ugyldig nettadresse. Skriv for eksempel syrlig.no.',
      })
      return z.NEVER
    }
    return url
  }),
  foundedYear: yearInput(1800),
  location: optionalText(80),
  industries: tagList('bransjenavn', 'bransjer'),
  status: z.enum(companyStatuses),
})

export type CompanyInput = z.input<typeof companyInput>

/** Sterkeste tilknytning først: grunnla, ES-team, jobber der, har jobbet der. */
export type CompanyRole = 'founder' | 'es' | 'current' | 'past'
const rank: Record<CompanyRole, number> = { founder: 0, es: 1, current: 2, past: 3 }

export type CompanyPerson = {
  personId: string
  fullName: string
  photo: ProfilePhoto | null
  claimed: boolean
  role: CompanyRole
  /** Har selskapet som ES-selskap, også når rollen er gründer. */
  esTeam: boolean
  /** Stillingen i den erfaringen som sier mest: som gründer, nå, ellers den siste. */
  title: string | null
  startYear: number | null
  endYear: number | null
}

/** Et selskap i oversikten. */
export type Company = {
  id: string
  slug: string
  name: string
  /** `null` når selskapet ikke har logo; da vises en bokstavflis. */
  logo: CompanyLogoUrls | null
  tagline: string | null
  status: CompanyStatus
  location: string | null
  industries: string[]
  /** Navn selskapet hadde før, nyeste først. */
  formerNames: string[]
  /** Grunnlagt av en ES-alumn eller startet på Entreprenørskolen. */
  startedByAlumni: boolean
  /** Noen har oppgitt det som selskapet sitt på Entreprenørskolen. */
  esCompany: boolean
  people: CompanyPerson[]
  /** Kullene til gründerne og ES-teamet. */
  cohortYears: number[]
}

/** Selskapssiden: info om selskapet og alle fra ES som er knyttet til det. */
export type CompanyDetails = Omit<Company, 'people'> & {
  description: string | null
  website: string | null
  /** Domenet uten «www.», til visning. */
  websiteLabel: string | null
  foundedYear: number | null
  /** Siste gang selskapet sto på entreprenorskolen.no, `YYYY-MM-DD`. Fra import. */
  lastSeenOnEsSite: string | null
  editedAt: Date | null
  people: (CompanyPerson & { cohortYears: number[] })[]
  /** Historikken, nyeste først. */
  events: CompanyEvent[]
  /** «I media»: saker om selskapet, nyeste først og de uten dato sist. */
  articles: CompanyArticle[]
  /** Sitater om selskapet eller fra folk i det. */
  quotes: Quote[]
  /** Hvor de importerte feltene kom fra, for feltene som vises. */
  sources: FieldSource<CompanySourceField>[]
  /** Den innloggede er gründer, i ES-teamet eller jobber der nå. */
  connected: boolean
  canEdit: boolean
  /** Admin kan slå selskapet sammen med et duplikat. */
  canMerge: boolean
  /** Hvordan den innloggede selv er knyttet til selskapet, også som tidligere ansatt. */
  viewerRoles: { founder: boolean; employee: boolean; es: boolean }
  /**
   * Åpne forslag: alle for dem som kan redigere, ellers den innloggedes egne.
   * Andre medlemmer foreslår endringer i stedet for å redigere (`!canEdit`).
   */
  suggestions: SuggestionView[]
  /** Noen sier at den innloggede var med i selskapet, og venter på svar. */
  linkRequests: LinkRequestView[]
  /** Den innloggede har lagt til andre her, og venter på at de bekrefter. */
  requestedLinks: LinkRequestView[]
  /**
   * «Dokumenter»: pitch deck, pressemateriale og lignende. Alle medlemmer kan
   * laste ned; de som kan redigere selskapet, laster opp og fjerner.
   */
  documents: AssetView[]
}

/** Slugen er byttet ut (nytt navn, eller slått sammen med et annet selskap). */
export type CompanyMoved = { movedTo: string }

type Link = Omit<CompanyPerson, 'esTeam'> & { companyId: string }

/**
 * Hvem fra ES som er knyttet til selskapene, fra erfaring og ES-selskap. Bare
 * aktive medlemmer tas med, som ellers i appen.
 */
async function loadLinks(db: Db | Tx, companyIds?: string[]): Promise<Link[]> {
  const active = and(eq(membership.personId, person.id), eq(membership.status, 'active'))
  const [esRows, roleRows] = await Promise.all([
    db
      .select({
        companyId: person.esCompanyId,
        personId: person.id,
        fullName: person.fullName,
        userId: person.userId,
        photoKey: person.photoKey,
      })
      .from(person)
      .innerJoin(membership, active)
      .where(companyIds ? inArray(person.esCompanyId, companyIds) : isNotNull(person.esCompanyId)),
    db
      .select({
        companyId: experience.companyId,
        personId: person.id,
        fullName: person.fullName,
        userId: person.userId,
        photoKey: person.photoKey,
        title: experience.title,
        startYear: experience.startYear,
        endYear: experience.endYear,
        founder: experience.founder,
      })
      .from(experience)
      .innerJoin(person, eq(person.id, experience.personId))
      .innerJoin(membership, active)
      .where(companyIds ? inArray(experience.companyId, companyIds) : undefined)
      .orderBy(asc(experience.position)),
  ])
  return [
    ...esRows.map((r) => ({
      companyId: r.companyId!,
      personId: r.personId,
      fullName: r.fullName,
      photo: photoUrls(r.photoKey),
      claimed: r.userId !== null,
      role: 'es' as const,
      title: null,
      startYear: null,
      endYear: null,
    })),
    ...roleRows.map(({ userId, founder, photoKey, ...r }) => ({
      ...r,
      photo: photoUrls(photoKey),
      claimed: userId !== null,
      role: (founder ? 'founder' : r.endYear === null ? 'current' : 'past') as CompanyRole,
    })),
  ]
}

/**
 * Én oppføring per person og selskap, med den sterkeste tilknytningen. Stilling
 * og årstall hentes fra erfaringen som sier mest, også for ES-teamet.
 */
function groupPeople(links: Link[]): Map<string, CompanyPerson[]> {
  const byCompany = new Map<string, Map<string, CompanyPerson>>()
  const withRole = new Set<CompanyPerson>()
  // Erfaringen som sier mest først: som gründer, så nåværende, så den sist avsluttede.
  const sorted = [...links].sort(
    (a, b) => rank[a.role] - rank[b.role] || (b.endYear ?? 0) - (a.endYear ?? 0),
  )
  for (const { companyId, ...link } of sorted) {
    const people = byCompany.get(companyId) ?? new Map<string, CompanyPerson>()
    byCompany.set(companyId, people)
    const existing = people.get(link.personId)
    if (!existing) {
      const entry = { ...link, esTeam: link.role === 'es' }
      people.set(link.personId, entry)
      if (link.role !== 'es') withRole.add(entry)
    } else if (link.role === 'es') {
      existing.esTeam = true
    } else if (!withRole.has(existing)) {
      // ES-teamet får stilling og år fra erfaringen sin i selskapet, hvis de har en.
      Object.assign(existing, {
        title: link.title,
        startYear: link.startYear,
        endYear: link.endYear,
      })
      withRole.add(existing)
    }
  }
  return new Map(
    [...byCompany].map(([id, people]) => [
      id,
      [...people.values()].sort(
        (a, b) =>
          rank[a.role] - rank[b.role] ||
          (a.role === 'past' ? (b.endYear ?? 0) - (a.endYear ?? 0) : 0) ||
          a.fullName.localeCompare(b.fullName, 'nb'),
      ),
    ]),
  )
}

/** Kullene til personene, som uteksamineringsår. */
async function cohortYears(db: Db | Tx, personIds: string[]): Promise<Map<string, number[]>> {
  const ids = [...new Set(personIds)]
  const byPerson = new Map<string, number[]>()
  if (!ids.length) return byPerson
  const rows = await db
    .select({ personId: personCohort.personId, year: cohort.graduationYear })
    .from(personCohort)
    .innerJoin(cohort, eq(cohort.id, personCohort.cohortId))
    .where(inArray(personCohort.personId, ids))
    .orderBy(asc(cohort.graduationYear))
  for (const r of rows) byPerson.set(r.personId, [...(byPerson.get(r.personId) ?? []), r.year])
  return byPerson
}

const isTeam = (p: CompanyPerson) => p.role === 'founder' || p.esTeam

function summarize(
  people: CompanyPerson[],
  years: Map<string, number[]>,
): Pick<Company, 'startedByAlumni' | 'esCompany' | 'cohortYears'> {
  const team = people.filter(isTeam)
  return {
    startedByAlumni: team.length > 0,
    esCompany: people.some((p) => p.esTeam),
    cohortYears: [...new Set(team.flatMap((p) => years.get(p.personId) ?? []))].sort(),
  }
}

/**
 * Selskaper ES-alumni har startet, jobber i eller har jobbet i. Selskaper ingen
 * aktive medlemmer er knyttet til, vises ikke i oversikten.
 */
export async function listCompanies(db: Db, viewer: Viewer): Promise<Company[]> {
  assertMember(viewer)
  const [rows, links] = await Promise.all([
    db
      .select({
        id: company.id,
        slug: company.slug,
        name: company.name,
        logoKey: company.logoKey,
        tagline: company.tagline,
        status: company.status,
        location: company.location,
        industries: company.industries,
        formerNames: company.formerNames,
      })
      .from(company),
    loadLinks(db),
  ])
  const peopleByCompany = groupPeople(links)
  const years = await cohortYears(
    db,
    [...peopleByCompany.values()].flatMap((people) => people.filter(isTeam).map((p) => p.personId)),
  )
  return rows
    .flatMap(({ logoKey, ...row }) => {
      const people = peopleByCompany.get(row.id)
      return people
        ? [{ ...row, logo: logoUrls(logoKey), ...summarize(people, years), people }]
        : []
    })
    .sort(
      (a, b) =>
        Number(b.startedByAlumni) - Number(a.startedByAlumni) ||
        b.people.length - a.people.length ||
        a.name.localeCompare(b.name, 'nb'),
    )
}

const editableColumns = {
  id: company.id,
  slug: company.slug,
  name: company.name,
  aliasSlugs: company.aliasSlugs,
  formerNames: company.formerNames,
  tagline: company.tagline,
  description: company.description,
  website: company.website,
  foundedYear: company.foundedYear,
  location: company.location,
  industries: company.industries,
  status: company.status,
  logoKey: company.logoKey,
  lastSeenOnEsSite: company.lastSeenOnEsSite,
  editedAt: company.editedAt,
}

/** Selskapet med denne slugen, eller hvor slugen har flyttet (navnebytte eller sammenslåing). */
async function findCompany(db: Db | Tx, slug: string) {
  const [row] = await db.select(editableColumns).from(company).where(eq(company.slug, slug))
  if (row) return row
  const [moved] = await db
    .select({ slug: company.slug })
    .from(company)
    .where(sql`${slug} = any(${company.aliasSlugs})`)
  if (moved) return { movedTo: moved.slug }
  throw new NotFoundError('Fant ikke selskapet.')
}

/**
 * Gründer (også tidligere), i ES-teamet eller ansatt nå. Tidligere ansatte regnes
 * ikke med. Avgjør hvem som kan redigere selskapet, også logoen (logos.ts).
 */
export async function isConnected(db: Db | Tx, personId: string, companyId: string) {
  const [[role], [es]] = await Promise.all([
    db
      .select({ id: experience.id })
      .from(experience)
      .where(
        and(
          eq(experience.personId, personId),
          eq(experience.companyId, companyId),
          or(eq(experience.founder, true), isNull(experience.endYear)),
        ),
      )
      .limit(1),
    db
      .select({ id: person.id })
      .from(person)
      .where(and(eq(person.id, personId), eq(person.esCompanyId, companyId))),
  ])
  return Boolean(role || es)
}

/**
 * Selskapet, når den innloggede kan redigere det: gründere (også tidligere),
 * ES-teamet, de som jobber der nå og admins med `profiles.edit`. `adminEdit`
 * betyr at endringen gjøres med adminrettighet og skal logges. Brukes av
 * redigering, logo og historikk.
 */
export async function companyForEdit(
  db: Db | Tx,
  viewer: Viewer,
  companyId: string,
  { lock = false } = {},
) {
  assertMember(viewer)
  const query = db
    .select({ id: company.id, slug: company.slug, name: company.name, logoKey: company.logoKey })
    .from(company)
    .where(eq(company.id, companyId))
  const [row] = lock ? await query.for('update') : await query
  if (!row) throw new NotFoundError('Fant ikke selskapet.')
  const connected = await isConnected(db, viewer.personId, companyId)
  if (!connected) assertCan(viewer, 'profiles.edit')
  return { ...row, adminEdit: !connected }
}

/** Domenet uten «www.», med æøå i stedet for punycode. */
function websiteLabel(website: string | null) {
  if (!website) return null
  try {
    return domainToUnicode(new URL(website).hostname).replace(/^www\./, '')
  } catch {
    return null
  }
}

/** Selskapssiden, for alle aktive medlemmer. */
export async function getCompany(
  db: Db,
  viewer: Viewer,
  slug: string,
): Promise<CompanyDetails | CompanyMoved> {
  assertMember(viewer)
  const found = await findCompany(db, slug)
  if ('movedTo' in found) return found
  const { aliasSlugs: _aliasSlugs, logoKey, ...row } = found
  const people = groupPeople(await loadLinks(db, [row.id])).get(row.id) ?? []
  const years = await cohortYears(
    db,
    people.map((p) => p.personId),
  )
  const connected = people.some((p) => p.personId === viewer.personId && p.role !== 'past')
  const canEdit = connected || can(viewer, 'profiles.edit')
  // Kilder bare for feltene som vises.
  const shown = companySourceFields.filter((field) =>
    field === 'logo'
      ? logoKey !== null
      : field === 'industries'
        ? row.industries.length > 0
        : field === 'lastSeenOnEsSite'
          ? row.status === 'unknown' && row.lastSeenOnEsSite !== null
          : row[field] !== null,
  )
  const [
    events,
    articles,
    quotes,
    sources,
    viewerRoles,
    suggestions,
    linkRequests,
    requestedLinks,
  ] = await Promise.all([
    loadCompanyEvents(db, row.id, { includeReview: canEdit }),
    loadCompanyArticles(db, row.id),
    loadQuotes(db, viewer, { companyId: row.id }),
    loadFieldSources(db, viewer, 'company', row.id, shown),
    viewerCompanyRoles(db, viewer.personId, row.id),
    loadCompanySuggestions(db, viewer, row.id, { canEdit }),
    listMyLinkRequests(db, viewer, { companyId: row.id }),
    loadRequestedLinks(db, viewer, row.id),
  ])
  const moderator = can(viewer, 'content.moderate')
  const documents = assetViews(
    await loadAssets(db, viewer, { companyId: row.id }, () => canEdit || moderator),
  )
  return {
    ...row,
    logo: logoUrls(logoKey),
    ...summarize(people, years),
    websiteLabel: websiteLabel(row.website),
    people: people.map((p) => ({ ...p, cohortYears: years.get(p.personId) ?? [] })),
    events,
    articles,
    quotes,
    sources,
    connected,
    canEdit,
    canMerge: can(viewer, 'profiles.edit'),
    viewerRoles,
    suggestions,
    linkRequests,
    requestedLinks,
    documents,
  }
}

export type EditableCompany = z.output<typeof companyInput> & {
  id: string
  slug: string
  /** Endres for seg, med `setCompanyLogo` og `removeCompanyLogo`. */
  logo: CompanyLogoUrls | null
  /** Redigerer med adminrettighet, uten å være knyttet til selskapet. Endringen logges. */
  adminEdit: boolean
  /** Kan slå sammen duplikater. */
  canMerge: boolean
  /** Endres for seg, med `setCompanyFormerNames`. */
  formerNames: string[]
}

/** Selskapsinfo for den som skal redigere: gründere, ES-teamet, ansatte nå og admins. */
export async function getEditableCompany(
  db: Db,
  viewer: Viewer,
  slug: string,
): Promise<EditableCompany | CompanyMoved> {
  assertMember(viewer)
  const found = await findCompany(db, slug)
  if ('movedTo' in found) return found
  const connected = await isConnected(db, viewer.personId, found.id)
  if (!connected) assertCan(viewer, 'profiles.edit')
  const {
    aliasSlugs: _aliasSlugs,
    editedAt: _editedAt,
    lastSeenOnEsSite: _lastSeen,
    logoKey,
    ...fields
  } = found
  return {
    ...fields,
    logo: logoUrls(logoKey),
    adminEdit: !connected,
    canMerge: can(viewer, 'profiles.edit'),
  }
}

export const pgCode = (error: unknown): string | undefined => {
  const e = error as { code?: string; cause?: { code?: string } } | null
  return e?.code ?? e?.cause?.code
}

const sameTags = (a: string[], b: string[]) =>
  a.length === b.length && a.every((tag, i) => tag === b[i])

/** Selskapsinfo slik den står i databasen, låst for oppdatering. */
type CompanyRow = Awaited<ReturnType<typeof lockCompany>>

export async function lockCompany(tx: Tx, companyId: string) {
  const [current] = await tx
    .select(editableColumns)
    .from(company)
    .where(eq(company.id, companyId))
    .for('update')
  if (!current) throw new NotFoundError('Fant ikke selskapet.')
  return current
}

/** Feltene i `values` som er forskjellige fra det som står i databasen. */
export function changedCompanyFields(
  current: Pick<CompanyRow, keyof z.output<typeof companyInput>>,
  values: Partial<z.output<typeof companyInput>>,
) {
  return (Object.keys(values) as (keyof typeof values)[]).filter((key) =>
    key === 'industries'
      ? !sameTags(values.industries!, current.industries)
      : values[key] !== current[key],
  )
}

/**
 * Skriver endret selskapsinfo i en transaksjon som allerede har låst selskapet
 * og sjekket tilgang. Nytt navn gir ny slug, og den gamle blir et alias. `connected`
 * avgjør om kildene bekreftes (knyttet til selskapet) eller glemmes (admin).
 * Gir feltene som faktisk ble endret.
 */
export async function writeCompanyValues(
  tx: Tx,
  viewer: Viewer,
  current: CompanyRow,
  values: Partial<z.output<typeof companyInput>>,
  { connected }: { connected: boolean },
): Promise<{ slug: string; changed: string[] }> {
  const changed = changedCompanyFields(current, values)
  if (!changed.length) return { slug: current.slug, changed }
  const name = values.name ?? current.name
  const slug = companySlug(name)
  if (slug !== current.slug) {
    const [taken] = await tx
      .select({ name: company.name })
      .from(company)
      .where(
        and(
          ne(company.id, current.id),
          or(eq(company.slug, slug), sql`${slug} = any(${company.aliasSlugs})`),
        ),
      )
    if (taken) {
      throw new DomainError(
        `Navnet hører allerede til ${taken.name}. ` +
          (can(viewer, 'profiles.edit')
            ? 'Slå dem sammen i stedet, under Admin → Selskaper eller nederst på redigeringssiden.'
            : 'Be en admin om å slå dem sammen.'),
      )
    }
  }
  await tx
    .update(company)
    .set({
      ...values,
      slug,
      aliasSlugs: [...new Set([...current.aliasSlugs, current.slug])].filter((s) => s !== slug),
      // Et nytt navn (ikke bare ny skrivemåte) gjør det gamle til et tidligere navn.
      formerNames: sameCompanyName(name, current.name)
        ? current.formerNames
        : formerNamesWith(current.formerNames, [current.name], name),
      editedAt: new Date(),
    })
    .where(eq(company.id, current.id))
  // De som er knyttet til selskapet, bekrefter det de endrer; admins erstatter det.
  await recordFieldEdits(tx, 'company', current.id, changed, connected ? 'confirm' : 'forget')
  return { slug, changed }
}

/** Oversetter brudd på unik slug (to samtidige navnebytter til samme navn). */
export function rethrowSlugConflict(error: unknown): never {
  if (pgCode(error) === '23505') throw new DomainError('Navnet hører allerede til et selskap.')
  throw error
}

/**
 * Lagrer selskapsinfo. Gründere, ES-teamet og de som jobber der nå kan endre den,
 * og admins (`profiles.edit`). Admins som ikke selv er knyttet til selskapet, blir
 * logget. Nytt navn gir ny slug; den gamle blir et alias, så gamle lenker virker.
 */
export async function updateCompany(
  db: Db,
  viewer: Viewer,
  companyId: string,
  input: CompanyInput,
): Promise<{ slug: string }> {
  assertMember(viewer)
  const parsed = companyInput.safeParse(input)
  if (!parsed.success) throw new DomainError(parsed.error.issues[0]?.message ?? 'Ugyldige felt.')
  const values = parsed.data

  try {
    return await db.transaction(async (tx) => {
      const current = await lockCompany(tx, companyId)
      const connected = await isConnected(tx, viewer.personId, companyId)
      if (!connected) assertCan(viewer, 'profiles.edit')
      const { slug, changed } = await writeCompanyValues(tx, viewer, current, values, {
        connected,
      })
      if (changed.length && !connected) {
        await tx.insert(auditEvent).values({
          actorPersonId: viewer.personId,
          action: 'company.admin_edit',
          details: {
            companyId,
            slug,
            name: values.name,
            fields: changed,
            ...(values.name !== current.name ? { previousName: current.name } : {}),
          },
        })
      }
      return { slug }
    })
  } catch (error) {
    return rethrowSlugConflict(error)
  }
}

export const formerNamesInput = z
  .array(companyName)
  .max(10, 'Høyst ti tidligere navn.')
  .transform((names) =>
    names.filter((n, i) => !names.slice(0, i).some((m) => sameCompanyName(m, n))),
  )

/**
 * Setter de tidligere navnene, i rekkefølgen de står (nyeste først). Samme tilgang
 * som å redigere selskapet. Et nytt tidligere navn blir også et alias, så erfaring
 * med det gamle navnet havner her og gamle lenker virker. Et navn et annet selskap
 * har, avvises: da er det to selskaper som bør slås sammen. Admins som ikke er
 * knyttet til selskapet, logges (`company.admin_edit`).
 */
export async function setCompanyFormerNames(
  db: Db,
  viewer: Viewer,
  companyId: string,
  input: string[],
): Promise<{ formerNames: string[] }> {
  assertMember(viewer)
  const parsed = formerNamesInput.safeParse(input)
  if (!parsed.success) throw new DomainError(parsed.error.issues[0]?.message ?? 'Ugyldige navn.')
  try {
    return await db.transaction(async (tx) => {
      const { adminEdit } = await companyForEdit(tx, viewer, companyId, { lock: true })
      const current = await lockCompany(tx, companyId)
      const formerNames = formerNamesWith([], parsed.data, current.name)
      const added = formerNames.filter(
        (n) => !current.formerNames.some((m) => sameCompanyName(m, n)),
      )
      const slugs = added.map(companySlug).filter((s) => s !== current.slug)
      if (slugs.length) {
        const [taken] = await tx
          .select({ name: company.name, slug: company.slug, aliasSlugs: company.aliasSlugs })
          .from(company)
          .where(
            and(
              ne(company.id, companyId),
              or(inArray(company.slug, slugs), arrayOverlaps(company.aliasSlugs, slugs)),
            ),
          )
        if (taken) {
          const name = added.find((n) => {
            const s = companySlug(n)
            return s === taken.slug || taken.aliasSlugs.includes(s)
          })
          throw new DomainError(
            `«${name ?? taken.name}» er ${taken.name}, et annet selskap i appen. ` +
              (can(viewer, 'profiles.edit')
                ? 'Slå dem sammen i stedet, og kryss av for at det er et tidligere navn.'
                : 'Be en admin om å slå dem sammen.'),
          )
        }
      }
      if (
        formerNames.length === current.formerNames.length &&
        formerNames.every((n, i) => n === current.formerNames[i])
      ) {
        return { formerNames }
      }
      await tx
        .update(company)
        .set({
          formerNames,
          aliasSlugs: [...new Set([...current.aliasSlugs, ...slugs])],
          editedAt: new Date(),
        })
        .where(eq(company.id, companyId))
      if (adminEdit) {
        await tx.insert(auditEvent).values({
          actorPersonId: viewer.personId,
          action: 'company.admin_edit',
          details: {
            companyId,
            slug: current.slug,
            name: current.name,
            fields: ['formerNames'],
            formerNames,
            previousFormerNames: current.formerNames,
          },
        })
      }
      return { formerNames }
    })
  } catch (error) {
    return rethrowSlugConflict(error)
  }
}

export type CompanyRef = {
  /** Selskapet som ble valgt i forslagslisten, hvis noe. */
  companyId?: string | null
  /** Navnet slik det står i feltet. */
  name: string
}

/**
 * Finner selskapet for hver referanse, i samme rekkefølge: det valgte selskapet
 * hvis det finnes, ellers selskapet med samme slug (også tidligere navn og
 * sammenslåtte duplikater), ellers et nytt. Får flere nye referanser samme slug,
 * blir det ett selskap med skrivemåten som er brukt flest ganger, som i
 * migreringen som laget selskapene fra dagens navn.
 *
 * Nye selskaper får `status`: `active` når et medlem skriver inn et selskap selv
 * (de vet at det finnes), `unknown` fra import, der ingen har sagt noe om det.
 */
export async function resolveCompanies(
  db: Db | Tx,
  refs: CompanyRef[],
  { status = 'active' }: { status?: CompanyStatus } = {},
): Promise<string[]> {
  const chosen = [...new Set(refs.flatMap((r) => (r.companyId ? [r.companyId] : [])))]
  const known = new Set(
    chosen.length
      ? (await db.select({ id: company.id }).from(company).where(inArray(company.id, chosen))).map(
          (c) => c.id,
        )
      : [],
  )
  const ids = refs.map((r) => (r.companyId && known.has(r.companyId) ? r.companyId : null))
  const typed = refs.flatMap((r, i) =>
    ids[i] ? [] : [{ i, name: collapseSpaces(r.name.trim()), slug: companySlug(r.name) }],
  )
  if (!typed.length) return ids as string[]
  if (!typed.every((t) => isCompanyName(t.name))) {
    throw new DomainError('Selskapsnavnet må ha bokstaver eller tall.')
  }

  const slugs = [...new Set(typed.map((t) => t.slug))]
  const existing = await db
    .select({ id: company.id, slug: company.slug, aliasSlugs: company.aliasSlugs })
    .from(company)
    .where(or(inArray(company.slug, slugs), arrayOverlaps(company.aliasSlugs, slugs)))
  const bySlug = new Map<string, string>()
  // Et selskap som har slugen som navn, går foran et som har den som alias.
  for (const c of existing) for (const alias of c.aliasSlugs) bySlug.set(alias, c.id)
  for (const c of existing) bySlug.set(c.slug, c.id)

  const spellings = new Map<string, Map<string, number>>()
  for (const t of typed) {
    if (bySlug.has(t.slug)) continue
    const counts = spellings.get(t.slug) ?? new Map<string, number>()
    counts.set(t.name, (counts.get(t.name) ?? 0) + 1)
    spellings.set(t.slug, counts)
  }
  if (spellings.size) {
    const created = [...spellings].map(([slug, counts]) => ({
      slug,
      // Flest bruk vinner; ved likt antall den som kom først.
      name: [...counts].sort((a, b) => b[1] - a[1])[0]![0],
      status,
    }))
    const inserted = await db
      .insert(company)
      .values(created)
      .onConflictDoNothing({ target: company.slug })
      .returning({ id: company.id, slug: company.slug })
    for (const c of inserted) bySlug.set(c.slug, c.id)
    // Opprettet av noen andre i samme øyeblikk.
    const raced = created.filter((c) => !bySlug.has(c.slug)).map((c) => c.slug)
    if (raced.length) {
      const rows = await db
        .select({ id: company.id, slug: company.slug })
        .from(company)
        .where(inArray(company.slug, raced))
      for (const c of rows) bySlug.set(c.slug, c.id)
    }
  }
  for (const t of typed) ids[t.i] = bySlug.get(t.slug) ?? null
  if (ids.some((id) => id === null))
    throw new DomainError('Kunne ikke lagre selskapet. Prøv igjen.')
  return ids as string[]
}

/**
 * Fjerner selskaper som bare ble opprettet fra et navn (aldri redigert), og som
 * ingen lenger er knyttet til, for eksempel etter at en skrivefeil er rettet.
 */
export async function deleteOrphanCompanies(tx: Tx, companyIds: (string | null)[]) {
  const ids = [...new Set(companyIds.filter((id): id is string => id !== null))]
  if (!ids.length) return
  try {
    await tx.transaction(async (savepoint) => {
      const deleted = await savepoint
        .delete(company)
        .where(
          and(
            inArray(company.id, ids),
            isNull(company.editedAt),
            isNull(company.logoKey),
            sql`not exists (select 1 from ${experience} where ${experience.companyId} = ${company.id})`,
            sql`not exists (select 1 from ${person} where ${person.esCompanyId} = ${company.id})`,
          ),
        )
        .returning({ id: company.id })
      await deleteFieldSources(
        savepoint,
        'company',
        deleted.map((c) => c.id),
      )
    })
  } catch (error) {
    // Noen koblet seg til selskapet i samme øyeblikk. Da får det bli stående.
    if (pgCode(error) !== '23503') throw error
  }
}

export type CompanyHit = {
  id: string
  slug: string
  name: string
  logo: CompanyLogoUrls | null
  tagline: string | null
  /** Aktive medlemmer knyttet til selskapet. */
  people: number
  /** Søket er samme selskap som et eksisterende, bare skrevet annerledes. */
  exact: boolean
  /** Navn selskapet hadde før. Søket treffer dem også. */
  formerNames: string[]
}

/**
 * Søk etter selskaper på navn, til forslag når man skriver inn erfaring og til
 * ⌘K. Samme selskap skrevet på en annen måte kommer først, så de som flest fra
 * ES er knyttet til. «Statkraft AS» foreslår også «Statkraft», så det er lett å
 * velge selskapet som finnes i stedet for å lage et nytt.
 */
export async function searchCompanies(
  db: Db,
  viewer: Viewer,
  query: string,
  limit = 8,
): Promise<CompanyHit[]> {
  assertMember(viewer)
  const q = collapseSpaces(query.trim())
  if (!q) return []
  const slug = companySlug(q)
  const exact = sql<boolean>`(${company.slug} = ${slug} or ${slug} = any(${company.aliasSlugs}))`
  // Drizzle skriver kolonnene uten tabellnavn i select-listen når spørringen har én
  // tabell, så delspørringen bruker egne alias og navngir selskapet eksplisitt.
  const people = sql<number>`(select count(*)::int from (
    select e.person_id from experience e
      inner join membership m on m.person_id = e.person_id and m.status = 'active'
      where e.company_id = ${sql.raw('"company"."id"')}
    union
    select p.id from person p
      inner join membership m on m.person_id = p.id and m.status = 'active'
      where p.es_company_id = ${sql.raw('"company"."id"')}
  ) as linked)`
  const escaped = q.replace(/[%_\\]/g, '\\$&')
  const rows = await db
    .select({
      id: company.id,
      slug: company.slug,
      name: company.name,
      logoKey: company.logoKey,
      tagline: company.tagline,
      formerNames: company.formerNames,
      people,
      exact,
    })
    .from(company)
    .where(
      or(
        sql`${company.name} ilike ${`%${escaped}%`}`,
        sql`${company.slug} like ${`%${slug}%`}`,
        sql`${slug} = any(${company.aliasSlugs})`,
        sql`array_to_string(${company.formerNames}, ' ') ilike ${`%${escaped}%`}`,
        sql`${slug} like ${company.slug} || '-%'`,
      ),
    )
    .orderBy(
      sql`${exact} desc`,
      sql`(${company.name} ilike ${`${escaped}%`} or ${company.slug} like ${`${slug}%`}) desc`,
      sql`${people} desc`,
      asc(company.name),
    )
    .limit(Math.min(limit, 20))
  return rows.map(({ logoKey, ...row }) => ({ ...row, logo: logoUrls(logoKey) }))
}

/**
 * Slår sammen to skrivemåter av samme selskap. Erfaring, ES-team, historikk,
 * saker i media, sitater, forslag og varsler flyttes til `targetId`, tomme felt
 * fylles fra duplikatet, og duplikatets slug blir et alias, så gamle lenker og
 * den gamle skrivemåten finner fram. Har bare duplikatet logo,
 * flyttes den; har begge, beholdes logoen hit og duplikatets slettes. Krever
 * `profiles.edit`, siden det endrer erfaringen på andres profiler. Logges.
 */
export async function mergeCompanies(
  db: Db,
  storage: ObjectStorage,
  viewer: Viewer,
  input: {
    sourceId: string
    targetId: string
    /** Duplikatets navn er et tidligere navn på selskapet, ikke en annen skrivemåte. */
    formerName?: boolean
  },
): Promise<{ slug: string }> {
  assertCan(viewer, 'profiles.edit')
  if (input.sourceId === input.targetId) throw new DomainError('Velg et annet selskap.')

  const { slug, unusedLogo } = await db.transaction(async (tx) => {
    // Låses i fast rekkefølge, så to samtidige sammenslåinger ikke venter på hverandre.
    const rows = await tx
      .select(editableColumns)
      .from(company)
      .where(inArray(company.id, [input.sourceId, input.targetId]))
      .orderBy(asc(company.id))
      .for('update')
    const source = rows.find((r) => r.id === input.sourceId)
    const target = rows.find((r) => r.id === input.targetId)
    if (!source || !target) throw new NotFoundError('Fant ikke selskapet.')

    const moved = await tx
      .update(experience)
      .set({ companyId: target.id })
      .where(eq(experience.companyId, source.id))
      .returning({ id: experience.id })
    const team = await tx
      .update(person)
      .set({ esCompanyId: target.id })
      .where(eq(person.esCompanyId, source.id))
      .returning({ id: person.id })

    // Historikken og sitatene følger med.
    await tx
      .update(companyEvent)
      .set({ companyId: target.id })
      .where(eq(companyEvent.companyId, source.id))
    await tx.update(quote).set({ companyId: target.id }).where(eq(quote.companyId, source.id))
    // Dokumentene også.
    await tx.update(asset).set({ companyId: target.id }).where(eq(asset.companyId, source.id))
    // Sakene i media følger med, utenom dem selskapet det slås sammen med, allerede har.
    const articles = await moveCompanyArticles(tx, source.id, target.id)
    // Forslag, tilknytninger og varsler om duplikatet gjelder nå selskapet det slås sammen med.
    await tx
      .update(companySuggestion)
      .set({ companyId: target.id })
      .where(eq(companySuggestion.companyId, source.id))
    // En åpen tilknytning for samme person og rolle i begge blir én.
    await tx
      .delete(companyLinkRequest)
      .where(
        and(
          eq(companyLinkRequest.companyId, source.id),
          eq(companyLinkRequest.status, 'pending'),
          sql`exists (select 1 from ${companyLinkRequest} other where other.company_id = ${target.id} and other.person_id = ${companyLinkRequest.personId} and other.role = ${companyLinkRequest.role} and other.status = 'pending')`,
        ),
      )
    await tx
      .update(companyLinkRequest)
      .set({ companyId: target.id })
      .where(eq(companyLinkRequest.companyId, source.id))
    await tx
      .update(notification)
      .set({ companyId: target.id })
      .where(eq(notification.companyId, source.id))
    // Kildene følger feltene som hentes fra duplikatet.
    const filled: CompanySourceField[] = (
      ['tagline', 'description', 'website', 'foundedYear', 'location'] as const
    ).filter((field) => target[field] === null && source[field] !== null)
    if (target.logoKey === null && source.logoKey !== null) filled.push('logo')
    if (!target.industries.length && source.industries.length) filled.push('industries')
    if ((source.lastSeenOnEsSite ?? '') > (target.lastSeenOnEsSite ?? '')) {
      filled.push('lastSeenOnEsSite')
    }
    await moveCompanySources(tx, source.id, target.id, filled)

    const industries = [...target.industries, ...source.industries]
      .filter(
        (tag, i, all) =>
          all.findIndex((t) => t.toLocaleLowerCase('nb') === tag.toLocaleLowerCase('nb')) === i,
      )
      .slice(0, 10)
    const edited = [target.editedAt, source.editedAt].filter((d): d is Date => d !== null)
    await tx.delete(company).where(eq(company.id, source.id))
    await tx
      .update(company)
      .set({
        tagline: target.tagline ?? source.tagline,
        description: target.description ?? source.description,
        website: target.website ?? source.website,
        foundedYear: target.foundedYear ?? source.foundedYear,
        location: target.location ?? source.location,
        lastSeenOnEsSite:
          [target.lastSeenOnEsSite, source.lastSeenOnEsSite]
            .filter((d): d is string => d !== null)
            .sort()
            .at(-1) ?? null,
        // Duplikatet er slettet over, så nøkkelen er ledig.
        logoKey: target.logoKey ?? source.logoKey,
        industries,
        aliasSlugs: [...new Set([...target.aliasSlugs, source.slug, ...source.aliasSlugs])].filter(
          (s) => s !== target.slug,
        ),
        // Duplikatets tidligere navn følger alltid med; navnet selv bare når det er
        // et tidligere navn og ikke en annen skrivemåte.
        formerNames: formerNamesWith(
          target.formerNames,
          input.formerName ? [source.name, ...source.formerNames] : source.formerNames,
          target.name,
        ),
        editedAt: edited.length ? new Date(Math.max(...edited.map((d) => d.getTime()))) : null,
      })
      .where(eq(company.id, target.id))

    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'company.merge',
      details: {
        from: { companyId: source.id, slug: source.slug, name: source.name },
        into: { companyId: target.id, slug: target.slug, name: target.name },
        formerName: input.formerName === true,
        experience: moved.length,
        esTeam: team.length,
        articles,
      },
    })
    return {
      slug: target.slug,
      unusedLogo: target.logoKey && source.logoKey ? source.logoKey : null,
    }
  })
  if (unusedLogo) await deleteLogoFiles(storage, unusedLogo)
  return { slug }
}
