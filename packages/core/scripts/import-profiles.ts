/**
 * Importerer profiler fra kullisten (CSV fra Google Sheets: Fil → Last ned →
 * Kommaseparerte verdier). Viser alltid en forhåndsvisning; skriver bare til
 * databasen med --apply. Se README, «Import av kullisten».
 *
 *   pnpm profiles:import --fil kull.csv --kull-er opptak
 *   pnpm profiles:import --fil kull.csv --kull-er opptak --apply
 */
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createDb, loadRootEnv } from '@esaf/db'
import {
  applyProfileImport,
  parseProfileSheet,
  planProfileImport,
  profileStatsByCohort,
  type ColumnKey,
} from '../src/index.ts'

loadRootEnv()

const usage = `Bruk: pnpm profiles:import --fil <sti.csv> --kull-er <opptak|uteksaminert> [valg]

  --kull-er opptak|uteksaminert  Hva årstallet i kull-kolonnen betyr (påkrevd)
  --kolonne navn="Fullt navn"     Overstyr kolonnenavn: navn, fornavn, etternavn, epost, kull
  --status aktiv|venter           Medlemsstatus for nye profiler (standard: aktiv)
  --apply                         Skriv til databasen (uten: bare forhåndsvisning)`

const { values } = parseArgs({
  options: {
    fil: { type: 'string' },
    'kull-er': { type: 'string' },
    kolonne: { type: 'string', multiple: true },
    status: { type: 'string', default: 'aktiv' },
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
      : fail('Oppgi --kull-er opptak eller --kull-er uteksaminert.')
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
const parsed = parseProfileSheet(readFileSync(file, 'utf8'), { yearKind, columns })

if (!process.env.DATABASE_URL) fail('Mangler DATABASE_URL.')
const target = new URL(process.env.DATABASE_URL!)
const db = createDb(process.env.DATABASE_URL!)

try {
  const plan = await planProfileImport(db, parsed.rows)
  const create = plan.filter((r) => r.action === 'create')
  const existing = plan.filter((r) => r.action === 'existing')
  const years = [...new Set(plan.map((r) => r.startYear))].sort()

  console.log(`Database: ${target.host}${target.pathname}`)
  console.log(`Fil: ${basename(file)}`)
  console.log(
    `Kolonner: ${Object.entries(parsed.columns)
      .map(([k, v]) => `${k}=«${v}»`)
      .join(', ')}`,
  )
  if (parsed.ignoredHeaders.length) {
    console.log(`Importeres ikke (ennå): ${parsed.ignoredHeaders.join(', ')}`)
  }
  console.log(`Kull (opptaksår): ${years.length ? `${years[0]}–${years.at(-1)}` : 'ingen'}`)
  console.log('')
  console.log(`  ${create.length} nye profiler (medlemsstatus: ${values.status})`)
  console.log(`  ${existing.length} finnes fra før (endres ikke, får kull hvis det mangler)`)
  console.log(
    `  ${create.filter((r) => !r.email).length} nye uten e-post (kan bare kobles manuelt av admin)`,
  )
  console.log(`  ${parsed.errors.length} rader hoppet over`)

  const nameDiffs = existing.filter((r) => r.action === 'existing' && r.nameDiffers)
  const notes = [
    ...parsed.errors.map((e) => ({ line: e.line, text: `HOPPET OVER, ${e.message}` })),
    ...parsed.warnings.map((w) => ({ line: w.line, text: w.message })),
    ...nameDiffs.map((r) => ({
      line: r.line,
      text: `${r.fullName}: e-posten finnes fra før med et annet navn`,
    })),
  ].sort((a, b) => a.line - b.line)
  if (notes.length) {
    console.log(`\nÅ se på:\n${notes.map((n) => `  linje ${n.line}: ${n.text}`).join('\n')}`)
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
    console.log('\nKull     profiler  tatt i bruk')
    for (const s of await profileStatsByCohort(db)) {
      console.log(
        `${s.startYear}     ${String(s.profiles).padStart(8)}  ${String(s.claimed).padStart(11)}`,
      )
    }
  }
} finally {
  await db.close()
}
