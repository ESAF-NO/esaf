/**
 * Importerer profiler fra kullister: Excel med én fane per kull («ES 2024»), eller
 * CSV. Viser alltid en forhåndsvisning; skriver bare til databasen med --apply.
 * Se README, «Import av kullisten».
 *
 *   pnpm profiles:import --fil telefonliste.xlsx
 *   pnpm profiles:import --fil telefonliste.xlsx --apply
 */
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createDb, loadRootEnv } from '@esaf/db'
import {
  applyProfileImport,
  parseProfileSheet,
  parseProfileWorkbook,
  planProfileImport,
  profileStatsByCohort,
  type ColumnKey,
} from '../src/index.ts'

loadRootEnv()

const usage = `Bruk: pnpm profiles:import --fil <sti.xlsx|sti.csv> [valg]

  --kull-er uteksaminert|opptak  Hva årstallet i fanenavn/kull-kolonne betyr. Standard er
                                  uteksaminert, slik ES navngir kull (ES 2024 startet i 2022)
  --kolonne navn="Fullt navn"     Overstyr kolonnenavn: navn, fornavn, etternavn, epost, kull,
                                  telefon, studieretning, ekspertise, bransjer, selskap,
                                  stilling, by, es-selskap, linkedin
  --status aktiv|venter           Medlemsstatus for nye profiler (standard: aktiv)
  --vis-rader                     Vis hver rad som importeres (inneholder persondata)
  --apply                         Skriv til databasen (uten: bare forhåndsvisning)`

const { values } = parseArgs({
  options: {
    fil: { type: 'string' },
    'kull-er': { type: 'string', default: 'uteksaminert' },
    kolonne: { type: 'string', multiple: true },
    status: { type: 'string', default: 'aktiv' },
    'vis-rader': { type: 'boolean', default: false },
    apply: { type: 'boolean', default: false },
  },
})

const fail = (message: string): never => {
  console.error(`${message}\n\n${usage}`)
  process.exit(1)
}

if (!values.fil) fail('Mangler --fil.')
const yearKind =
  values['kull-er'] === 'opptak'
    ? 'start'
    : values['kull-er'] === 'uteksaminert'
      ? 'graduation'
      : fail('Ugyldig --kull-er. Bruk uteksaminert eller opptak.')
const membershipStatus =
  values.status === 'aktiv'
    ? 'active'
    : values.status === 'venter'
      ? 'pending'
      : fail('Ugyldig --status.')

