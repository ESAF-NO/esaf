import { schema, type Db } from '@esaf/db'
import { eq, inArray } from 'drizzle-orm'
import type { z } from 'zod'
import { assertCan, type Viewer } from './access.ts'
import { DomainError } from './errors.ts'
import {
  defaultPersonDecision,
  matchPeopleRefs,
  participationDecisions,
  type ImportIssue,
  type ImportPersonPreview,
  type PersonRef,
} from './event-import.ts'
import { emailKey, normalizeEmail, type Tx } from './members.ts'
import { insertProfile, normalizePersonName } from './people-admin.ts'
import { loadMatchPeople, parseAttendeeLine } from './person-match.ts'
import { defaultHeaders } from './profile-import.ts'
import {
  columnLetter,
  findHeaderRow,
  mapHeader,
  parseCohortCell,
  readSpreadsheet,
  rowLabel,
  type Grid,
  type HeaderMap,
} from './spreadsheet.ts'

const { auditEvent, cohort, cohortRepresentative, personCohort, person } = schema

/**
 * Import av kullrepresentanter fra et regneark: én rad per verv, med kull
 * («2019», «ES 2019»), navn og/eller e-post, og gjerne fra- og til-år og et
 * notat. Faner som heter «ES 2019» gir kullet når kolonnen mangler. Som
 * importen av deltakelse: ingenting lagres før admin har sett over treffene, og
 * da i én transaksjon. Samme fil to ganger endrer ingenting; endrede år og
 * notater vises som endringer. Krever `members.manage`, og `profiles.edit` for
 * å lage nye profiler. Logges som `cohort.rep_import`.
 */

const aliases = {
  cohort: ['kull', 'es-kull', 'årskull', 'cohort', 'es', 'kull (es)'],
  name: ['navn', 'fullt navn', 'name', 'full name', 'representant', 'kullrepresentant', 'person'],
  firstName: ['fornavn', 'first name'],
  lastName: ['etternavn', 'last name', 'surname'],
  email: [
    ...defaultHeaders.email,
    ...defaultHeaders.secondaryEmail,
    'e-postadresse',
    'epostadresse',
  ],
  start: ['fra', 'fra år', 'start', 'startår', 'siden', 'fra og med', 'valgt'],
  end: ['til', 'til år', 'slutt', 'sluttår', 'til og med', 'gikk av'],
  period: ['periode', 'år', 'verv', 'år som representant'],
  note: ['notat', 'note', 'kommentar', 'merknad'],
} as const

type Key = keyof typeof aliases
type Columns = HeaderMap<Key>

const labels: Record<Key, string> = {
  cohort: 'Kull',
  name: 'Navn',
  firstName: 'Fornavn',
  lastName: 'Etternavn',
  email: 'E-post',
  start: 'Fra',
  end: 'Til',
  period: 'Periode',
  note: 'Notat',
}

const SHEET_COHORT = /^\s*(?:ES|kull)\s*((?:19|20)\d{2})\s*$/i

export type RepresentativeRow = {
  key: string
  where: string
  graduationYear: number
  personKey: string
  startYear: number | null
  endYear: number | null
  note: string | null
}

export type ParsedRepresentatives = {
  sheets: string[]
  columns: { label: string; header: string }[]
  people: PersonRef[]
  rows: RepresentativeRow[]
  issues: ImportIssue[]
}

/** «2019–2022», «2019-», «siden 2019», «til 2018», «2019». */
export function parsePeriod(raw: string): { start: number | null; end: number | null } | null {
  const text = raw.trim().toLowerCase()
  if (!text) return { start: null, end: null }
  const years = (text.match(/(?<!\d)(?:19|20)\d{2}(?!\d)/g) ?? []).map(Number)
  if (years.length === 2) return { start: years[0]!, end: years[1]! }
  if (years.length !== 1) return null
  const y = years[0]!
  if (/^(til|t\.o\.m\.?|–|-)\s*/.test(text)) return { start: null, end: y }
  if (/[-–]\s*(nå|naa|dd)?\s*$/.test(text) || /^(siden|fra)\b/.test(text))
    return { start: y, end: null }
  return { start: y, end: y }
}

