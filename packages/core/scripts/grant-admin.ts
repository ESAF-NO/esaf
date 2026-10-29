/**
 * Gir en rolle fra kommandolinjen. Brukes til første hovedadmin; etter det gir
 * hovedadmins roller i appen. Krever en lokal operatør med databasetilgang, en
 * eksisterende konto med bekreftet e-post, og at e-posten gjentas som
 * bekreftelse. Se README, «Første hovedadmin».
 *
 *   pnpm admin:grant --email navn@example.com --reason "Styreleder 2026"
 *   pnpm admin:grant --email navn@example.com --reason "…" --rolle admin
 */
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { createDb, loadRootEnv } from '@esaf/db'
import { DomainError, grantRoleAsOperator } from '../src/index.ts'

loadRootEnv()

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    reason: { type: 'string' },
    rolle: { type: 'string', default: 'hovedadmin' },
  },
})

const roleNames = { hovedadmin: 'owner', admin: 'admin', moderator: 'moderator' } as const
const role = roleNames[values.rolle as keyof typeof roleNames]
if (!values.email || !values.reason || !role) {
  console.error(
    'Bruk: pnpm admin:grant --email <e-post> --reason "<begrunnelse>" [--rolle hovedadmin|admin|moderator]',
  )
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
  `Skriv e-posten på nytt for å gi ${values.email} rollen ${values.rolle}: `,
)
rl.close()
if (confirmation.trim().toLowerCase() !== values.email.trim().toLowerCase()) {
  console.error('E-postene var ikke like. Avbrutt.')
  process.exit(1)
}

const db = createDb(process.env.DATABASE_URL)
try {
  const result = await grantRoleAsOperator(db, {
    email: values.email,
    reason: values.reason,
    role,
  })
  console.log(`${result.fullName} er nå aktivt medlem med rollen ${values.rolle}.`)
  if (role !== 'moderator') {
    console.log(
      'Rollen kan brukes når personen logger inn med passkey eller har tofaktor (se «Konto og sikkerhet»).',
    )
  }
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
