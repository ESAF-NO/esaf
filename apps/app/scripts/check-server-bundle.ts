/**
 * Kjøres etter `vite build`: stopper bygget om serverbundelen har mer enn én
 * kopi av Better Auths `APIError`, eller peker på CSS klientbygget ikke har laget.
 *
 * Pluginene (passkey, OAuth) sjekker feil med `instanceof APIError`. Får de en
 * annen kopi av klassen enn den appen kaster med, blir alle våre egne feil til
 * en generell feil. Det skjedde i produksjon: en passkey uten PIN eller
 * fingeravtrykk ga «AUTHENTICATION_FAILED» i stedet for riktig melding, mens
 * testene, som ikke bruker bundelen, var grønne. Se `ssr.noExternal` i
 * vite.config.ts.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('../.output/server', import.meta.url).pathname
const publicDir = new URL('../.output/public', import.meta.url).pathname
const bundles = readdirSync(root, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.mjs'))
  .map((file) => ({ file, code: readFileSync(join(root, file), 'utf8') }))

const copies = bundles.flatMap(({ file, code }) => {
  const matches = code.match(/class APIError extends/g)
  return matches ? matches.map(() => file) : []
})

if (copies.length !== 1) {
  console.error(
    `Serverbundelen har ${copies.length} kopier av Better Auths APIError, skal ha 1:\n` +
      copies.map((file) => `  ${file}`).join('\n') +
      '\nAlle better-auth-pakker må pakkes i samme omgang (ssr.noExternal i vite.config.ts).',
  )
  process.exit(1)
}
console.log('Serverbundelen har én kopi av Better Auths APIError.')

// Serveren og klienten bygges hver for seg. Fikk de ulike filnavn, pekte HTML-en på en
// CSS-fil som ikke fantes, og hele appen stod uten stil i produksjon.
const stylesheets = new Set(
  bundles.flatMap(({ code }) => code.match(/\/assets\/[\w.-]+\.css\b/g) ?? []),
)
const missing = [...stylesheets].filter((file) => !existsSync(join(publicDir, file)))
if (stylesheets.size === 0) {
  console.error('Fant ingen CSS-fil i serverbundelen. Har filnavnene endret form?')
  process.exit(1)
}
if (missing.length > 0) {
  console.error(
    `Serverbundelen peker på CSS som ikke finnes i klientbygget:\n` +
      missing.map((file) => `  ${file}`).join('\n'),
  )
  process.exit(1)
}
console.log('CSS-filene serverbundelen peker på, finnes i klientbygget.')