const yearCell = (raw: string) => {
  if (!raw.trim()) return { ok: true as const, year: null }
  const m = raw.match(/(?<!\d)((?:19|20)\d{2})(?!\d)/g)
  return m?.length === 1 ? { ok: true as const, year: Number(m[0]) } : { ok: false as const }
}

/** Tolker arket. Ren funksjon: ingen database. */
export function parseRepresentatives(
  grids: Grid[],
  thisYear = new Date().getFullYear(),
): ParsedRepresentatives {
  const issues: ImportIssue[] = []
  const rows: RepresentativeRow[] = []
  const refs = new Map<string, PersonRef>()
  const byEmail = new Map<string, PersonRef>()
  const byName = new Map<string, PersonRef>()
  const seen = new Map<string, string>()
  let columns: ParsedRepresentatives['columns'] = []
  const single = grids.length === 1
  let any = false

  for (const grid of grids) {
    const sheetYear = Number(grid.name.match(SHEET_COHORT)?.[1] ?? NaN)
    const h = findHeaderRow(grid, (r) => {
      const c = mapHeader(r, aliases, ['email']) as Columns
      return Boolean((c.name || c.email || c.firstName) && (c.cohort || !Number.isNaN(sheetYear)))
    })
    if (h === null) continue
    any = true
    const header = grid.rows[h]!
    const c = mapHeader(header, aliases, ['email']) as Columns
    if (!columns.length) {
      columns = (Object.keys(labels) as Key[]).flatMap((k) =>
        c[k]
          ? [
              {
                label: labels[k],
                header: c[k].map((i) => header[i] || `kolonne ${columnLetter(i)}`).join(' + '),
              },
            ]
          : [],
      )
    }
    const cell = (row: string[], k: Key) => (c[k] ? (row[c[k][0]!] ?? '') : '')
    for (let i = h + 1; i < grid.rows.length; i++) {
      const row = grid.rows[i]!
      if (!row.some(Boolean)) continue
      const where = rowLabel(grid, i, single)
      const rawCohort = cell(row, 'cohort')
      const graduationYear = rawCohort
        ? parseCohortCell(rawCohort)
        : Number.isNaN(sheetYear)
          ? null
          : sheetYear
      if (graduationYear === null) {
        issues.push({
          where,
          message: rawCohort
            ? `forstår ikke kullet «${rawCohort}», hoppes over`
            : 'mangler kull, hoppes over',
        })
        continue
      }
      const rawName =
        cell(row, 'name') ||
        [cell(row, 'firstName'), cell(row, 'lastName')].filter(Boolean).join(' ')
      const parsed = parseAttendeeLine(rawName)
      const emails = [
        ...new Set(
          [
            ...parsed.emails,
            ...(c.email ?? []).flatMap((ci) =>
              (row[ci] ?? '').split(/[\s,;]+/).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)),
            ),
          ].map(normalizeEmail),
        ),
      ]
      if (!parsed.name && !emails.length) {
        issues.push({ where, message: 'mangler navn og e-post, hoppes over' })
        continue
      }

      let start: number | null = null
      let end: number | null = null
      const period = cell(row, 'period')
      if (period) {
        const p = parsePeriod(period)
        if (!p) {
          issues.push({ where, message: `forstår ikke perioden «${period}», hoppes over` })
          continue
        }
        ;({ start, end } = p)
      }
      const s = yearCell(cell(row, 'start'))
      const e = yearCell(cell(row, 'end'))
      if (!s.ok || !e.ok) {
        issues.push({ where, message: 'forstår ikke fra- eller til-året, hoppes over' })
        continue
      }
      start = s.year ?? start
      end = e.year ?? end
      const bad = [start, end].some((y) => y !== null && (y < 1990 || y > thisYear + 1))
      if (bad || (start !== null && end !== null && end < start)) {
        issues.push({ where, message: 'ugyldige år, hoppes over' })
        continue
      }

      // Samme person: samme e-post, eller samme navn.
      const keys = emails.map(emailKey)
      const name = normalizePersonName(parsed.name)
      let ref =
        keys.map((k) => byEmail.get(k)).find(Boolean) ?? (name ? byName.get(name) : undefined)
      if (!ref) {
        ref = {
          key: keys[0] ? `e:${keys[0]}` : `n:${name}`,
          fullName: parsed.name,
          emails: [],
          year: graduationYear,
          lines: [],
          count: 0,
        }
        refs.set(ref.key, ref)
      }
      for (const [j, email] of emails.entries()) {
        if (!ref.emails.includes(email)) ref.emails.push(email)
        byEmail.set(keys[j]!, ref)
      }
      if (!ref.fullName) ref.fullName = parsed.name
      if (name) byName.set(name, ref)
      const dup = `${ref.key}|${graduationYear}|${start ?? ''}|${end ?? ''}`
      if (seen.has(dup)) {
        issues.push({ where, message: `samme verv som ${seen.get(dup)}, hoppes over` })
        continue
      }
      seen.set(dup, where)
      ref.lines.push(where)
      ref.count++
      const note = cell(row, 'note').slice(0, 300) || null
      rows.push({
        key: `${where}`,
        where,
        graduationYear,
        personKey: ref.key,
        startYear: start,
        endYear: end,
        note,
      })
    }
  }
  if (!any) {
    throw new DomainError('Fant ikke kolonnene for kull og navn eller e-post. Se eksempelet.')
  }
  return { sheets: grids.map((g) => g.name), columns, people: [...refs.values()], rows, issues }
}

