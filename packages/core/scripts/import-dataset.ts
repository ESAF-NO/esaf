/**
 * Importerer en datasettbunt (fra `pnpm data:bundle`) i databasen: selskaper,
 * logoer, historikk, saker i media, profiler, profilbilder og sitater. Viser
 * alltid en forhåndsvisning; skriver bare med --apply. Bilder lagres der appen
 * lagrer dem (S3/R2 i produksjon, disk lokalt). Se README, «Fylle produksjon med
 * datasettet».
 *
 *   pnpm data:import --fil /tmp/esaf-datasett.tar.gz
 *   pnpm data:import --fil /tmp/esaf-datasett.tar.gz --apply
 */
import { readFileSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createDb, loadRootEnv } from '@esaf/db'
import {
  allDatasetOptions,
  applyDatasetImport,
  changesIn,
  createStorage,
  datasetEntities,
  DatasetError,
  describeDatasetOptions,
  describeStorage,
  previewDatasetImport,
  readDatasetBundle,
  storageConfigFromEnv,
  storageEnvIssues,
  type DatasetEntity,
  type DatasetImportReport,
  type DatasetOptions,
} from '../src/index.ts'

loadRootEnv()

const usage = `Bruk: pnpm data:import --fil <bunt.tar.gz> [valg]

  --apply                 Skriv til databasen og lagringen (uten: bare forhåndsvisning)
  --bekreft <dbnavn>      Navnet på databasen, når den ikke er lokal (ellers spørres det)
  --bare-selskaper        Bare selskaper, logoer, historikk og saker i media.
                          Ingen persondata, ingen koblinger mellom personer og
                          selskaper, ingen sitater
  --uten-profilbilder     Ikke profilbilder
  --uten-sitater          Ikke sitater
  --uten-bio              Ikke bio på profilene

Fødselsdatoer importeres aldri. Bunten inneholder persondata: slett den når
importen er ferdig.`

const fail = (message: string): never => {
  console.error(`${message}\n\n${usage}`)
  process.exit(1)
}

