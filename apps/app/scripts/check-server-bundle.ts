/**
 * Kjøres etter `vite build`: stopper bygget om serverbundelen har mer enn én
 * kopi av Better Auths `APIError`.
 *
 * Pluginene (passkey, OAuth) sjekker feil med `instanceof APIError`. Får de en
 * annen kopi av klassen enn den appen kaster med, blir alle våre egne feil til
 * en generell feil. Det skjedde i produksjon: en passkey uten PIN eller
 * fingeravtrykk ga «AUTHENTICATION_FAILED» i stedet for riktig melding, mens
 * testene, som ikke bruker bundelen, var grønne. Se `ssr.noExternal` i
 * vite.config.ts.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('../.output/server', import.meta.url).pathname
const copies = readdirSync(root, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.mjs'))
  .flatMap((file) => {
    const matches = readFileSync(join(root, file), 'utf8').match(/class APIError extends/g)
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
