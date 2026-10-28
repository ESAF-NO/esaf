import { schema, type Db } from '@esaf/db'
import { parse } from 'csv-parse/sync'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import ExcelJS from 'exceljs'
import { deleteOrphanCompanies, isCompanyName, resolveCompanies } from './companies.ts'
import { normalizeEmail } from './members.ts'
import { normalizeLinkedinUrl } from './profiles.ts'
import { tidyTag } from './validation.ts'

const { auditEvent, cohort, experience, membership, person, personCohort, personEmail } = schema

/**
 * Import av profiler fra kullister: CSV, eller en Excel-fil med én fane per kull
 * («ES 2024», «ES 2005-2009» …). Tolkingen er ren og testbar;
 * `planProfileImport` og `applyProfileImport` snakker med databasen. Importen er
 * idempotent: kjøres den på nytt, kjennes personer igjen på e-post, eller på
 * navn og kull.
 */

/** Tekstfelt på personen som kan fylles fra arket. */
export type ProfileFieldKey = 'city' | 'esCompany' | 'linkedinUrl' | 'studyBackground'
export type ColumnKey =
  | 'name'
  | 'firstName'
  | 'lastName'
  | 'email'
  | 'secondaryEmail'
  | 'cohort'
  | 'phone'
  | 'expertise'
  | 'industries'
  | 'currentCompany'
  | 'jobTitle'
  | ProfileFieldKey

/**
 * Overskrifter som kjennes igjen automatisk, etter normalisering (små bokstaver,
 * uten parentes og kolon). Selskap, stilling og ES-selskap har ingen standard,
 * fordi «Selskap» like gjerne kan bety ES-selskapet; de må oppgis eksplisitt.
 * Facebook og adresse er bevisst ikke med.
 */
const defaultHeaders: Record<ColumnKey, string[]> = {
  name: ['navn', 'fullt navn', 'name', 'full name'],
  firstName: ['fornavn', 'first name'],
  lastName: ['etternavn', 'last name', 'surname'],
  email: [
    'e-post',
    'epost',
    'email',
    'e-mail',
    'e-mail address',
    'mail',
    'primær e-post',
    'gmail-adresse',
  ],
  secondaryEmail: ['ntnu-mail', 'google docs-kompatibel epost'],
  cohort: ['kull', 'es-kull', 'opptaksår', 'årskull', 'cohort'],
  phone: [
    'telefon',
    'telefonnummer',
    'tlf',
    'mobil',
    'mobilnr',
    'mobilnummer',
    'mobile phone',
    'phone',
    'mobile',
  ],
  city: ['by', 'bosted', 'city'],
  linkedinUrl: ['linkedin', 'linkedin-profil', 'linkedin url'],
  studyBackground: [
    'studieretning',
    'studieretning før es',
    'studiebakgrunn',
    'tidligere studieretning',
    'profession',
  ],
  expertise: ['spør meg gjerne om', 'kompetanseområder'],
  industries: ['bransjer', 'bransje', 'industries', 'industry'],
  currentCompany: [],
  jobTitle: [],
  esCompany: [],
}

const columnKeys = Object.keys(defaultHeaders) as ColumnKey[]
const profileFieldKeys: ProfileFieldKey[] = ['city', 'esCompany', 'linkedinUrl', 'studyBackground']
const multiColumn: ColumnKey[] = ['email', 'secondaryEmail', 'expertise', 'industries']

/** Hva årstallet i arket betyr. ES navngir kull etter uteksamineringsåret. */
export type YearKind = 'start' | 'graduation'

/** Entreprenørskolen er et toårig masterprogram: uteksaminert år = opptaksår + 2. */
const PROGRAM_YEARS = 2
const MAX_TAGS = 10
const MAX_TAG = 40

export type ProfileRow = {
  /** Fanen raden kom fra (Excel). */
  sheet?: string
  line: number
  fullName: string
  /** Alle gyldige adresser, primæradressen først. */
  emails: string[]
  /** Kullene personen hører til, som uteksamineringsår. Tom når arket ikke sier det. */
  years: number[]
  /** Normalisert, f.eks. «+47 412 34 567». Vises ikke før personen selv slår det på. */
  phone: string | null
  fields: Partial<Record<ProfileFieldKey, string>>
  expertise: string[]
  industries: string[]
  /** Nåværende stilling fra arket. Lagres som erfaring. */
  role: { company: string; title: string | null } | null
}

