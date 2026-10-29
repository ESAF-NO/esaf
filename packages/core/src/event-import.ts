import { schema, type Db, type EventDatePrecision } from '@esaf/db'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { assertCan, type Viewer } from './access.ts'
import { DomainError } from './errors.ts'
import {
  ESAF_WEEKEND_SLUG,
  eventDatePrecisions,
  eventRoles,
  insertEvent,
  normalizeRole,
  osloToday,
  parseEventInput,
  periodEventName,
  periodStart,
  rolePriority,
  type EventRole,
  type EventTypeInfo,
} from './events.ts'
import { emailKey, normalizeEmail, type Tx } from './members.ts'
import { insertProfile, normalizePersonName } from './people-admin.ts'
import {
  loadMatchPeople,
  parseAttendeeLine,
  personMatcher,
  type MatchPerson,
  type PersonMatch,
} from './person-match.ts'
import { defaultHeaders } from './profile-import.ts'
import {
  columnLetter,
  findHeaderRow,
  mapHeader,
  normalizeValue,
  parseCohortCell,
  parseDateCell,
  readSpreadsheet,
  rowLabel,
  type Grid,
  type HeaderMap,
} from './spreadsheet.ts'

const { auditEvent, event, eventParticipation, eventType, person } = schema

/**
 * Import av deltakelse fra regneark. Tre oppsett kjennes igjen automatisk, og
 * admin kan rette det:
 *
 * - `matrix`: én rad per person (navn og/eller e-post, gjerne kull), én kolonne
 *   per arrangement. En celle med innhold betyr at personen var der, og
 *   verdien sier rollen («x», «ja» → deltaker, «arr» → arrangør …).
 * - `sheets`: én fane per arrangement, med fanenavnet som arrangement og én
 *   person per rad, gjerne med en rollekolonne. En CSV er én fane med filnavnet.
 * - `long`: én rad per deltakelse: person, arrangement og eventuelt rolle.
 *
 * Tolkingen (`parseParticipation`) er ren og testbar. Forhåndsvisningen matcher
 * personer og arrangementer mot databasen; ingenting lagres før admin
 * bekrefter, og da i én transaksjon (`applyParticipationImport`). Samme fil
 * to ganger gir ingen nye rader: kjente deltakere står som uendret, og en ny
 * rolle vises som en endring. En deltakelse uten rolle tar aldri bort en rolle
 * som allerede er satt.
 */

export type ParticipationLayout = 'matrix' | 'sheets' | 'long'
export const participationLayouts = ['matrix', 'sheets', 'long'] as const

/** Hva en celleverdi betyr: en rolle, deltaker (`attended`) eller ikke med (`skip`). */
export type RoleChoice = 'attended' | EventRole | 'skip'
export const roleChoices = ['attended', ...eventRoles, 'skip'] as const

/** Verdier som kjennes igjen uten videre. Nøklene er normalisert med `normalizeValue`. */
export const defaultRoleValues: Record<string, RoleChoice> = Object.fromEntries(
  (
    [
      [
        'attended',
        'x ✓ ✔ ☑ ✅ v ja j yes y 1 true sant deltok deltaker deltager deltatt var der til stede tilstede attended participant',
      ],
      ['organizer', 'arr arrangor arrangorer arrangert org organizer organiser komite styret'],
      [
        'speaker',
        'foredrag foredragsholder holdt foredrag taler speaker innleder panel paneldeltaker',
      ],
      ['volunteer', 'frivillig hjelper hjelp volunteer crew funksjonaer'],
      ['skip', 'nei n no 0 false usant - – — ikke ikke med'],
    ] as const
  ).flatMap(([role, words]) => {
    // Flerordsverdier («var der», «til stede») står med mellomrom; resten er ett ord hver.
    const multi = ['holdt foredrag', 'var der', 'til stede', 'ikke med']
    let rest: string = words
    const found: string[] = []
    for (const m of multi) {
      if (rest.includes(m)) {
        found.push(m)
        rest = rest.replace(m, ' ')
      }
    }
    return [...found, ...rest.split(/\s+/).filter(Boolean)].map((w) => [w, role as RoleChoice])
  }),
)

/** Hva en verdi betyr. Ukjente verdier regnes som deltaker, men vises for admin. */
export function roleOfValue(
  raw: string,
  overrides: Partial<Record<string, RoleChoice>> = {},
): { choice: RoleChoice; known: boolean; value: string } {
  const value = normalizeValue(raw)
  const direct = overrides[value] ?? defaultRoleValues[value]
  if (direct) return { choice: direct, known: true, value }
  // «arr, foredrag» eller «x/arr»: den viktigste rollen vinner.
  const parts = value
    .split(/\s*(?:[,/;+&]|\bog\b)\s*/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length > 1) {
    const choices = parts.map((p) => overrides[p] ?? defaultRoleValues[p])
    if (choices.every(Boolean)) {
      const roles = choices.filter((c) => c !== 'skip') as ('attended' | EventRole)[]
      if (!roles.length) return { choice: 'skip', known: true, value }
      const best = roles.reduce((a, b) =>
        rolePriority(normalizeRole(b)) > rolePriority(normalizeRole(a)) ? b : a,
      )
      return { choice: best, known: true, value }
    }
  }
  return { choice: overrides[value] ?? 'attended', known: false, value }
}

// ---------------------------------------------------------------------------
// Tolking
// ---------------------------------------------------------------------------

/** Kolonner med personer. */
const personAliases = {
  name: ['navn', 'fullt navn', 'name', 'full name', 'deltaker', 'deltakere', 'person'],
  firstName: ['fornavn', 'first name'],
  lastName: ['etternavn', 'last name', 'surname'],
  email: [
    ...defaultHeaders.email,
    ...defaultHeaders.secondaryEmail,
    'e-postadresse',
    'epostadresse',
  ],
  cohort: ['kull', 'es-kull', 'årskull', 'cohort', 'es'],
} as const

