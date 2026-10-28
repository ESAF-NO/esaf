// Sjekker at det statiske Astro-bygget ikke inneholder serverhemmeligheter,
// tilkoblingsstrenger, appkode eller e-postadresser som ikke er godkjent for publisering.
// Kjøres etter `pnpm build` (lokalt og i CI): pnpm verify:site
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const dist = join(root, 'apps/site/dist')
if (!existsSync(join(dist, 'index.html'))) {
  console.error('Fant ikke apps/site/dist/index.html. Kjør `pnpm build` først.')
  process.exit(1)
}

const forbidden = [
  [/postgres(ql)?:\/\//i, 'database-URL'],
  [/DATABASE_URL|BETTER_AUTH_SECRET|TEST_DATABASE_URL/, 'navn på servervariabel'],
  [/@esaf\/(db|core)|drizzle|better-auth/i, 'kode fra appen eller databasepakken'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'privat nøkkel'],
  [/\b(sk|pk)_(live|test)_[A-Za-z0-9]{10,}/, 'API-nøkkel'],
]

// Faktiske verdier fra lokal .env eller CI-miljøet skal aldri finnes i bygget.
const secretValues = new Set()
const envFile = join(root, '.env')
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const value = line.split('=').slice(1).join('=').trim()
    if (value.length >= 12) secretValues.add(value)
  }
}
for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL', 'BETTER_AUTH_SECRET']) {
  if (process.env[key]) secretValues.add(process.env[key])
}

const { siteConfig } = await import(join(root, 'apps/site/src/site.config.ts'))
const allowedEmails = new Set([siteConfig.contactEmail].filter(Boolean))

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* walk(path)
    else yield path
  }
}

const problems = []
let checked = 0
for (const file of walk(dist)) {
  if (!/\.(html|js|css|txt|xml|json|svg|map)$/.test(file)) continue
  checked++
  const text = readFileSync(file, 'utf8')
  const rel = relative(root, file)
  for (const [pattern, label] of forbidden) {
    if (pattern.test(text)) problems.push(`${rel}: inneholder ${label}`)
  }
  for (const value of secretValues) {
    if (text.includes(value)) problems.push(`${rel}: inneholder en verdi fra miljøvariablene`)
  }
  for (const email of text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? []) {
    if (!allowedEmails.has(email)) problems.push(`${rel}: ukjent e-postadresse ${email}`)
  }
}

if (problems.length) {
  console.error(
    `Fant ${problems.length} problem(er) i det statiske bygget:\n- ${problems.join('\n- ')}`,
  )
  process.exit(1)
}
console.log(
  `OK: ${checked} filer i apps/site/dist sjekket, ingen hemmeligheter eller appdata funnet.`,
)
