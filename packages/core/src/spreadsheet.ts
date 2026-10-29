import { parse } from 'csv-parse/sync'
import ExcelJS from 'exceljs'
import { DomainError } from './errors.ts'
import { normalizePersonName } from './people-admin.ts'
import { cellOf, normalizeHeader } from './profile-import.ts'

/**
 * Regneark som admins laster opp (deltakelse på arrangementer og
 * kullrepresentanter): .xlsx eller .csv, lest i minnet og aldri lagret.
 * Tolkingen av innholdet ligger i `event-import.ts` og `rep-import.ts`.
 */

/** Største fil som tas imot. */
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024
/** Flest rader per fane. */
export const IMPORT_MAX_ROWS = 5000
const MAX_COLUMNS = 400

/** En fane som tekst: `rows[0]` er rad 1 i arket. Cellene er trimmet; datoer er `YYYY-MM-DD`. */
export type Grid = { name: string; rows: string[][] }

const isXlsx = (d: Uint8Array) => d[0] === 0x50 && d[1] === 0x4b && d[2] === 0x03 && d[3] === 0x04
const isOldExcel = (d: Uint8Array) =>
  d[0] === 0xd0 && d[1] === 0xcf && d[2] === 0x11 && d[3] === 0xe0

/** Filnavnet uten mappe og filtype, til navnet på en CSV-fane. */
export const baseName = (fileName: string) =>
  fileName
    .split(/[/\\]/)
    .at(-1)!
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .trim() || 'Ark'

/** Fjerner tomme rader og kolonner på slutten, så størrelsen er den som faktisk er brukt. */
function trimGrid(rows: string[][]): string[][] {
  const out = rows.map((r) => {
    let end = r.length
    while (end > 0 && !r[end - 1]) end--
    return r.slice(0, end)
  })
  while (out.length && !out.at(-1)!.length) out.pop()
  return out
}

function tooBig(name: string): never {
  throw new DomainError(`Fanen «${name}» har mer enn ${IMPORT_MAX_ROWS} rader. Del den opp.`)
}

async function readXlsx(data: Uint8Array): Promise<Grid[]> {
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(data as unknown as ArrayBuffer)
  } catch {
    throw new DomainError('Kunne ikke lese Excel-fila. Lagre den på nytt som .xlsx og prøv igjen.')
  }
  const grids: Grid[] = []
  for (const sheet of workbook.worksheets) {
    if (sheet.state !== 'visible') continue
    if (sheet.actualRowCount > IMPORT_MAX_ROWS) tooBig(sheet.name)
    const width = Math.min(sheet.columnCount, MAX_COLUMNS)
    const rows: string[][] = []
    for (let n = 1; n <= Math.min(sheet.rowCount, IMPORT_MAX_ROWS * 2); n++) {
      const row = sheet.getRow(n)
      rows.push(
        Array.from({ length: width }, (_, i) => {
          const value = row.getCell(i + 1).value
          // Formler som gir en dato.
          if (
            value &&
            typeof value === 'object' &&
            'result' in value &&
            value.result instanceof Date
          ) {
            return value.result.toISOString().slice(0, 10)
          }
          return cellOf(value).text.replace(/\s+/g, ' ').trim()
        }),
      )
    }
    const trimmed = trimGrid(rows)
    if (trimmed.length > IMPORT_MAX_ROWS) tooBig(sheet.name)
    grids.push({ name: sheet.name.trim(), rows: trimmed })
  }
  return grids
}

/** UTF-8 hvis det er gyldig, ellers Windows-1252 (CSV lagret fra Excel på Windows). */
function decodeText(data: Uint8Array) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(data)
  } catch {
    return new TextDecoder('windows-1252').decode(data)
  }
}

/** Skilletegnet som går igjen i de første linjene: komma, semikolon (norsk Excel) eller tab. */
function sniffDelimiter(text: string) {
  const sample = text
    .split(/\r?\n/)
    .slice(0, 10)
    .join('\n')
    .replace(/"[^"]*"/g, '')
  const counts = [',', ';', '\t'].map((d) => [d, sample.split(d).length - 1] as const)
  return counts.reduce((a, b) => (b[1] > a[1] ? b : a))[0]
}

function readCsv(data: Uint8Array, fileName: string): Grid[] {
  const text = decodeText(data).replace(/^\uFEFF/, '')
  if (text.includes('\u0000')) {
    throw new DomainError('Forstår ikke fila. Last opp et regneark som .xlsx eller .csv.')
  }
  let records: string[][]
  try {
    records = parse(text, {
      delimiter: sniffDelimiter(text),
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: false,
      trim: true,
      to_line: IMPORT_MAX_ROWS * 2,
    })
  } catch {
    throw new DomainError('Kunne ikke lese CSV-fila. Sjekk at den er lagret som CSV.')
  }
  const rows = trimGrid(
    records.map((r) => r.slice(0, MAX_COLUMNS).map((c) => c.replace(/\s+/g, ' ').trim())),
  )
  const name = baseName(fileName)
  if (rows.length > IMPORT_MAX_ROWS) tooBig(name)
  return [{ name, rows }]
}

