import { schema, type Db } from '@esaf/db'
import { parse } from 'csv-parse/sync'
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { normalizeEmail } from './members.ts'

const { auditEvent, cohort, membership, person, personCohort } = schema

/**
 * Import av profiler fra kullisten (CSV eksportert fra Google Sheets).
 * Tolkingen er ren og testbar; `planProfileImport` og `applyProfileImport`
 * snakker med databasen. Importen er idempotent: kjøres den på nytt, kjennes
 * eksisterende personer igjen på e-post, eller på navn og kull.
 */

export type ColumnKey = 'name' | 'firstName' | 'lastName' | 'email' | 'cohort'

const defaultHeaders: Record<ColumnKey, string[]> = {
  name: ['navn', 'fullt navn', 'name', 'full name'],
  firstName: ['fornavn', 'first name'],
  lastName: ['etternavn', 'last name', 'surname'],
  email: ['e-post', 'epost', 'email', 'e-mail', 'mail'],
  cohort: ['kull', 'opptaksår', 'årskull', 'cohort'],
}

export type YearKind = 'start' | 'graduation'

/** Entreprenørskolen er et toårig masterprogram: uteksaminert år = opptaksår + 2. */
const PROGRAM_YEARS = 2

export type ProfileRow = {
  line: number
  fullName: string
  email: string | null
  startYear: number
}

export type SheetIssue = { line: number; message: string }

export type ParsedSheet = {
  rows: ProfileRow[]
  /** Rader som er hoppet over. */
  errors: SheetIssue[]
  /** Rader som importeres, men med noe å se på. */
  warnings: SheetIssue[]
  columns: Partial<Record<ColumnKey, string>>
  ignoredHeaders: string[]
}

const normalizeHeader = (h: string) => h.trim().toLowerCase().replace(/\s+/g, ' ')
export const normalizeName = (n: string) => n.trim().replace(/\s+/g, ' ')
const nameKey = (n: string) => normalizeName(n).toLocaleLowerCase('nb')
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/

export function parseProfileSheet(
  csv: string,
  options: { yearKind: YearKind; columns?: Partial<Record<ColumnKey, string>> },
): ParsedSheet {
  const records: string[][] = parse(csv, {
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  })
  const [header, ...body] = records
  if (!header) throw new Error('Filen er tom.')

  const headers = header.map(normalizeHeader)
  const columns: Partial<Record<ColumnKey, string>> = {}
  const index: Partial<Record<ColumnKey, number>> = {}
  for (const key of Object.keys(defaultHeaders) as ColumnKey[]) {
    const wanted = options.columns?.[key]
    const candidates = wanted ? [normalizeHeader(wanted)] : defaultHeaders[key]
    const i = headers.findIndex((h) => candidates.includes(h))
    if (i >= 0) {
      index[key] = i
      columns[key] = header[i]
    } else if (wanted) {
      throw new Error(`Fant ikke kolonnen «${wanted}». Kolonner i filen: ${header.join(', ')}`)
    }
  }
  const hasName =
    index.name !== undefined || (index.firstName !== undefined && index.lastName !== undefined)
  if (!hasName || index.cohort === undefined) {
    throw new Error(
      `Trenger kolonne for navn (eller fornavn og etternavn) og kull. Kolonner i filen: ${header.join(', ')}. ` +
        'Oppgi dem med --kolonne navn="…" --kolonne kull="…".',
    )
  }
  const used = new Set(Object.values(index))
  const ignoredHeaders = header.filter((_, i) => !used.has(i))

  const rows: ProfileRow[] = []
  const errors: SheetIssue[] = []
  const warnings: SheetIssue[] = []
  const seenEmail = new Map<string, number>()
  const seenNameYear = new Map<string, number>()
  const cell = (r: string[], key: ColumnKey) =>
    index[key] === undefined ? '' : (r[index[key]] ?? '')

  body.forEach((record, i) => {
    const line = i + 2 // 1-basert, etter overskriftsraden
    const fullName = normalizeName(
      cell(record, 'name') || `${cell(record, 'firstName')} ${cell(record, 'lastName')}`,
    )
    if (!fullName) return errors.push({ line, message: 'mangler navn' })

    const yearMatch = cell(record, 'cohort').match(/\b(19|20)\d{2}\b/)
    if (!yearMatch) {
      return errors.push({
        line,
        message: `${fullName}: forstår ikke kull «${cell(record, 'cohort')}»`,
      })
    }
    const year = Number(yearMatch[0])
    const startYear = options.yearKind === 'graduation' ? year - PROGRAM_YEARS : year

    let email: string | null = null
    const rawEmail = cell(record, 'email')
    if (rawEmail) {
      const [first, ...rest] = rawEmail.split(/[\s,;]+/).filter(Boolean)
      if (first && EMAIL.test(first)) {
        email = normalizeEmail(first)
        if (rest.length)
          warnings.push({ line, message: `${fullName}: flere e-poster, bruker ${email}` })
      } else {
        warnings.push({
          line,
          message: `${fullName}: ugyldig e-post «${rawEmail}», importeres uten`,
        })
      }
    }

    if (email && seenEmail.has(email)) {
      return errors.push({
        line,
        message: `${fullName}: samme e-post som linje ${seenEmail.get(email)}`,
      })
    }
    const key = `${nameKey(fullName)}|${startYear}`
    if (seenNameYear.has(key)) {
      return errors.push({
        line,
        message: `${fullName}: samme navn og kull som linje ${seenNameYear.get(key)}`,
      })
    }
    if (email) seenEmail.set(email, line)
    seenNameYear.set(key, line)
    rows.push({ line, fullName, email, startYear })
  })

  return { rows, errors, warnings, columns, ignoredHeaders }
}