export type RepresentativePreview = Omit<ParsedRepresentatives, 'people'> & {
  fileName: string
  people: ImportPersonPreview[]
}

export type RepresentativeImportInput = { data: Uint8Array; fileName: string }

async function prepare(db: Db | Tx, input: RepresentativeImportInput) {
  const grids = await readSpreadsheet(input.data, input.fileName)
  const parsed = parseRepresentatives(grids)
  // Kullet på raden skiller mellom personer med samme navn.
  const people = matchPeopleRefs(parsed.people, await loadMatchPeople(db))
  return { parsed, people }
}

export async function previewRepresentativeImport(
  db: Db,
  viewer: Viewer,
  input: RepresentativeImportInput,
): Promise<RepresentativePreview> {
  assertCan(viewer, 'members.manage')
  const { parsed, people } = await prepare(db, input)
  return { ...parsed, fileName: input.fileName, people }
}

export const representativeDecisions = participationDecisions.pick({ people: true })
export type RepresentativeDecisions = z.infer<typeof representativeDecisions>

export type RepresentativeChange = {
  personId: string | null
  fullName: string
  graduationYear: number
  kind: 'add' | 'update'
  from: { startYear: number | null; endYear: number | null } | null
  to: { startYear: number | null; endYear: number | null }
  noteChanged: boolean
  /** Personen går ikke i kullet. */
  otherCohort: boolean
}

export type RepresentativePlan = {
  saved: boolean
  totals: {
    added: number
    updated: number
    unchanged: number
    skipped: number
    profilesCreated: number
  }
  changes: RepresentativeChange[]
  notes: ImportIssue[]
}

class DryRun extends Error {
  constructor(readonly plan: RepresentativePlan) {
    super('dry run')
  }
}

/**
 * Lagrer vervene, eller viser med `dryRun` nøyaktig hva som ville skjedd.
 * Et verv kjennes igjen på kull, person og fra-år; uten fra-år på et nåværende
 * verv er det det nåværende vervet. Finnes det, rettes årene og notatet (et tomt
 * notat i arket fjerner ikke et notat som står). Ellers legges det til.
 */