const participationAliases = {
  ...personAliases,
  event: ['arrangement', 'arrangementet', 'event', 'helg', 'esaf-helg', 'esaf-helgen', 'samling'],
  date: ['dato', 'date', 'startdato', 'år', 'year', 'tidspunkt'],
  role: ['rolle', 'role', 'funksjon', 'oppgave'],
  note: ['notat', 'note', 'kommentar', 'merknad'],
} as const

type ParticipationKey = keyof typeof participationAliases
type Columns = HeaderMap<ParticipationKey>

const columnLabels: Record<ParticipationKey, string> = {
  name: 'Navn',
  firstName: 'Fornavn',
  lastName: 'Etternavn',
  email: 'E-post',
  cohort: 'Kull',
  event: 'Arrangement',
  date: 'Dato',
  role: 'Rolle',
  note: 'Notat',
}

/** Overskrifter fra kullistene som ikke er arrangementer (telefon, LinkedIn …). */
const profileHeaders = new Set(Object.values(defaultHeaders).flat())

const readColumns = (header: string[]) =>
  mapHeader(header, participationAliases, ['email']) as Columns
const hasPerson = (c: Columns) => Boolean(c.name || c.email || c.firstName || c.lastName)

/** Et arrangement slik det står i arket. */
export type EventRef = {
  key: string
  label: string
  /** Hvor i arket: «kolonne D», «fanen «Høst 2018»». */
  source: string
  date: string | null
  year: number | null
  season: 'spring' | 'autumn' | null
  /** Antall deltakelser i arket. */
  count: number
}

/** En person slik arket beskriver dem. Flere rader kan være samme person. */
export type PersonRef = {
  key: string
  fullName: string
  emails: string[]
  year: number | null
  /** Radene personen står på, f.eks. «rad 4» eller «Høst 2018 rad 7». */
  lines: string[]
  /** Antall deltakelser i arket. */
  count: number
}

export type ImportEntry = {
  personKey: string
  eventKey: string
  role: EventRole | null
  note: string | null
  where: string
}

export type ImportIssue = { where: string; message: string }

export type ValueSummary = { value: string; count: number; choice: RoleChoice; known: boolean }

export type MatrixColumn = { index: number; letter: string; header: string; used: boolean }

export type ParticipationParseOptions = {
  layout?: ParticipationLayout
  /** Fanen for `matrix` og `long`. Standard er den første som passer. */
  sheet?: string
  /** Hva verdiene betyr, i tillegg til standardverdiene. */
  roleMap?: Partial<Record<string, RoleChoice>>
  /** Kolonnene (0-basert) som er arrangementer i `matrix`. Standard er de som ser ut som det. */
  eventColumns?: number[]
  fileName: string
}

export type ParsedParticipation = {
  layout: ParticipationLayout
  detected: ParticipationLayout
  /** Hvorfor oppsettet ble valgt, til forhåndsvisningen. */
  reason: string
  sheets: string[]
  /** Fanen som ble lest (`matrix`, `long`), ellers null. */
  sheet: string | null
  /** Hvilke kolonner som ble brukt til hva, f.eks. «Navn: Fullt navn». */
  columns: { label: string; header: string }[]
  /** Kolonnene i `matrix`, med om de regnes som arrangementer. */
  matrixColumns: MatrixColumn[]
  events: EventRef[]
  people: PersonRef[]
  entries: ImportEntry[]
  values: ValueSummary[]
  issues: ImportIssue[]
}

const MAX_ENTRIES = 20_000
const YEAR_IN = /(?<!\d)((?:19|20)\d{2})(?!\d)/

/** Årstall og semester fra en overskrift: «Høst 2018», «V19», «ESAF-helgen 2015», «2018-09-14». */
export function eventRefOf(label: string, source: string, dateCell?: string): EventRef {
  const date = parseDateCell(label) ?? (dateCell ? parseDateCell(dateCell) : null)
  const text = normalizeValue(`${label} ${dateCell && !date ? dateCell : ''}`)
  const short = text.match(/^(h|v)\s*'?(\d{2}|\d{4})$/)
  const yearText = short ? short[2]! : (text.match(YEAR_IN)?.[1] ?? null)
  const year = date
    ? Number(date.slice(0, 4))
    : yearText
      ? Number(yearText.length === 2 ? `20${yearText}` : yearText)
      : null
  const season = date
    ? Number(date.slice(5, 7)) <= 6
      ? 'spring'
      : 'autumn'
    : short
      ? short[1] === 'v'
        ? 'spring'
        : 'autumn'
      : /\b(var|vaar|spring)\b/.test(text)
        ? 'spring'
        : /\b(host|fall|autumn)\b/.test(text)
          ? 'autumn'
          : null
  return {
    key: `${normalizePersonName(label) || label.toLowerCase()}|${date ?? (dateCell ? normalizeValue(dateCell) : '')}`,
    label: dateCell && !date && !YEAR_IN.test(label) ? `${label} ${dateCell}` : label,
    source,
    date,
    year,
    season,
    count: 0,
  }
}

/** Personen på en rad: navn (eller fornavn og etternavn), e-post og kull. */
function personOfRow(
  row: string[],
  c: Columns,
): { clue: { name: string; emails: string[]; year: number | null }; badCohort: string | null } {
  const cell = (i: number | undefined) => (i === undefined ? '' : (row[i] ?? ''))
  const rawName =
    cell(c.name?.[0]) || [cell(c.firstName?.[0]), cell(c.lastName?.[0])].filter(Boolean).join(' ')
  // Navnecellen kan også ha e-post eller årstall i seg («Kari Nordmann <kari@x.no>»).
  const parsed = parseAttendeeLine(rawName)
  const emails = [
    ...new Set(
      [
        ...parsed.emails,
        ...(c.email ?? []).flatMap((i) =>
          cell(i)
            .split(/[\s,;]+/)
            .map((e) => e.replace(/^mailto:/i, ''))
            .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)),
        ),
      ].map(normalizeEmail),
    ),
  ]
  const rawCohort = cell(c.cohort?.[0])
  const year = rawCohort ? parseCohortCell(rawCohort) : parsed.year
  return {
    clue: { name: parsed.name, emails, year },
    badCohort: rawCohort && year === null ? rawCohort : null,
  }
}