const { values } = (() => {
  try {
    return parseArgs({
      options: {
        fil: { type: 'string' },
        apply: { type: 'boolean', default: false },
        bekreft: { type: 'string' },
        'bare-selskaper': { type: 'boolean', default: false },
        'uten-profilbilder': { type: 'boolean', default: false },
        'uten-sitater': { type: 'boolean', default: false },
        'uten-bio': { type: 'boolean', default: false },
        hjelp: { type: 'boolean', default: false },
      },
    })
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
})()

if (values.hjelp) {
  console.log(usage)
  process.exit(0)
}
if (!values.fil) fail('Mangler --fil.')
if (!process.env.DATABASE_URL) fail('Mangler DATABASE_URL.')

const options: DatasetOptions = values['bare-selskaper']
  ? { ...allDatasetOptions, onlyCompanies: true }
  : {
      onlyCompanies: false,
      photos: !values['uten-profilbilder'],
      quotes: !values['uten-sitater'],
      bio: !values['uten-bio'],
    }

// pnpm kjører skriptet fra packages/core; tolk stien fra der kommandoen ble skrevet.
const file = resolve(process.env.INIT_CWD ?? process.cwd(), values.fil!)
let bundle: ReturnType<typeof readDatasetBundle>
try {
  if (statSync(file).size > 2 * 1024 * 1024 * 1024) fail('Bunten er større enn 2 GB.')
  bundle = readDatasetBundle(readFileSync(file))
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail(`Fant ikke ${file}.`)
  if (error instanceof DatasetError) fail(`Kan ikke bruke bunten: ${error.message}`)
  if (error instanceof Error) fail(`Kan ikke lese bunten: ${error.message}`)
  throw error
}

// Bildene lagres der appen lagrer dem, med de samme reglene (S3 påkrevd i produksjon).
const production = process.env.NODE_ENV === 'production'
const storageIssues = storageEnvIssues(process.env, { production })
if (storageIssues.length) {
  fail(
    `Lagringen for bilder er ikke satt opp:\n${storageIssues.map((i) => `  - ${i.variable}: ${i.message}`).join('\n')}`,
  )
}
const storageConfig = storageConfigFromEnv(
  process.env,
  fileURLToPath(new URL('../../../.data/uploads', import.meta.url)),
)

const target = new URL(process.env.DATABASE_URL!)
const databaseName = decodeURIComponent(target.pathname.replace(/^\//, ''))
const isLocal = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(target.hostname)

const { manifest } = bundle!
console.log(
  `Bunt: ${basename(file)}, laget ${manifest.createdAt.slice(0, 10)}, skjemaversjon ${manifest.schemaVersion}`,
)
console.log(
  `  ${manifest.counts.companies} selskaper, ${manifest.counts.articles} saker i media, ${manifest.counts.logos} logoer, ` +
    `${manifest.counts.people} personer, ${manifest.counts.photos} profilbilder, ${manifest.counts.quotes} sitater`,
)
console.log(`Database: ${target.host}/${databaseName}${isLocal ? ' (lokal)' : ''}`)
console.log(`Lagring: ${describeStorage(storageConfig)}`)
console.log(
  `Valg: ${describeDatasetOptions(options).join(', ') || 'alt'} (fødselsdatoer importeres aldri)`,
)
for (const warning of bundle!.warnings) console.log(`  NB: ${warning}`)

const labels: Record<DatasetEntity, string> = {
  companies: 'Selskaper',
  logos: 'Logoer',
  events: 'Historikk',
  articles: 'I media',
  people: 'Personer',
  photos: 'Profilbilder',
  quotes: 'Sitater',
  sources: 'Kilder (felt)',
}

function print(report: DatasetImportReport, heading: string) {
  const cell = (v: string | number, width: number) => String(v).padStart(width)
  console.log(`\n${heading}`)
  console.log(
    `  ${''.padEnd(15)}${cell('nye', 7)}${cell('endret', 9)}${cell('uendret', 10)}${cell('hoppet over', 14)}`,
  )
  for (const entity of datasetEntities) {
    const c = report.counts[entity]
    if (!c.created && !c.updated && !c.unchanged && !c.skipped) continue
    console.log(
      `  ${labels[entity].padEnd(15)}${cell(c.created, 7)}${cell(c.updated, 9)}${cell(c.unchanged, 10)}${cell(c.skipped, 14)}`,
    )
  }
  const m = report.matching
  if (m.byEmail + m.byName + m.byEarlierImport + m.created > 0) {
    console.log(
      `\n  Personer kjent igjen: ${m.byEmail} på e-post, ${m.byName} på navn og kull, ` +
        `${m.byEarlierImport} fra en tidligere import; ${m.created} nye profiler.`,
    )
    console.log(
      `  ${m.claimed} har tatt i bruk profilen sin, og røres ikke (står som hoppet over).`,
    )
  }
  if (report.warnings.length) {
    console.log(`\nÅ se på:\n${report.warnings.map((w) => `  - ${w}`).join('\n')}`)
  }
}

async function confirmDatabase() {
  if (isLocal) return
  if (values.bekreft !== undefined) {
    if (values.bekreft !== databaseName)
      fail(`--bekreft «${values.bekreft}» er ikke «${databaseName}». Avbrutt.`)
    return
  }
  if (!process.stdin.isTTY) {
    fail(
      `Databasen er ikke lokal. Kjør i en terminal for å bekrefte, eller bruk --bekreft ${databaseName}.`,
    )
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(
    `\nDu skriver til ${target.host}/${databaseName}. Skriv navnet på databasen for å fortsette: `,
  )
  rl.close()
  if (answer.trim() !== databaseName) fail('Navnet var ikke likt. Avbrutt; ingenting er skrevet.')
}

const db = createDb(process.env.DATABASE_URL!)
const label = basename(file)
try {
  console.log('\nKjører forhåndsvisningen (i en transaksjon som rulles tilbake) …')
  const preview = await previewDatasetImport(db, bundle!, options, label)
  print(preview.report, 'Forhåndsvisning:')

  if (!values.apply) {
    console.log(
      '\nForhåndsvisning. Ingenting er skrevet. Kjør på nytt med --apply for å importere.',
    )
  } else if (changesIn(preview.report) === 0) {
    console.log('\nIngenting å importere: databasen har alt fra bunten.')
  } else {
    await confirmDatabase()
    console.log(`\nImporterer til ${target.host}/${databaseName} …`)
    const report = await applyDatasetImport(
      db,
      createStorage(storageConfig),
      bundle!,
      options,
      label,
      preview.images,
    )
    print(report, 'Importert:')
    console.log('\nFerdig. Husk å slette bunten; den inneholder persondata.')
  }
} catch (error) {
  console.error(
    `\nImporten feilet, og ingenting er lagret: ${error instanceof Error ? error.message : error}`,
  )
  process.exitCode = 1
} finally {
  await db.close()
}