const columnNames: Record<string, ColumnKey> = {
  navn: 'name',
  fornavn: 'firstName',
  etternavn: 'lastName',
  epost: 'email',
  'e-post': 'email',
  kull: 'cohort',
  telefon: 'phone',
  studieretning: 'studyBackground',
  ekspertise: 'expertise',
  bransjer: 'industries',
  selskap: 'currentCompany',
  stilling: 'jobTitle',
  by: 'city',
  'es-selskap': 'esCompany',
  linkedin: 'linkedinUrl',
}
const columns: Partial<Record<ColumnKey, string>> = {}
for (const spec of values.kolonne ?? []) {
  const [key, ...rest] = spec.split('=')
  const column = columnNames[key?.trim() ?? '']
  if (!column || !rest.length) fail(`Ugyldig --kolonne «${spec}».`)
  columns[column!] = rest.join('=').replace(/^["']|["']$/g, '')
}

// pnpm kjører skriptet fra packages/core; tolk stien fra der kommandoen ble skrevet.
const file = resolve(process.env.INIT_CWD ?? process.cwd(), values.fil!)
const data = readFileSync(file)
const parsed = /\.xlsx$/i.test(file)
  ? await parseProfileWorkbook(data, { yearKind, columns })
  : parseProfileSheet(data.toString('utf8'), { yearKind, columns })

if (!process.env.DATABASE_URL) fail('Mangler DATABASE_URL.')
const target = new URL(process.env.DATABASE_URL!)
const db = createDb(process.env.DATABASE_URL!)
const labels: Record<string, string> = {
  name: 'navn',
  firstName: 'fornavn',
  lastName: 'etternavn',
  email: 'e-post',
  secondaryEmail: 'ekstra e-post',
  cohort: 'kull',
  phone: 'telefon',
  studyBackground: 'studieretning',
  expertise: 'ekspertise',
  industries: 'bransjer',
  currentCompany: 'selskap',
  jobTitle: 'stilling',
  city: 'by',
  esCompany: 'es-selskap',
  linkedinUrl: 'linkedin',
}

try {
  const plan = await planProfileImport(db, parsed.rows)
  const create = plan.filter((r) => r.action === 'create')
  const existing = plan.filter((r) => r.action === 'existing')
  const years = [...new Set(plan.flatMap((r) => r.years))].sort()

  console.log(`Database: ${target.host}${target.pathname}`)
  console.log(`Fil: ${basename(file)}`)
  for (const sheet of parsed.sheets) {
    const cols = Object.entries(sheet.columns)
      .map(([k, v]) => `${labels[k] ?? k}=«${v}»`)
      .join(', ')
    console.log(`\n  ${sheet.name}: ${sheet.rows} rader`)
    console.log(`    bruker: ${cols}`)
    for (const note of sheet.inferred) console.log(`    NB: ${note}`)
    if (sheet.ignoredHeaders.length)
      console.log(`    importeres ikke: ${sheet.ignoredHeaders.join(', ')}`)
  }
  if (parsed.skippedSheets.length) {
    console.log(`\n  Faner som hoppes over: ${parsed.skippedSheets.join(', ')}`)
  }

  console.log(
    `\nKull (uteksamineringsår): ${years.length ? `ES ${years[0]}–ES ${years.at(-1)}` : 'ingen'}`,
  )
  console.log(`  ${create.length} nye profiler (medlemsstatus: ${values.status})`)
  console.log(`  ${existing.length} finnes fra før (navn og egne endringer røres ikke)`)
  console.log(
    `  ${plan.filter((r) => !r.emails.length).length} uten e-post (kan bare kobles manuelt av admin)`,
  )
  console.log(`  ${plan.filter((r) => r.phone).length} med telefon (lagres skjult)`)
  console.log(`  ${parsed.errors.length} rader hoppet over`)

  const at = (sheet: string | undefined, line: number) =>
    sheet ? `${sheet} rad ${line}` : `linje ${line}`
  const notes = [
    ...parsed.errors.map((e) => ({ ...e, text: `HOPPET OVER, ${e.message}` })),
    ...parsed.warnings.map((w) => ({ ...w, text: w.message })),
    ...existing
      .filter((r) => r.action === 'existing' && r.nameDiffers)
      .map((r) => ({
        sheet: r.sheet,
        line: r.line,
        text: `${r.fullName}: e-posten finnes fra før med et annet navn`,
      })),
  ]
  if (notes.length) {
    console.log(`\nÅ se på:\n${notes.map((n) => `  ${at(n.sheet, n.line)}: ${n.text}`).join('\n')}`)
  }
  if (values['vis-rader']) {
    console.log('\nRader:')
    for (const r of plan) {
      console.log(
        `  ${at(r.sheet, r.line)}: ${r.action === 'create' ? 'ny' : 'finnes'} · ${r.fullName} · ${r.years.map((y) => `ES ${y}`).join(', ') || 'uten kull'}`,
      )
    }
  }

  if (!values.apply) {
    console.log(
      '\nForhåndsvisning. Ingenting er skrevet. Kjør på nytt med --apply for å importere.',
    )
  } else {
    const result = await applyProfileImport(db, plan, {
      membershipStatus,
      sourceLabel: basename(file),
    })
    console.log(
      `\nImportert: ${result.created} nye profiler, ${result.existing} eksisterende, ${result.cohortsCreated} nye kull.`,
    )
    console.log('\nKull        profiler  tatt i bruk')
    for (const s of await profileStatsByCohort(db)) {
      console.log(
        `ES ${s.graduationYear}     ${String(s.profiles).padStart(8)}  ${String(s.claimed).padStart(11)}`,
      )
    }
  }
} finally {
  await db.close()
}