/** Samler personene, så samme person på flere rader bare står én gang. */
function personCollector() {
  const refs = new Map<string, PersonRef>()
  const byEmail = new Map<string, PersonRef>()
  const byName = new Map<string, PersonRef>()
  return {
    add(clue: { name: string; emails: string[]; year: number | null }, line: string): PersonRef {
      const name = normalizePersonName(clue.name)
      const keys = clue.emails.map(emailKey)
      let ref =
        keys.map((k) => byEmail.get(k)).find(Boolean) ??
        (name ? byName.get(`${name}|${clue.year ?? ''}`) : undefined)
      if (!ref) {
        ref = {
          key: keys[0] ? `e:${keys[0]}` : `n:${name}|${clue.year ?? ''}`,
          fullName: clue.name,
          emails: [],
          year: clue.year,
          lines: [],
          count: 0,
        }
        refs.set(ref.key, ref)
      }
      for (const [i, e] of clue.emails.entries()) {
        if (!ref.emails.includes(e)) ref.emails.push(e)
        byEmail.set(keys[i]!, ref)
      }
      if (!ref.fullName && clue.name) ref.fullName = clue.name
      if (ref.year === null && clue.year !== null) ref.year = clue.year
      if (name) byName.set(`${name}|${clue.year ?? ''}`, ref)
      if (name && clue.year === null) byName.set(`${name}|`, ref)
      if (!ref.lines.includes(line)) ref.lines.push(line)
      return ref
    },
    list: () => [...new Set(refs.values())],
  }
}