export async function applyRepresentativeImport(
  db: Db,
  viewer: Viewer,
  input: RepresentativeImportInput & { decisions: RepresentativeDecisions; dryRun: boolean },
): Promise<RepresentativePlan> {
  assertCan(viewer, 'members.manage')
  const decisions = representativeDecisions.safeParse(input.decisions)
  if (!decisions.success) throw new DomainError('Ugyldige valg i forhåndsvisningen.')
  if (Object.values(decisions.data.people).some((d) => d.kind === 'create')) {
    assertCan(viewer, 'profiles.edit')
  }
  try {
    return await db.transaction(async (tx) => {
      const { parsed, people } = await prepare(tx, input)
      const personIds = new Map<string, { id: string; fullName: string }>()
      const created = new Set<string>()
      let profilesCreated = 0
      const chosen = people.map(
        (p) => [p, decisions.data.people[p.key] ?? defaultPersonDecision(p)] as const,
      )
      const ids = chosen.flatMap(([, d]) => (d.kind === 'existing' ? [d.personId] : []))
      const known = ids.length
        ? await tx
            .select({ id: person.id, fullName: person.fullName })
            .from(person)
            .where(inArray(person.id, ids))
        : []
      const names = new Map(known.map((p) => [p.id, p.fullName]))
      for (const [p, d] of chosen) {
        if (d.kind === 'skip') continue
        if (d.kind === 'existing') {
          const fullName = names.get(d.personId)
          if (!fullName)
            throw new DomainError(`Fant ikke personen valgt for «${p.fullName || p.emails[0]}».`)
          personIds.set(p.key, { id: d.personId, fullName })
          continue
        }
        const { personId } = await insertProfile(
          tx,
          viewer,
          {
            fullName: d.fullName,
            emails: d.emails,
            cohorts:
              d.graduationYear === null
                ? []
                : [{ graduationYear: d.graduationYear, relation: 'student' }],
            status: d.status,
          },
          { via: 'cohort.rep_import' },
        ).catch((error: unknown) => {
          throw new DomainError(
            `Ny profil for «${d.fullName}»: ${error instanceof Error ? error.message : 'ugyldige felt.'}`,
          )
        })
        personIds.set(p.key, { id: personId, fullName: d.fullName.trim() })
        created.add(personId)
        profilesCreated++
      }

      const years = [...new Set(parsed.rows.map((r) => r.graduationYear))]
      if (years.length) {
        await tx
          .insert(cohort)
          .values(years.map((graduationYear) => ({ graduationYear })))
          .onConflictDoNothing()
      }
      const cohortRows = years.length
        ? await tx
            .select({ id: cohort.id, year: cohort.graduationYear })
            .from(cohort)
            .where(inArray(cohort.graduationYear, years))
        : []
      const cohortId = new Map(cohortRows.map((c) => [c.year, c.id]))
      const allPeople = [...new Set([...personIds.values()].map((p) => p.id))]
      const terms = allPeople.length
        ? await tx
            .select()
            .from(cohortRepresentative)
            .where(inArray(cohortRepresentative.personId, allPeople))
            .for('update')
        : []
      const memberships = allPeople.length
        ? await tx
            .select({ personId: personCohort.personId, cohortId: personCohort.cohortId })
            .from(personCohort)
            .where(inArray(personCohort.personId, allPeople))
        : []
      const inCohort = new Set(memberships.map((m) => `${m.personId}:${m.cohortId}`))

      const changes: RepresentativeChange[] = []
      const notes: ImportIssue[] = []
      const log: {
        representativeId: string
        graduationYear: number
        personId: string
        kind: 'add' | 'update'
      }[] = []
      let unchanged = 0
      let skipped = 0
      for (const row of parsed.rows) {
        const who = personIds.get(row.personKey)
        if (!who) {
          skipped++
          continue
        }
        const cid = cohortId.get(row.graduationYear)!
        const own = terms.filter((t) => t.cohortId === cid && t.personId === who.id)
        const current = own.find((t) => t.endYear === null)
        const term =
          (row.startYear !== null ? own.find((t) => t.startYear === row.startYear) : undefined) ??
          (row.endYear === null ? current : undefined) ??
          (row.startYear === null ? own.find((t) => t.endYear === row.endYear) : undefined)
        const otherCohort = !inCohort.has(`${who.id}:${cid}`)
        if (!term) {
          if (row.endYear === null && current) {
            notes.push({
              where: row.where,
              message: `${who.fullName} er allerede kullrepresentant for ES ${row.graduationYear}, hoppes over`,
            })
            skipped++
            continue
          }
          const [inserted] = await tx
            .insert(cohortRepresentative)
            .values({
              cohortId: cid,
              personId: who.id,
              startYear: row.startYear,
              endYear: row.endYear,
              note: row.note,
            })
            .returning()
          terms.push(inserted!)
          log.push({
            representativeId: inserted!.id,
            graduationYear: row.graduationYear,
            personId: who.id,
            kind: 'add',
          })
          changes.push({
            personId: who.id,
            fullName: who.fullName,
            graduationYear: row.graduationYear,
            kind: 'add',
            from: null,
            to: { startYear: row.startYear, endYear: row.endYear },
            noteChanged: Boolean(row.note),
            otherCohort,
          })
          continue
        }
        const next = {
          startYear: row.startYear ?? term.startYear,
          endYear: row.endYear,
          note: row.note ?? term.note,
        }
        if (next.startYear !== null && next.endYear !== null && next.endYear < next.startYear) {
          notes.push({
            where: row.where,
            message: 'til-året er før fra-året i vervet som står, hoppes over',
          })
          skipped++
          continue
        }
        if (next.endYear === null && term.endYear !== null && current && current.id !== term.id) {
          notes.push({
            where: row.where,
            message: `${who.fullName} har allerede et nåværende verv for ES ${row.graduationYear}, hoppes over`,
          })
          skipped++
          continue
        }
        if (
          next.startYear === term.startYear &&
          next.endYear === term.endYear &&
          next.note === term.note
        ) {
          unchanged++
          continue
        }
        await tx.update(cohortRepresentative).set(next).where(eq(cohortRepresentative.id, term.id))
        log.push({
          representativeId: term.id,
          graduationYear: row.graduationYear,
          personId: who.id,
          kind: 'update',
        })
        changes.push({
          personId: who.id,
          fullName: who.fullName,
          graduationYear: row.graduationYear,
          kind: 'update',
          from: { startYear: term.startYear, endYear: term.endYear },
          to: { startYear: next.startYear, endYear: next.endYear },
          noteChanged: next.note !== term.note,
          otherCohort,
        })
        Object.assign(term, next)
      }

      const added = log.filter((l) => l.kind === 'add').length
      const updated = log.length - added
      const plan: RepresentativePlan = {
        saved: !input.dryRun,
        totals: { added, updated, unchanged, skipped, profilesCreated },
        // En prøvekjøring rulles tilbake, så nye profiler får ingen id.
        changes: changes
          .map((c) =>
            input.dryRun && c.personId && created.has(c.personId) ? { ...c, personId: null } : c,
          )
          .sort(
            (a, b) =>
              b.graduationYear - a.graduationYear || a.fullName.localeCompare(b.fullName, 'nb'),
          ),
        notes,
      }
      if (log.length || profilesCreated) {
        await tx.insert(auditEvent).values({
          actorPersonId: viewer.personId,
          action: 'cohort.rep_import',
          subjectPersonId: log.length === 1 ? log[0]!.personId : null,
          details: {
            fileName: input.fileName.slice(0, 200),
            added,
            updated,
            unchanged,
            profilesCreated,
            terms: log.slice(0, 500),
          },
        })
      }
      if (input.dryRun) throw new DryRun(plan)
      return plan
    })
  } catch (error) {
    if (error instanceof DryRun) return error.plan
    throw error
  }
}