export type SheetIssue = { sheet?: string; line: number; message: string }

export type SheetSummary = {
  name: string
  rows: number
  columns: Partial<Record<ColumnKey, string>>
  ignoredHeaders: string[]
  /** Kolonner som er tolket ut fra innholdet fordi overskriften manglet eller var feil. */
  inferred: string[]
}

export type ParsedSheet = {
  rows: ProfileRow[]
  /** Rader som er hoppet over. */
  errors: SheetIssue[]
  /** Rader som importeres, men med noe å se på. */
  warnings: SheetIssue[]
  sheets: SheetSummary[]
  /** Faner i Excel-filen som ikke er kullfaner. */
  skippedSheets: string[]
}

type Cell = { text: string; link?: string }

const normalizeHeader = (h: string) =>
  h
    .toLowerCase()
    .replace(/\([^)]*\)?/g, ' ')
    .replace(/[:*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
export const normalizeName = (n: string) => n.trim().replace(/\s+/g, ' ')
const nameKey = (n: string) => normalizeName(n).toLocaleLowerCase('nb')
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/

/**
 * Rydder telefonnumre slik folk har skrevet dem i kullistene: «412 34 567»,
 * «+47 412 34 567», «0047 41234567», «M: +4741234567», «4917612345678», og
 * bruker det første når det står flere («41234567 / 98765432»). Norske nummer
 * får formen «+47 412 34 567». Gir `null` når det ikke ser ut som et telefonnummer.
 */
export function normalizePhone(raw: string): string | null {
  const first = raw.split(/[\n/,;(]|\beller\b/)[0] ?? ''
  let digits = first.replace(/^[^\d+]*/, '').replace(/[^\d+]/g, '')
  if (digits.startsWith('00')) digits = `+${digits.slice(2)}`
  if (digits.lastIndexOf('+') > 0) return null
  const norwegian = digits.match(/^(?:\+?47)?(\d{8})$/)?.[1]
  if (norwegian) {
    return `+47 ${norwegian.slice(0, 3)} ${norwegian.slice(3, 5)} ${norwegian.slice(5)}`
  }
  // Ti eller flere sifre uten 0 først er et utenlandsk nummer der bare + mangler.
  if (/^[1-9]\d{9,14}$/.test(digits)) return `+${digits}`
  return /^\+\d{7,15}$/.test(digits) ? digits : null
}

/** Ett eller to årstall i en kullcelle: «2006», «Kull 2016», «2005/2006». */
function parseYears(raw: string): number[] {
  const pair = raw.match(
    /^\s*(?:es\s*)?((?:19|20)\d{2})\s*[/,&-]\s*(?:es\s*)?((?:19|20)\d{2})\s*$/i,
  )
  if (pair) return [...new Set([Number(pair[1]), Number(pair[2])])]
  const single = raw.match(/\b(19|20)\d{2}\b/)
  return single ? [Number(single[0])] : []
}

/** Stikkord fra én eller flere celler, skilt med komma, semikolon, linjeskift eller « / ». */
function splitTags(cells: Cell[]) {
  const tags: string[] = []
  let dropped = 0
  for (const cell of cells) {
    for (const raw of cell.text
      .split(/[,;\n]+|\s\/\s/)
      .map(normalizeName)
      .filter(Boolean)) {
      const tag = tidyTag(raw)
      if (tag.length > MAX_TAG) dropped++
      else if (!tags.some((t) => t.toLocaleLowerCase('nb') === tag.toLocaleLowerCase('nb'))) {
        tags.push(tag)
      }
    }
  }
  if (tags.length > MAX_TAGS) dropped += tags.length - MAX_TAGS
  return { tags: tags.slice(0, MAX_TAGS), dropped }
}

type Seen = { emails: Map<string, ProfileRow>; nameYears: Map<string, string> }
const where = (sheet: string | undefined, line: number) =>
  sheet ? `${sheet} rad ${line}` : `linje ${line}`

/** Finner hvilke kolonner som betyr hva, med eksplisitte overstyringer først. */
function resolveColumns(header: string[], overrides: Partial<Record<ColumnKey, string>>) {
  const normalized = header.map(normalizeHeader)
  const index: Partial<Record<ColumnKey, number[]>> = {}
  const taken = new Set<number>()
  for (const key of columnKeys) {
    const wanted = overrides[key]
    const candidates = wanted ? [normalizeHeader(wanted)] : defaultHeaders[key]
    const found = normalized.flatMap((h, i) => (candidates.includes(h) && !taken.has(i) ? [i] : []))
    if (wanted && !found.length) {
      throw new Error(
        `Fant ikke kolonnen «${wanted}». Kolonner: ${header.filter(Boolean).join(', ')}`,
      )
    }
    // Navn, kull og telefon bruker første treff; e-post og stikkord kan ha flere kolonner.
    const use = multiColumn.includes(key) ? found : found.slice(0, 1)
    if (use.length) {
      index[key] = use
      use.forEach((i) => taken.add(i))
    }
  }

  // Rotete overskrifter i kullister: første kolonne mangler overskrift eller har
  // fått et navn skrevet inn. Tolk den ut fra nabokolonnene.
  const inferred: string[] = []
  if (!index.name && !taken.has(0)) {
    // Overskriftsteksten vises ikke: i kullistene er den ofte et navn noen har skrevet inn.
    const label = 'kolonne 1 (mangler gyldig overskrift)'
    if (index.lastName && !index.firstName) {
      index.firstName = [0]
      inferred.push(`${label} tolket som fornavn`)
    } else if (index.firstName && !index.lastName) {
      index.lastName = [0]
      inferred.push(`${label} tolket som etternavn`)
    } else if (!index.firstName && !index.lastName) {
      index.name = [0]
      inferred.push(`${label} tolket som navn`)
    }
    if (inferred.length) taken.add(0)
  }

  const columns: Partial<Record<ColumnKey, string>> = {}
  for (const key of columnKeys) {
    const cols = index[key]
    if (cols) {
      columns[key] = cols
        .map((i) => (i === 0 && inferred.length ? 'kolonne 1' : header[i] || `kolonne ${i + 1}`))
        .join(' + ')
    }
  }
  const ignoredHeaders = header.filter((h, i) => h.trim() && !taken.has(i))
  return { index, columns, ignoredHeaders, inferred }
}

function parseTable(
  header: string[],
  records: Cell[][],
  ctx: {
    sheet?: string
    /** Årstallet fra fanenavnet, i arkets egen betydning (se `yearKind`). */
    defaultYear: number | null
    yearKind: YearKind
    overrides: Partial<Record<ColumnKey, string>>
    seen: Seen
    errors: SheetIssue[]
    warnings: SheetIssue[]
  },
): { rows: ProfileRow[]; summary: SheetSummary } {
  const { index, columns, ignoredHeaders, inferred } = resolveColumns(header, ctx.overrides)
  const hasName = index.name || index.firstName || index.lastName
  if (!hasName || (ctx.defaultYear === null && !index.cohort)) {
    throw new Error(
      `${ctx.sheet ? `Fanen «${ctx.sheet}»: ` : ''}trenger kolonne for navn (eller fornavn og etternavn)` +
        `${ctx.defaultYear === null ? ' og kull' : ''}. Kolonner: ${header.filter(Boolean).join(', ')}. ` +
        'Oppgi dem med --kolonne navn="…" --kolonne kull="…".',
    )
  }

  const cells = (r: Cell[], key: ColumnKey) => (index[key] ?? []).map((i) => r[i] ?? { text: '' })
  const text = (r: Cell[], key: ColumnKey) => normalizeName(cells(r, key)[0]?.text ?? '')
  const toGraduation = (y: number) => (ctx.yearKind === 'start' ? y + PROGRAM_YEARS : y)
  const rows: ProfileRow[] = []
  const issue = (list: SheetIssue[], line: number, message: string) =>
    list.push({ sheet: ctx.sheet, line, message })

  records.forEach((record, i) => {
    const line = i + 2 // 1-basert, etter overskriftsraden
    if (record.every((c) => !c.text.trim())) return
    const fullName = normalizeName(
      text(record, 'name') || `${text(record, 'firstName')} ${text(record, 'lastName')}`,
    )
    if (!fullName) return issue(ctx.errors, line, 'mangler navn')

    let sheetYears = ctx.defaultYear === null ? [] : [ctx.defaultYear]
    if (index.cohort) {
      const raw = text(record, 'cohort')
      const found = parseYears(raw)
      if (found.length) sheetYears = found
      else if (raw) return issue(ctx.errors, line, `${fullName}: forstår ikke kull «${raw}»`)
    }
    const years = sheetYears.map(toGraduation).sort()

    const emails: string[] = []
    const invalid: string[] = []
    for (const cell of [...cells(record, 'email'), ...cells(record, 'secondaryEmail')]) {
      for (const part of cell.text.split(/[\s,;]+/).filter(Boolean)) {
        const candidate = part.replace(/^mailto:/i, '')
        if (EMAIL.test(candidate)) {
          const email = normalizeEmail(candidate)
          if (!emails.includes(email)) emails.push(email)
        } else {
          invalid.push(part)
        }
      }
    }
    if (invalid.length)
      issue(ctx.warnings, line, `${fullName}: ignorerer ugyldig e-post «${invalid.join(' ')}»`)

    // Samme e-post to steder: samme navn betyr samme person i flere kull.
    const twin = emails.map((e) => ctx.seen.emails.get(e)).find(Boolean)
    if (twin) {
      const at = where(twin.sheet, twin.line)
      if (nameKey(twin.fullName) !== nameKey(fullName)) {
        return issue(ctx.errors, line, `${fullName}: samme e-post som ${at}`)
      }
      const added = years.filter((y) => !twin.years.includes(y))
      if (!added.length) return issue(ctx.errors, line, `${fullName}: står allerede på ${at}`)
      twin.years = [...twin.years, ...added].sort()
      for (const y of added) ctx.seen.nameYears.set(`${nameKey(fullName)}|${y}`, at)
      for (const email of emails) {
        if (!twin.emails.includes(email)) twin.emails.push(email)
        ctx.seen.emails.set(email, twin)
      }
      return issue(ctx.warnings, line, `${fullName}: står også på ${at}, kobles til begge kull`)
    }
    const dupName = years
      .map((y) => ctx.seen.nameYears.get(`${nameKey(fullName)}|${y}`))
      .find(Boolean)
    if (dupName) {
      return issue(ctx.errors, line, `${fullName}: samme navn og kull som ${dupName}`)
    }
    // Uten kull kan raden bare kjennes igjen på e-post ved neste import.
    if (!years.length) {
      if (!emails.length) return issue(ctx.errors, line, `${fullName}: mangler både kull og e-post`)
      issue(ctx.warnings, line, `${fullName}: mangler kull, importeres uten`)
    }

    const fields: Partial<Record<ProfileFieldKey, string>> = {}
    for (const field of profileFieldKeys) {
      const value = text(record, field)
      if (value) fields[field] = value.slice(0, 200)
    }
    const linkCell = cells(record, 'linkedinUrl')[0]
    const rawLink = [linkCell?.link, linkCell?.text].find((v) => v && /linkedin\.com/i.test(v))
    delete fields.linkedinUrl
    const url = rawLink ? normalizeLinkedinUrl(rawLink) : null
    if (url) {
      fields.linkedinUrl = url
    } else if (linkCell?.text.trim()) {
      issue(ctx.warnings, line, `${fullName}: ugyldig LinkedIn-lenke, importeres uten`)
    }

    const rawPhone = text(record, 'phone')
    const phone = rawPhone ? normalizePhone(rawPhone) : null
    if (rawPhone && !phone) {
      issue(ctx.warnings, line, `${fullName}: forstår ikke telefonnummeret, importeres uten`)
    }

    const expertise = splitTags(cells(record, 'expertise'))
    const industries = splitTags(cells(record, 'industries'))
    if (expertise.dropped || industries.dropped) {
      issue(
        ctx.warnings,
        line,
        `${fullName}: noen emner eller bransjer er for lange eller for mange, tas ikke med`,
      )
    }

    const company = text(record, 'currentCompany').slice(0, 120)
    const title = text(record, 'jobTitle').slice(0, 120)
    if (title && !company) {
      issue(ctx.warnings, line, `${fullName}: stilling uten selskap tas ikke med`)
    }

    const row: ProfileRow = {
      sheet: ctx.sheet,
      line,
      fullName,
      emails,
      years,
      phone,
      fields,
      expertise: expertise.tags,
      industries: industries.tags,
      role: company ? { company, title: title || null } : null,
    }
    for (const email of emails) ctx.seen.emails.set(email, row)
    for (const y of years)
      ctx.seen.nameYears.set(`${nameKey(fullName)}|${y}`, where(ctx.sheet, line))
    rows.push(row)
  })

  return {
    rows,
    summary: { name: ctx.sheet ?? 'CSV', rows: rows.length, columns, ignoredHeaders, inferred },
  }
}

type ParseOptions = { yearKind: YearKind; columns?: Partial<Record<ColumnKey, string>> }

const emptyResult = (): ParsedSheet => ({
  rows: [],
  errors: [],
  warnings: [],
  sheets: [],
  skippedSheets: [],
})
const newSeen = (): Seen => ({ emails: new Map(), nameYears: new Map() })

/** CSV med overskriftsrad. Kull må stå i en egen kolonne. */
export function parseProfileSheet(csv: string, options: ParseOptions): ParsedSheet {
  const records: string[][] = parse(csv, {
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  })
  const [header, ...body] = records
  if (!header) throw new Error('Filen er tom.')
  const result = emptyResult()
  const { rows, summary } = parseTable(
    header,
    body.map((r) => r.map((text) => ({ text }))),
    {
      defaultYear: null,
      yearKind: options.yearKind,
      overrides: options.columns ?? {},
      seen: newSeen(),
      errors: result.errors,
      warnings: result.warnings,
    },
  )
  return { ...result, rows, sheets: [summary] }
}

const KULL_SHEET = /^ES\s*(\d{4})(?:\s*[-–]\s*(\d{4}))?\s*$/i

function cellOf(value: ExcelJS.CellValue): Cell {
  if (value === null || value === undefined) return { text: '' }
  if (value instanceof Date) return { text: value.toISOString().slice(0, 10) }
  if (typeof value === 'object') {
    if ('richText' in value) return { text: value.richText.map((r) => r.text).join('') }
    if ('hyperlink' in value) {
      const label = value.text as unknown
      const text =
        typeof label === 'object' && label && 'richText' in label
          ? (label as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join('')
          : String(label ?? '')
      return { text, link: value.hyperlink }
    }
    if ('result' in value) return { text: String(value.result ?? '') }
    if ('error' in value) return { text: '' }
  }
  return { text: String(value) }
}

/**
 * Excel-fil med én fane per kull. Fanenavnet gir kullet («ES 2024»); faner som
 * dekker flere år («ES 2005-2009») må ha en kullkolonne. Andre faner hoppes over.
 */
export async function parseProfileWorkbook(
  data: ArrayBuffer | Uint8Array,
  options: ParseOptions,
): Promise<ParsedSheet> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(data as ArrayBuffer)
  const result = emptyResult()
  const seen = newSeen()

  for (const sheet of workbook.worksheets) {
    const match = sheet.name.match(KULL_SHEET)
    if (sheet.state !== 'visible' || !match) {
      if (sheet.state === 'visible') result.skippedSheets.push(sheet.name)
      continue
    }
    const range = match[2] !== undefined
    const width = sheet.columnCount
    const rowCells = (n: number) =>
      Array.from({ length: width }, (_, i) => cellOf(sheet.getRow(n).getCell(i + 1).value))
    const header = rowCells(1).map((c) => c.text.trim())
    const body = Array.from({ length: Math.max(0, sheet.rowCount - 1) }, (_, i) => rowCells(i + 2))

    const { rows, summary } = parseTable(header, body, {
      sheet: sheet.name,
      defaultYear: range ? null : Number(match[1]),
      yearKind: options.yearKind,
      overrides: options.columns ?? {},
      seen,
      errors: result.errors,
      warnings: result.warnings,
    })
    result.rows.push(...rows)
    result.sheets.push(summary)
  }
  if (!result.sheets.length) throw new Error('Fant ingen kullfaner («ES 2024», «ES 2005-2009» …).')
  return result
}

export type PlannedRow = ProfileRow &
  (
    | { action: 'create' }
    | {
        action: 'existing'
        personId: string
        matchedBy: 'email' | 'name'
        nameDiffers: boolean
        /** Personen har tatt i bruk profilen; da røres ingen profilfelt. */
        claimed: boolean
      }
  )

export async function planProfileImport(db: Db, rows: ProfileRow[]): Promise<PlannedRow[]> {
  const emails = rows.flatMap((r) => r.emails)
  const byEmail = new Map(
    (emails.length
      ? await db
          .select({
            email: personEmail.email,
            id: person.id,
            fullName: person.fullName,
            userId: person.userId,
          })
          .from(personEmail)
          .innerJoin(person, eq(person.id, personEmail.personId))
          .where(inArray(personEmail.email, emails))
      : []
    ).map((p) => [p.email, p]),
  )
  const years = [...new Set(rows.flatMap((r) => r.years))]
  const byNameYear = new Map(
    (years.length
      ? await db
          .select({
            id: person.id,
            fullName: person.fullName,
            userId: person.userId,
            year: cohort.graduationYear,
          })
          .from(person)
          .innerJoin(personCohort, eq(personCohort.personId, person.id))
          .innerJoin(cohort, eq(cohort.id, personCohort.cohortId))
          .where(inArray(cohort.graduationYear, years))
      : []
    ).map((p) => [`${nameKey(p.fullName)}|${p.year}`, p]),
  )

  return rows.map((row) => {
    const hit = row.emails.map((e) => byEmail.get(e)).find(Boolean)
    if (hit) {
      return {
        ...row,
        action: 'existing',
        personId: hit.id,
        matchedBy: 'email',
        nameDiffers: nameKey(hit.fullName) !== nameKey(row.fullName),
        claimed: hit.userId !== null,
      }
    }
    const byName = row.years
      .map((y) => byNameYear.get(`${nameKey(row.fullName)}|${y}`))
      .find(Boolean)
    if (byName) {
      return {
        ...row,
        action: 'existing',
        personId: byName.id,
        matchedBy: 'name',
        nameDiffers: false,
        claimed: byName.userId !== null,
      }
    }
    return { ...row, action: 'create' }
  })
}

export type ImportResult = { created: number; existing: number; cohortsCreated: number }

/**
 * Oppretter profiler, kull, kulltilknytninger og kjente e-postadresser.
 * Eksisterende personer får kulltilknytning og nye adresser hvis de mangler.
 * Profilfelt, stikkord, telefon og stilling fylles bare inn der de er tomme, og
 * bare på profiler ingen har tatt i bruk; navn og alt en person selv har skrevet
 * overskrives aldri. Telefon og e-post fra arket lagres som skjult kontaktinfo,
 * som personen selv kan velge å vise. Nye profiler får `membershipStatus`
 * (standard `active`, fordi kullisten er ESAFs egen oversikt). Rolle er alltid `member`.
 */
export async function applyProfileImport(
  db: Db,
  plan: PlannedRow[],
  options: { membershipStatus: 'active' | 'pending'; sourceLabel: string },
): Promise<ImportResult> {
  return db.transaction(async (tx) => {
    const years = [...new Set(plan.flatMap((r) => r.years))]
    const insertedCohorts = years.length
      ? await tx
          .insert(cohort)
          .values(years.map((graduationYear) => ({ graduationYear })))
          .onConflictDoNothing()
          .returning({ id: cohort.id })
      : []
    const cohortIds = new Map(
      (years.length
        ? await tx.select().from(cohort).where(inArray(cohort.graduationYear, years))
        : []
      ).map((c) => [c.graduationYear, c.id]),
    )

    // Selskapene i arket kobles som i appen: samme slug blir samme selskap, og
    // nye selskaper får skrivemåten som går igjen flest ganger.
    const mentions = plan
      .flatMap((row) => [row.role?.company, row.fields.esCompany?.slice(0, 120)])
      .filter(isCompanyName)
    const resolved = await resolveCompanies(
      tx,
      mentions.map((name) => ({ name })),
    )
    const companyIds = new Map(mentions.map((name, i) => [name, resolved[i]!]))

    let created = 0
    let existing = 0
    for (const row of plan) {
      let personId: string
      const { esCompany, ...fields } = row.fields
      const esCompanyId = companyIds.get(esCompany?.slice(0, 120) ?? '') ?? null
      const companyId = row.role ? companyIds.get(row.role.company) : undefined
      let addRole = Boolean(companyId)
      if (row.action === 'create') {
        const [p] = await tx
          .insert(person)
          .values({
            fullName: row.fullName,
            source: 'import',
            expertise: row.expertise,
            industries: row.industries,
            phone: row.phone,
            contactEmail: row.emails[0] ?? null,
            ...fields,
            esCompanyId,
          })
          .returning({ id: person.id })
        personId = p!.id
        const active = options.membershipStatus === 'active'
        await tx.insert(membership).values({
          personId,
          status: options.membershipStatus,
          decidedAt: active ? new Date() : null,
        })
        created++
      } else {
        personId = row.personId
        existing++
        const fill: Record<string, unknown> = Object.fromEntries(
          Object.entries({
            ...fields,
            esCompanyId: esCompanyId ?? undefined,
            phone: row.phone ?? undefined,
            contactEmail: row.emails[0],
          })
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => [
              key,
              sql`coalesce(${person[key as keyof typeof fields | 'esCompanyId' | 'phone' | 'contactEmail']}, ${value})`,
            ]),
        )
        for (const key of ['expertise', 'industries'] as const) {
          if (row[key].length) {
            fill[key] =
              sql`case when cardinality(${person[key]}) = 0 then ${sql.param(row[key])}::text[] else ${person[key]} end`
          }
        }
        if (Object.keys(fill).length) {
          await tx
            .update(person)
            .set(fill)
            .where(and(eq(person.id, personId), isNull(person.userId)))
        }
        if (addRole) {
          const [has] = await tx
            .select({ id: experience.id })
            .from(experience)
            .where(eq(experience.personId, personId))
            .limit(1)
          addRole = !row.claimed && !has
        }
      }
      if (addRole && row.role && companyId) {
        await tx.insert(experience).values({ personId, companyId, title: row.role.title })
      }
      if (row.emails.length) {
        await tx
          .insert(personEmail)
          .values(row.emails.map((email) => ({ email, personId, source: 'import' as const })))
          .onConflictDoNothing()
      }
      if (row.years.length) {
        await tx
          .insert(personCohort)
          .values(
            row.years.map((y) => ({
              personId,
              cohortId: cohortIds.get(y)!,
              relation: 'student' as const,
            })),
          )
          .onConflictDoNothing()
      }
    }

    // Selskaper fra rader som ikke ble brukt (profilen var alt fylt ut), skal ikke bli liggende.
    await deleteOrphanCompanies(tx, resolved)

    await tx.insert(auditEvent).values({
      actorPersonId: null,
      action: 'operator.import_profiles',
      details: {
        source: options.sourceLabel,
        created,
        existing,
        cohortsCreated: insertedCohorts.length,
        membershipStatus: options.membershipStatus,
      },
    })
    return { created, existing, cohortsCreated: insertedCohorts.length }
  })
}

/** Antall profiler og hvor mange som er tatt i bruk, per kull. */
export async function profileStatsByCohort(db: Db) {
  return db
    .select({
      graduationYear: cohort.graduationYear,
      profiles: sql<number>`count(*)::int`,
      claimed: sql<number>`count(${person.userId})::int`,
    })
    .from(personCohort)
    .innerJoin(cohort, eq(cohort.id, personCohort.cohortId))
    .innerJoin(person, eq(person.id, personCohort.personId))
    .groupBy(cohort.graduationYear)
    .orderBy(cohort.graduationYear)
}