/** Om en kolonne i et matriseark ser ut som et arrangement. */
function looksLikeEvent(
  header: string,
  cells: string[],
  overrides: ParticipationParseOptions['roleMap'],
) {
  const h = normalizeValue(header)
  if (!h || profileHeaders.has(h)) return false
  if (YEAR_IN.test(header) || parseDateCell(header) || /^(h|v)\s*'?\d{2}$/.test(h)) return true
  const filled = cells.filter(Boolean)
  if (!filled.length) return false
  const known = filled.filter((v) => roleOfValue(v, overrides).known).length
  return known / filled.length >= 0.6
}

type Context = {
  options: ParticipationParseOptions
  people: ReturnType<typeof personCollector>
  events: Map<string, EventRef>
  entries: ImportEntry[]
  values: Map<string, ValueSummary>
  issues: ImportIssue[]
}

function addEntry(
  ctx: Context,
  person: PersonRef,
  ref: EventRef,
  rawRole: string,
  note: string | null,
  where: string,
) {
  let role: EventRole | null = null
  if (rawRole) {
    const r = roleOfValue(rawRole, ctx.options.roleMap)
    const summary = ctx.values.get(r.value) ?? {
      value: r.value,
      count: 0,
      choice: r.choice,
      known: r.known,
    }
    summary.count++
    ctx.values.set(r.value, summary)
    if (r.choice === 'skip') return
    role = normalizeRole(r.choice)
  }
  if (ctx.entries.length >= MAX_ENTRIES) {
    throw new DomainError(`Arket har mer enn ${MAX_ENTRIES} deltakelser. Del det opp.`)
  }
  const event = ctx.events.get(ref.key) ?? ref
  ctx.events.set(ref.key, event)
  event.count++
  person.count++
  ctx.entries.push({ personKey: person.key, eventKey: event.key, role, note, where })
}

function readPersonRow(
  ctx: Context,
  grid: Grid,
  i: number,
  c: Columns,
  single: boolean,
): { person: PersonRef; where: string } | null {
  const row = grid.rows[i] ?? []
  const where = rowLabel(grid, i, single)
  const { clue, badCohort } = personOfRow(row, c)
  if (!clue.name && !clue.emails.length) {
    if (row.some(Boolean))
      ctx.issues.push({ where, message: 'mangler navn og e-post, hoppes over' })
    return null
  }
  if (badCohort) ctx.issues.push({ where, message: `forstår ikke kullet «${badCohort}»` })
  return { person: ctx.people.add(clue, where), where }
}

function parseMatrix(
  ctx: Context,
  grid: Grid,
): Pick<ParsedParticipation, 'columns' | 'matrixColumns'> {
  const h = findHeaderRow(grid, (r) => hasPerson(readColumns(r)))
  if (h === null)
    throw new DomainError(`Fant ingen kolonne for navn eller e-post i «${grid.name}».`)
  const header = grid.rows[h]!
  const c = readColumns(header)
  const personCols = new Set(
    (['name', 'firstName', 'lastName', 'email', 'cohort', 'note'] as const).flatMap(
      (k) => c[k] ?? [],
    ),
  )
  const body = grid.rows.slice(h + 1)
  const candidates = header.flatMap((title, index) =>
    title && !personCols.has(index) ? [{ index, title }] : [],
  )
  const chosen = ctx.options.eventColumns
    ? new Set(ctx.options.eventColumns)
    : new Set(
        candidates
          .filter(({ index, title }) =>
            looksLikeEvent(
              title,
              body.map((r) => r[index] ?? ''),
              ctx.options.roleMap,
            ),
          )
          .map((x) => x.index),
      )
  const matrixColumns = candidates.map(({ index, title }) => ({
    index,
    letter: columnLetter(index),
    header: title,
    used: chosen.has(index),
  }))
  const refs = new Map(
    matrixColumns
      .filter((m) => m.used)
      .map((m) => [m.index, eventRefOf(m.header, `kolonne ${m.letter}`)]),
  )
  if (!refs.size)
    throw new DomainError('Fant ingen kolonner som ser ut som arrangementer. Velg dem under.')
  for (let i = h + 1; i < grid.rows.length; i++) {
    const row = grid.rows[i]!
    if (![...refs.keys()].some((k) => row[k])) continue
    const found = readPersonRow(ctx, grid, i, c, true)
    if (!found) continue
    for (const [index, ref] of refs) {
      if (row[index]) addEntry(ctx, found.person, ref, row[index]!, null, found.where)
    }
  }
  return { columns: describeColumns(header, c), matrixColumns }
}

function parseLong(ctx: Context, grid: Grid): Pick<ParsedParticipation, 'columns'> {
  const h = findHeaderRow(grid, (r) => {
    const c = readColumns(r)
    return hasPerson(c) && Boolean(c.event)
  })
  if (h === null) {
    throw new DomainError(`Fant ikke kolonnene for person og arrangement i «${grid.name}».`)
  }
  const header = grid.rows[h]!
  const c = readColumns(header)
  for (let i = h + 1; i < grid.rows.length; i++) {
    const row = grid.rows[i]!
    if (!row.some(Boolean)) continue
    const label = row[c.event![0]!] ?? ''
    const where = rowLabel(grid, i, true)
    if (!label) {
      ctx.issues.push({ where, message: 'mangler arrangement, hoppes over' })
      continue
    }
    const found = readPersonRow(ctx, grid, i, c, true)
    if (!found) continue
    const dateCell = c.date ? (row[c.date[0]!] ?? '') : ''
    const ref = eventRefOf(label, `kolonnen «${header[c.event![0]!]}»`, dateCell || undefined)
    addEntry(
      ctx,
      found.person,
      ref,
      c.role ? (row[c.role[0]!] ?? '') : '',
      c.note ? row[c.note[0]!] || null : null,
      where,
    )
  }
  return { columns: describeColumns(header, c) }
}

function parseSheets(ctx: Context, grids: Grid[]): Pick<ParsedParticipation, 'columns'> {
  const single = grids.length === 1
  let columns: ParsedParticipation['columns'] = []
  for (const grid of grids) {
    const ref = eventRefOf(grid.name, single ? `fila` : `fanen «${grid.name}»`)
    const h = findHeaderRow(grid, (r) => hasPerson(readColumns(r)))
    if (h === null) {
      // Uten overskrifter: hver rad er en person, som i den innlimte lista.
      for (let i = 0; i < grid.rows.length; i++) {
        const text = grid.rows[i]!.filter(Boolean)
          .join(', ')
          .replace(/^\s*(?:[-*•·]|\d+[.)])\s+/, '')
        if (!text) continue
        const where = rowLabel(grid, i, single)
        const clue = parseAttendeeLine(text)
        if (!clue.name && !clue.emails.length) {
          ctx.issues.push({ where, message: 'mangler navn og e-post, hoppes over' })
          continue
        }
        addEntry(ctx, ctx.people.add(clue, where), ref, '', null, where)
      }
      continue
    }
    const header = grid.rows[h]!
    const c = readColumns(header)
    if (!columns.length) columns = describeColumns(header, c)
    for (let i = h + 1; i < grid.rows.length; i++) {
      const row = grid.rows[i]!
      if (!row.some(Boolean)) continue
      const found = readPersonRow(ctx, grid, i, c, single)
      if (!found) continue
      addEntry(
        ctx,
        found.person,
        ref,
        c.role ? (row[c.role[0]!] ?? '') : '',
        c.note ? row[c.note[0]!] || null : null,
        found.where,
      )
    }
  }
  return { columns }
}

function describeColumns(header: string[], c: Columns) {
  return (Object.keys(columnLabels) as ParticipationKey[]).flatMap((key) =>
    c[key]
      ? [
          {
            label: columnLabels[key],
            header: c[key].map((i) => header[i] || `kolonne ${columnLetter(i)}`).join(' + '),
          },
        ]
      : [],
  )
}

/** Gjetter oppsettet ut fra overskriftene og antall faner. */
export function detectParticipationLayout(
  grids: Grid[],
  roleMap?: ParticipationParseOptions['roleMap'],
): { layout: ParticipationLayout; sheet: string | null; reason: string } {
  for (const grid of grids) {
    const h = findHeaderRow(grid, (r) => hasPerson(readColumns(r)))
    if (h === null) continue
    const c = readColumns(grid.rows[h]!)
    if (c.event) {
      return {
        layout: 'long',
        sheet: grid.name,
        reason: `«${grid.name}» har en kolonne for arrangement, så hver rad er én deltakelse.`,
      }
    }
  }
  const first = grids[0]!
  const h = findHeaderRow(first, (r) => hasPerson(readColumns(r)))
  if (h !== null) {
    const header = first.rows[h]!
    const c = readColumns(header)
    const used = new Set(
      (['name', 'firstName', 'lastName', 'email', 'cohort', 'role', 'note'] as const).flatMap(
        (k) => c[k] ?? [],
      ),
    )
    const body = first.rows.slice(h + 1)
    const eventLike = header.filter(
      (title, i) =>
        title &&
        !used.has(i) &&
        looksLikeEvent(
          title,
          body.map((r) => r[i] ?? ''),
          roleMap,
        ),
    )
    if (eventLike.length && (grids.length === 1 || eventLike.length >= 2)) {
      return {
        layout: 'matrix',
        sheet: first.name,
        reason: `«${first.name}» har én rad per person og ${eventLike.length === 1 ? 'én kolonne' : `${eventLike.length} kolonner`} som ser ut som arrangementer.`,
      }
    }
  }
  return grids.length > 1
    ? {
        layout: 'sheets',
        sheet: null,
        reason: `Fila har ${grids.length} faner, så hver fane regnes som ett arrangement.`,
      }
    : {
        layout: 'sheets',
        sheet: null,
        reason: 'Fila er én liste med personer, så den regnes som ett arrangement.',
      }
}

