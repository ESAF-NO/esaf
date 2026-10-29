/**
 * Lager en lenke for nytt passord fra kommandolinjen, for når ingen admin kan
 * gjøre det i appen (for eksempel den eneste hovedadmin). Lenken virker én gang
 * i sju dager. Alle økter logges ut når den brukes; tofaktor og passkeys røres
 * ikke. Se README, «Første hovedadmin».
 *
 *   pnpm admin:password-link --email navn@example.com --reason "Glemt passord"
 */
import { parseArgs } from 'node:util'
import { createDb, loadRootEnv } from '@esaf/db'
import { createPasswordResetLinkAsOperator, DomainError } from '../src/index.ts'
import { confirmOperator, linkBase, printLink } from './operator.ts'

loadRootEnv()

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    reason: { type: 'string' },
    url: { type: 'string' },
  },
})

if (!values.email || !values.reason) {
  console.error(
    'Bruk: pnpm admin:password-link --email <e-post> --reason "<begrunnelse>" [--url https://app.esaf.no]',
  )
  process.exit(1)
}
const base = linkBase(values.url)
await confirmOperator(values.email, `lage en lenke for nytt passord til ${values.email}`)

const db = createDb(process.env.DATABASE_URL!)
try {
  const link = await createPasswordResetLinkAsOperator(db, {
    email: values.email,
    reason: values.reason,
  })
  printLink(new URL(`/nytt-passord/${link.token}`, base), link.expiresAt, [
    `Lenke for nytt passord til ${link.fullName} (${link.email}).`,
  ])
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