/**
 * Leser et regneark: .xlsx (alle synlige faner) eller .csv (én fane med
 * filnavnet). Gamle .xls-filer og andre filer avvises med en forklaring.
 */
export async function readSpreadsheet(data: Uint8Array, fileName: string): Promise<Grid[]> {
  if (data.byteLength > IMPORT_MAX_BYTES) {
    throw new DomainError(`Fila er for stor. Maks ${IMPORT_MAX_BYTES / 1024 / 1024} MB.`)
  }
  if (!data.byteLength) throw new DomainError('Fila er tom.')
  if (isOldExcel(data)) {
    throw new DomainError('Gamle Excel-filer (.xls) støttes ikke. Lagre som .xlsx eller CSV.')
  }
  const grids = isXlsx(data)
    ? await readXlsx(data)
    : /\.(xlsx|xlsm|ods|numbers|pdf|docx?)$/i.test(fileName)
      ? (() => {
          throw new DomainError('Forstår ikke fila. Last opp et regneark som .xlsx eller .csv.')
        })()
      : readCsv(data, fileName)
  const used = grids.filter((g) => g.rows.length)
  if (!used.length) throw new DomainError('Fant ingen rader i regnearket.')
  return used
}

// ---------------------------------------------------------------------------
// Kolonner og verdier
// ---------------------------------------------------------------------------

/** Hvilke kolonner (0-basert) som betyr hva, ut fra overskriftene. */
export type HeaderMap<K extends string> = Partial<Record<K, number[]>>

/**
 * Finner kolonnene fra overskriftene. Hver nøkkel får første treff, unntatt dem
 * i `multi` (f.eks. e-post), som kan ha flere kolonner. En kolonne brukes bare
 * én gang, i rekkefølgen nøklene står i `aliases`.
 */
export function mapHeader<K extends string>(
  header: string[],
  aliases: Record<K, readonly string[]>,
  multi: readonly K[] = [],
): HeaderMap<K> {
  const normalized = header.map(normalizeHeader)
  const map: HeaderMap<K> = {}
  const taken = new Set<number>()
  for (const key of Object.keys(aliases) as K[]) {
    const found = normalized.flatMap((h, i) =>
      h && aliases[key].includes(h) && !taken.has(i) ? [i] : [],
    )
    const use = multi.includes(key) ? found : found.slice(0, 1)
    if (use.length) {
      map[key] = use
      use.forEach((i) => taken.add(i))
    }
  }
  return map
}

/**
 * Raden med overskriftene: den første av de ti første radene der `isHeader`
 * kjenner igjen kolonnene. Arkene har ofte en tittel eller tomme rader over.
 */
export function findHeaderRow(grid: Grid, isHeader: (row: string[]) => boolean): number | null {
  for (let i = 0; i < Math.min(10, grid.rows.length); i++) {
    if (isHeader(grid.rows[i]!)) return i
  }
  return null
}

/** «Ark1 rad 4», eller «rad 4» når det bare er én fane. */
export const rowLabel = (grid: Grid, index: number, single: boolean) =>
  single ? `rad ${index + 1}` : `${grid.name} rad ${index + 1}`

/** Kolonnebokstaven i Excel: 0 → A, 26 → AA. */
export function columnLetter(index: number) {
  let n = index + 1
  let s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/** Et kull fra en celle: «2019», «ES 2019», «ES2019», «Kull 2019». Null hvis det ikke er ett. */
export function parseCohortCell(raw: string): number | null {
  const found = raw.match(/(?<!\d)((?:19|20)\d{2})(?!\d)/g) ?? []
  return found.length === 1 ? Number(found[0]) : null
}

/** En dato fra en celle: `2018-09-14` (Excel-dato), «14.09.2018» eller «14/9/2018». */
export function parseDateCell(raw: string): string | null {
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  const nordic = raw.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/)
  const [y, m, d] = iso
    ? [iso[1]!, iso[2]!, iso[3]!]
    : nordic
      ? [nordic[3]!, nordic[2]!.padStart(2, '0'), nordic[1]!.padStart(2, '0')]
      : []
  if (!y) return null
  const date = `${y}-${m}-${d}`
  const parsed = new Date(`${date}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null
}

/** En celleverdi slik den sammenlignes: små bokstaver, uten aksenter og punktum på slutten. */
export function normalizeValue(raw: string) {
  return raw
    .toLocaleLowerCase('nb')
    .replace(/ø/g, 'o')
    .replace(/æ/g, 'ae')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.:!]+$/, '')
    .trim()
}

/** Navnet slik det sammenlignes (som personnavn). */
export const normalizeLabel = normalizePersonName