/** Tolker arket. Ren funksjon: ingen database. */
export function parseParticipation(
  grids: Grid[],
  options: ParticipationParseOptions,
): ParsedParticipation {
  if (!grids.length) throw new DomainError('Fant ingen rader i regnearket.')
  const detected = detectParticipationLayout(grids, options.roleMap)
  const layout = options.layout ?? detected.layout
  const sheetName =
    options.sheet && grids.some((g) => g.name === options.sheet)
      ? options.sheet
      : layout === detected.layout
        ? detected.sheet
        : null
  const ctx: Context = {
    options,
    people: personCollector(),
    events: new Map(),
    entries: [],
    values: new Map(),
    issues: [],
  }
  let shape: Pick<ParsedParticipation, 'columns'> &
    Partial<Pick<ParsedParticipation, 'matrixColumns'>>
  let sheet: string | null = null
  if (layout === 'sheets') {
    shape = parseSheets(ctx, grids)
  } else {
    const grid = grids.find((g) => g.name === sheetName) ?? grids[0]!
    sheet = grid.name
    shape = layout === 'matrix' ? parseMatrix(ctx, grid) : parseLong(ctx, grid)
  }
  const people = ctx.people.list().filter((p) => p.count > 0)
  return {
    layout,
    detected: detected.layout,
    reason: detected.reason,
    sheets: grids.map((g) => g.name),
    sheet,
    columns: shape.columns,
    matrixColumns: shape.matrixColumns ?? [],
    events: [...ctx.events.values()],
    people,
    entries: ctx.entries,
    values: [...ctx.values.values()].sort((a, b) => b.count - a.count),
    issues: ctx.issues,
  }
}

// ---------------------------------------------------------------------------
// Forhåndsvisning: personer og arrangementer matches mot databasen
// ---------------------------------------------------------------------------

type DbEvent = {
  id: string
  name: string
  startDate: string
  endDate: string | null
  datePrecision?: EventDatePrecision
  typeId: string
  typeName: string
}

export type EventCandidate = {
  id: string
  name: string
  startDate: string
  endDate: string | null
  datePrecision: EventDatePrecision
  typeName: string
  upcoming: boolean
}

export type ImportEventPreview = EventRef & {
  status: 'matched' | 'ambiguous' | 'missing'
  by: 'name' | 'date' | 'year' | null
  candidates: EventCandidate[]
  /**
   * Forslag til et nytt arrangement når det mangler. Med bare år eller semester
   * i overskriften får det den presisjonen («Høst 2018», «2015»), ikke en gjettet dato.
   */
  suggestion: {
    name: string
    startDate: string
    endDate: string | null
    datePrecision: EventDatePrecision
  }
}

export type ImportPersonPreview = PersonRef &
  PersonMatch & {
    /** Nøkkelen til en annen person i arket som matcher samme person. */
    sameAs: string | null
  }

export type ParticipationPreview = Omit<ParsedParticipation, 'people' | 'events' | 'entries'> & {
  fileName: string
  types: EventTypeInfo[]
  /** Typen arrangementer matches mot og lages som. */
  typeId: string
  events: ImportEventPreview[]
  people: ImportPersonPreview[]
  entries: number
}

/** Matcher et arrangement fra arket mot dem som finnes: navn, dato, så år (og semester). */
export function matchEventRef(
  ref: EventRef,
  events: DbEvent[],
  type: { id: string; name: string },
  today = osloToday(),
): Omit<ImportEventPreview, keyof EventRef> {
  const label = normalizePersonName(ref.label)
  const ofType = events.filter((e) => e.typeId === type.id)
  const toCandidate = (e: DbEvent): EventCandidate => ({
    id: e.id,
    name: e.name,
    startDate: e.startDate,
    endDate: e.endDate,
    datePrecision: e.datePrecision ?? 'day',
    typeName: e.typeName,
    upcoming: e.startDate > today,
  })
  const result = (by: 'name' | 'date' | 'year', list: DbEvent[]) => ({
    status: list.length === 1 ? ('matched' as const) : ('ambiguous' as const),
    by,
    candidates: list.map(toCandidate),
  })
  const byName = events.filter((e) => normalizePersonName(e.name) === label)
  let found: Omit<ImportEventPreview, keyof EventRef | 'suggestion'> | null = null
  if (byName.length) found = result('name', byName)
  else if (ref.date) {
    const hits = ofType.filter(
      (e) => e.startDate <= ref.date! && ref.date! <= (e.endDate ?? e.startDate),
    )
    if (hits.length) found = result('date', hits)
  }
  if (!found && ref.year !== null) {
    const hits = ofType.filter((e) => {
      if (Number(e.startDate.slice(0, 4)) !== ref.year) return false
      // Et arrangement med bare årstall passer begge semestrene det året.
      if (!ref.season || e.datePrecision === 'year') return true
      const month = Number(e.startDate.slice(5, 7))
      return ref.season === 'spring' ? month <= 6 : month >= 7
    })
    if (hits.length) found = result('year', hits)
  }
  // Bare årstall og semester i overskriften: navnet lages fra typen.
  const bare = !normalizeValue(ref.label)
    .replace(YEAR_IN, ' ')
    .replace(/\b(var|vaar|spring|host|fall|autumn|h|v)\b/g, ' ')
    .replace(/[^a-z]/g, '')
  const name =
    bare && ref.year !== null
      ? periodEventName(type.name, ref.year, ref.season ?? 'year')
      : ref.label
  const suggestion = ref.date
    ? { startDate: ref.date, datePrecision: 'day' as const }
    : ref.year !== null
      ? {
          startDate: periodStart(ref.year, ref.season ?? 'year'),
          datePrecision: ref.season ? ('semester' as const) : ('year' as const),
        }
      : { startDate: '', datePrecision: 'day' as const }
  return {
    ...(found ?? { status: 'missing' as const, by: null, candidates: [] }),
    suggestion: { name: name.slice(0, 120), endDate: null, ...suggestion },
  }
}

