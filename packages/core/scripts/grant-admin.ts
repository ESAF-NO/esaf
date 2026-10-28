/**
 * Førstegangs (og senere) tildeling av adminrolle. Krever en lokal operatør med
 * databasetilgang, en eksisterende konto med bekreftet e-post, og at e-posten
 * gjentas som bekreftelse. Se README, «Første admin».
 *
 *   pnpm admin:grant --email navn@example.com --reason "Styreleder 2026"
 */
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { createDb, loadRootEnv } from '@esaf/db'
import { DomainError, grantAdminAsOperator } from '../src/index.ts'

loadRootEnv()

const { values } = parseArgs({
  options: { email: { type: 'string' }, reason: { type: 'string' } },
})

if (!values.email || !values.reason) {
  console.error('Bruk: pnpm admin:grant --email <e-post> --reason "<begrunnelse>"')
  process.exit(1)
}
if (!process.env.DATABASE_URL) {
  console.error('Mangler DATABASE_URL.')
  process.exit(1)
}
if (!process.stdin.isTTY) {
  console.error('Må kjøres interaktivt i en terminal av en operatør.')
  process.exit(1)
}

const target = new URL(process.env.DATABASE_URL)
const rl = createInterface({ input: process.stdin, output: process.stdout })
console.log(`Database: ${target.host}${target.pathname}`)
const confirmation = await rl.question(
  `Skriv e-posten på nytt for å gi ${values.email} adminrolle: `,
)
rl.close()
if (confirmation.trim().toLowerCase() !== values.email.trim().toLowerCase()) {
  console.error('E-postene var ikke like. Avbrutt.')
  process.exit(1)
}

const db = createDb(process.env.DATABASE_URL)
try {
  const result = await grantAdminAsOperator(db, { email: values.email, reason: values.reason })
  console.log(`${result.fullName} er nå aktivt medlem med adminrolle.`)
} catch (error) {
  if (error instanceof DomainError) {
    console.error(error.message)
    process.exitCode = 1
  } else {
    throw error
  }
} finally {
  await db.close()
}