export type PlannedRow = ProfileRow &
  (
    | { action: 'create' }
    | { action: 'existing'; personId: string; matchedBy: 'email' | 'name'; nameDiffers: boolean }
  )

export async function planProfileImport(db: Db, rows: ProfileRow[]): Promise<PlannedRow[]> {
  const emails = rows.flatMap((r) => (r.email ? [r.email] : []))
  const byEmail = new Map(
    (emails.length
      ? await db
          .select({ id: person.id, email: person.email, fullName: person.fullName })
          .from(person)
          .where(and(isNotNull(person.email), inArray(person.email, emails)))
      : []
    ).map((p) => [p.email!, p]),
  )
  const years = [...new Set(rows.map((r) => r.startYear))]
  const byNameYear = new Map(
    (years.length
      ? await db
          .select({ id: person.id, fullName: person.fullName, startYear: cohort.startYear })
          .from(person)
          .innerJoin(personCohort, eq(personCohort.personId, person.id))
          .innerJoin(cohort, eq(cohort.id, personCohort.cohortId))
          .where(inArray(cohort.startYear, years))
      : []
    ).map((p) => [`${nameKey(p.fullName)}|${p.startYear}`, p]),
  )

  return rows.map((row) => {
    const hit = row.email ? byEmail.get(row.email) : undefined
    if (hit) {
      return {
        ...row,
        action: 'existing',
        personId: hit.id,
        matchedBy: 'email',
        nameDiffers: nameKey(hit.fullName) !== nameKey(row.fullName),
      }
    }
    const byName = byNameYear.get(`${nameKey(row.fullName)}|${row.startYear}`)
    if (byName) {
      return {
        ...row,
        action: 'existing',
        personId: byName.id,
        matchedBy: 'name',
        nameDiffers: false,
      }
    }
    return { ...row, action: 'create' }
  })
}

export type ImportResult = { created: number; existing: number; cohortsCreated: number }

/**
 * Oppretter profiler, kull og kulltilknytninger. Eksisterende personer endres
 * ikke (navn og e-post overskrives aldri), de får bare kulltilknytningen hvis
 * den mangler. Nye profiler får `membershipStatus` (standard `active`, fordi
 * kullisten er ESAFs egen oversikt). Rolle er alltid `member`.
 */
export async function applyProfileImport(
  db: Db,
  plan: PlannedRow[],
  options: { membershipStatus: 'active' | 'pending'; sourceLabel: string },
): Promise<ImportResult> {
  return db.transaction(async (tx) => {
    const years = [...new Set(plan.map((r) => r.startYear))]
    const insertedCohorts = years.length
      ? await tx
          .insert(cohort)
          .values(years.map((startYear) => ({ startYear })))
          .onConflictDoNothing()
          .returning({ id: cohort.id })
      : []
    const cohortIds = new Map(
      (years.length
        ? await tx.select().from(cohort).where(inArray(cohort.startYear, years))
        : []
      ).map((c) => [c.startYear, c.id]),
    )

    let created = 0
    let existing = 0
    for (const row of plan) {
      let personId: string
      if (row.action === 'create') {
        const [p] = await tx
          .insert(person)
          .values({ fullName: row.fullName, email: row.email, source: 'import' })
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
      }
      await tx
        .insert(personCohort)
        .values({ personId, cohortId: cohortIds.get(row.startYear)!, relation: 'student' })
        .onConflictDoNothing()
    }

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
      startYear: cohort.startYear,
      profiles: sql<number>`count(*)::int`,
      claimed: sql<number>`count(${person.userId})::int`,
    })
    .from(personCohort)
    .innerJoin(cohort, eq(cohort.id, personCohort.cohortId))
    .innerJoin(person, eq(person.id, personCohort.personId))
    .groupBy(cohort.startYear)
    .orderBy(cohort.startYear)
}