async function loadEvents(db: Db | Tx): Promise<DbEvent[]> {
  return db
    .select({
      id: event.id,
      name: event.name,
      startDate: event.startDate,
      endDate: event.endDate,
      datePrecision: event.datePrecision,
      typeId: event.typeId,
      typeName: eventType.name,
    })
    .from(event)
    .innerJoin(eventType, eq(eventType.id, event.typeId))
    .orderBy(asc(event.startDate))
}

async function loadTypes(db: Db | Tx): Promise<EventTypeInfo[]> {
  return db
    .select({
      id: eventType.id,
      slug: eventType.slug,
      name: eventType.name,
      plural: eventType.plural,
      description: eventType.description,
      sortOrder: eventType.sortOrder,
    })
    .from(eventType)
    .orderBy(asc(eventType.sortOrder), asc(eventType.name))
}

/** Matcher personene i arket. Flere i arket som peker på samme person, merkes. */
export function matchPeopleRefs(refs: PersonRef[], people: MatchPerson[]): ImportPersonPreview[] {
  const match = personMatcher(people)
  const firstFor = new Map<string, string>()
  return refs.map((ref) => {
    const m = match({ name: ref.fullName, emails: ref.emails, year: ref.year })
    let sameAs: string | null = null
    if (m.status === 'matched') {
      const id = m.candidates[0]!.personId
      sameAs = firstFor.get(id) ?? null
      if (!sameAs) firstFor.set(id, ref.key)
    }
    return { ...ref, ...m, sameAs }
  })
}

export type ParticipationImportInput = {
  data: Uint8Array
  fileName: string
  options: Omit<ParticipationParseOptions, 'fileName'> & { typeId?: string | null }
}

async function prepare(db: Db | Tx, input: ParticipationImportInput) {
  const grids = await readSpreadsheet(input.data, input.fileName)
  const parsed = parseParticipation(grids, { ...input.options, fileName: input.fileName })
  // Etter hverandre: `db` kan være en transaksjon.
  const types = await loadTypes(db)
  const events = await loadEvents(db)
  const people = await loadMatchPeople(db)
  const type =
    types.find((t) => t.id === input.options.typeId) ??
    types.find((t) => t.slug === ESAF_WEEKEND_SLUG) ??
    types[0]
  if (!type) throw new DomainError('Lag en arrangementstype først.')
  const today = osloToday()
  return {
    parsed,
    types,
    type,
    events: parsed.events.map((ref) => ({ ...ref, ...matchEventRef(ref, events, type, today) })),
    people: matchPeopleRefs(parsed.people, people),
  }
}

/** Leser arket og matcher det mot databasen, til forhåndsvisningen. Lagrer ingenting. */
export async function previewParticipationImport(
  db: Db,
  viewer: Viewer,
  input: ParticipationImportInput,
): Promise<ParticipationPreview> {
  assertCan(viewer, 'profiles.edit')
  const { parsed, types, type, events, people } = await prepare(db, input)
  const { entries, ...rest } = parsed
  return {
    ...rest,
    fileName: input.fileName,
    types,
    typeId: type.id,
    events,
    people,
    entries: entries.length,
  }
}

// ---------------------------------------------------------------------------
// Lagring
// ---------------------------------------------------------------------------

const personDecision = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('existing'), personId: z.uuid() }),
  z.object({
    kind: z.literal('create'),
    fullName: z.string().max(200),
    emails: z.array(z.string().max(200)).max(10),
    graduationYear: z.number().int().nullable(),
    status: z.enum(['active', 'pending']),
  }),
  z.object({ kind: z.literal('skip') }),
])

const eventDecision = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('existing'), eventId: z.uuid() }),
  z.object({
    kind: z.literal('create'),
    typeId: z.uuid(),
    name: z.string().max(500),
    startDate: z.string().max(20),
    endDate: z.string().max(20).nullable(),
    datePrecision: z.enum(eventDatePrecisions).optional(),
    location: z.string().max(500),
  }),
  z.object({ kind: z.literal('skip') }),
])

export const participationDecisions = z.object({
  people: z.record(z.string().max(500), personDecision),
  events: z.record(z.string().max(1000), eventDecision),
})

export type PersonDecision = z.infer<typeof personDecision>
export type EventDecision = z.infer<typeof eventDecision>
export type ParticipationDecisions = z.infer<typeof participationDecisions>

/** Det som blir gjort, eller ble gjort, per arrangement og til sammen. */
export type ParticipationChange = {
  personId: string | null
  fullName: string
  eventName: string
  kind: 'add' | 'update'
  from: EventRole | null
  to: EventRole | null
  /** Notatet fylles inn. */
  note: boolean
}

export type ParticipationPlan = {
  saved: boolean
  totals: {
    added: number
    updated: number
    unchanged: number
    /** Deltakelser som hoppes over fordi personen eller arrangementet hoppes over. */
    skipped: number
    profilesCreated: number
    eventsCreated: number
  }
  events: {
    key: string
    name: string
    eventId: string | null
    created: boolean
    added: number
    updated: number
    unchanged: number
  }[]
  /** Nye deltakelser og endrede roller, høyst 1000. */
  changes: ParticipationChange[]
  /** Samme person flere ganger på samme arrangement med ulik rolle. */
  notes: ImportIssue[]
}

/** Kastes for å rulle tilbake en prøvekjøring, med planen. */
class DryRun extends Error {
  constructor(readonly plan: unknown) {
    super('dry run')
  }
}

/** Hva som er valgt for en person: admins valg, ellers et sikkert treff, ellers ingenting. */
export function defaultPersonDecision(p: ImportPersonPreview): PersonDecision {
  return p.status === 'matched'
    ? { kind: 'existing', personId: p.candidates[0]!.personId }
    : { kind: 'skip' }
}

export function defaultEventDecision(e: ImportEventPreview): EventDecision {
  return e.status === 'matched'
    ? { kind: 'existing', eventId: e.candidates[0]!.id }
    : { kind: 'skip' }
}

/**
 * Lagrer importen i én transaksjon, eller (med `dryRun`) viser nøyaktig hva som
 * ville blitt lagret uten å lagre noe. Personer og arrangementer uten valg får
 * standardvalget fra forhåndsvisningen: sikre treff brukes, resten hoppes over.
 * Logges som `event.import`, og nye profiler og arrangementer som
 * `profile.create` og `event.create`.
 */
export async function applyParticipationImport(
  db: Db,
  viewer: Viewer,
  input: ParticipationImportInput & { decisions: ParticipationDecisions; dryRun: boolean },
): Promise<ParticipationPlan> {
  assertCan(viewer, 'profiles.edit')
  const decisions = participationDecisions.safeParse(input.decisions)
  if (!decisions.success) throw new DomainError('Ugyldige valg i forhåndsvisningen.')
  try {
    const plan = await db.transaction(async (tx) => {
      const { parsed, events, people } = await prepare(tx, input)
      const today = osloToday()

      // Arrangementene: valgt, laget nå, eller hoppet over.
      const eventIds = new Map<string, { id: string; name: string; created: boolean }>()
      let eventsCreated = 0
      const existingIds = new Set<string>()
      for (const e of events) {
        const choice = decisions.data.events[e.key] ?? defaultEventDecision(e)
        if (choice.kind === 'existing') existingIds.add(choice.eventId)
      }
      const existing = existingIds.size
        ? await tx
            .select({ id: event.id, name: event.name, startDate: event.startDate })
            .from(event)
            .where(inArray(event.id, [...existingIds]))
            .for('update')
        : []
      const byId = new Map(existing.map((e) => [e.id, e]))
      for (const e of events) {
        const choice = decisions.data.events[e.key] ?? defaultEventDecision(e)
        if (choice.kind === 'skip') continue
        if (choice.kind === 'existing') {
          const found = byId.get(choice.eventId)
          if (!found) throw new DomainError(`Fant ikke arrangementet valgt for «${e.label}».`)
          if (found.startDate > today) {
            throw new DomainError(
              `${found.name} har ikke startet ennå. Deltakelse registreres når det har startet.`,
            )
          }
          eventIds.set(e.key, { id: found.id, name: found.name, created: false })
          continue
        }
        let values
        try {
          values = parseEventInput({ ...choice, description: '' })
        } catch (error) {
          throw new DomainError(
            `Nytt arrangement for «${e.label}»: ${error instanceof Error ? error.message : 'ugyldige felt.'}`,
          )
        }
        if (values.startDate > today) {
          throw new DomainError(`«${values.name}» har ikke startet ennå, så ingen kan ha vært der.`)
        }
        const created = await insertEvent(tx, viewer, values, { via: 'import' })
        eventIds.set(e.key, { id: created.id, name: values.name, created: true })
        eventsCreated++
      }

      // Personene: valgt, laget nå, eller hoppet over.
      const personIds = new Map<string, { id: string; fullName: string }>()
      const createdPersonIds: string[] = []
      let profilesCreated = 0
      const chosenIds = new Set<string>()
      for (const p of people) {
        const choice = decisions.data.people[p.key] ?? defaultPersonDecision(p)
        if (choice.kind === 'existing') chosenIds.add(choice.personId)
      }
      const known = chosenIds.size
        ? await tx
            .select({ id: person.id, fullName: person.fullName })
            .from(person)
            .where(inArray(person.id, [...chosenIds]))
        : []
      const names = new Map(known.map((p) => [p.id, p.fullName]))
      for (const p of people) {
        const choice = decisions.data.people[p.key] ?? defaultPersonDecision(p)
        if (choice.kind === 'skip') continue
        if (choice.kind === 'existing') {
          const fullName = names.get(choice.personId)
          if (!fullName)
            throw new DomainError(`Fant ikke personen valgt for «${p.fullName || p.emails[0]}».`)
          personIds.set(p.key, { id: choice.personId, fullName })
          continue
        }
        const { personId } = await insertProfile(
          tx,
          viewer,
          {
            fullName: choice.fullName,
            emails: choice.emails,
            cohorts:
              choice.graduationYear === null
                ? []
                : [{ graduationYear: choice.graduationYear, relation: 'student' }],
            status: choice.status,
          },
          { via: 'event.import' },
        ).catch((error: unknown) => {
          throw new DomainError(
            `Ny profil for «${choice.fullName}»: ${error instanceof Error ? error.message : 'ugyldige felt.'}`,
          )
        })
        personIds.set(p.key, { id: personId, fullName: choice.fullName.trim() })
        createdPersonIds.push(personId)
        profilesCreated++
      }

      // Hver deltakelse én gang. Står samme person flere ganger, vinner den viktigste rollen.
      const notes: ImportIssue[] = []
      const pairs = new Map<
        string,
        {
          eventKey: string
          personKey: string
          eventId: string
          personId: string
          role: EventRole | null
          note: string | null
          where: string
        }
      >()
      let skipped = 0
      for (const entry of parsed.entries) {
        const e = eventIds.get(entry.eventKey)
        const p = personIds.get(entry.personKey)
        if (!e || !p) {
          skipped++
          continue
        }
        const key = `${e.id}|${p.id}`
        const before = pairs.get(key)
        if (!before) {
          pairs.set(key, { ...entry, eventId: e.id, personId: p.id })
          continue
        }
        if (before.role !== entry.role && before.role && entry.role) {
          notes.push({
            where: entry.where,
            message: `${p.fullName} står flere ganger på ${e.name} med ulik rolle; den viktigste brukes`,
          })
        }
        if (rolePriority(entry.role) > rolePriority(before.role)) before.role = entry.role
        before.note ??= entry.note
      }

      const ids = [...new Set([...eventIds.values()].map((e) => e.id))]
      const current = ids.length
        ? await tx
            .select({
              eventId: eventParticipation.eventId,
              personId: eventParticipation.personId,
              role: eventParticipation.role,
              note: eventParticipation.note,
            })
            .from(eventParticipation)
            .where(inArray(eventParticipation.eventId, ids))
        : []
      const have = new Map(current.map((c) => [`${c.eventId}|${c.personId}`, c]))

      const perEvent = new Map<string, ParticipationPlan['events'][number]>()
      for (const [key, e] of eventIds) {
        if (!perEvent.has(e.id)) {
          perEvent.set(e.id, {
            key,
            name: e.name,
            eventId: e.id,
            created: e.created,
            added: 0,
            updated: 0,
            unchanged: 0,
          })
        }
      }
      const changes: ParticipationChange[] = []
      const inserts: (typeof eventParticipation.$inferInsert)[] = []
      let unchanged = 0
      for (const pair of pairs.values()) {
        const stats = perEvent.get(pair.eventId)!
        const fullName = personIds.get(pair.personKey)!.fullName
        const existingRow = have.get(`${pair.eventId}|${pair.personId}`)
        if (!existingRow) {
          inserts.push({
            eventId: pair.eventId,
            personId: pair.personId,
            role: pair.role,
            note: pair.note,
            source: 'import',
          })
          stats.added++
          changes.push({
            personId: pair.personId,
            fullName,
            eventName: stats.name,
            kind: 'add',
            from: null,
            to: pair.role,
            note: false,
          })
          continue
        }
        const from = normalizeRole(existingRow.role)
        // En deltakelse uten rolle tar aldri bort en rolle som er satt.
        const role = pair.role && pair.role !== from ? pair.role : null
        const note = pair.note && !existingRow.note ? pair.note : null
        if (!role && !note) {
          stats.unchanged++
          unchanged++
          continue
        }
        await tx
          .update(eventParticipation)
          .set({ ...(role ? { role } : {}), ...(note ? { note } : {}) })
          .where(
            and(
              eq(eventParticipation.eventId, pair.eventId),
              eq(eventParticipation.personId, pair.personId),
            ),
          )
        stats.updated++
        changes.push({
          personId: pair.personId,
          fullName,
          eventName: stats.name,
          kind: 'update',
          from,
          to: role ?? from,
          note: Boolean(note),
        })
      }
      for (let i = 0; i < inserts.length; i += 1000) {
        await tx.insert(eventParticipation).values(inserts.slice(i, i + 1000))
      }

      const added = inserts.length
      const updated = changes.length - added
      // En prøvekjøring rulles tilbake, så nye profiler og arrangementer får ingen id.
      const createdPeople = new Set(createdPersonIds)
      const result: ParticipationPlan = {
        saved: !input.dryRun,
        totals: { added, updated, unchanged, skipped, profilesCreated, eventsCreated },
        events: [...perEvent.values()].map((e) =>
          input.dryRun && e.created ? { ...e, eventId: null } : e,
        ),
        changes: changes
          .map((c) =>
            input.dryRun && c.personId && createdPeople.has(c.personId)
              ? { ...c, personId: null }
              : c,
          )
          .sort(
            (a, b) =>
              a.eventName.localeCompare(b.eventName, 'nb') ||
              a.fullName.localeCompare(b.fullName, 'nb'),
          )
          .slice(0, 1000),
        notes,
      }
      if (added || updated || profilesCreated || eventsCreated) {
        await tx.insert(auditEvent).values({
          actorPersonId: viewer.personId,
          action: 'event.import',
          details: {
            fileName: input.fileName.slice(0, 200),
            layout: parsed.layout,
            added,
            updated,
            unchanged,
            profilesCreated,
            eventsCreated,
            events: result.events
              .filter((e) => e.added || e.updated)
              .slice(0, 200)
              .map((e) => ({
                eventId: e.eventId,
                name: e.name,
                added: e.added,
                updated: e.updated,
              })),
          },
        })
      }
      if (input.dryRun) throw new DryRun(result)
      return result
    })
    return plan
  } catch (error) {
    if (error instanceof DryRun) return error.plan as ParticipationPlan
    throw error
  }
}
