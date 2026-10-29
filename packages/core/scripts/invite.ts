/**
 * Lager en invitasjon fra kommandolinjen og skriver ut lenken. Slik kommer den
 * første hovedadmin inn i produksjon, uten e-post: kjør skriptet i appens
 * terminal i Coolify, og åpne lenken selv. Etter det inviterer admins i appen.
 * Krever en lokal operatør med databasetilgang, og at e-posten gjentas som
 * bekreftelse. Se README, «Første hovedadmin».
 *
 *   pnpm admin:invite --email navn@example.com
 *   pnpm admin:invite --email navn@example.com --rolle admin --profil <personId>
 *   pnpm admin:invite --email navn@example.com --url https://app.esaf.no
 */
import { parseArgs } from 'node:util'
import { createDb, loadRootEnv } from '@esaf/db'
import { createInvitationAsOperator, DomainError } from '../src/index.ts'
import { confirmOperator, linkBase, operatorRoles, printLink } from './operator.ts'

loadRootEnv()

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    rolle: { type: 'string', default: 'hovedadmin' },
    profil: { type: 'string' },
    url: { type: 'string' },
    reason: { type: 'string' },
  },
})

const role = operatorRoles[values.rolle as keyof typeof operatorRoles]
if (!values.email || !role) {
  console.error(
    'Bruk: pnpm admin:invite --email <e-post> [--rolle hovedadmin|admin|moderator|medlem] [--profil <personId>] [--url https://app.esaf.no] [--reason "<begrunnelse>"]',
  )
  process.exit(1)
}
const base = linkBase(values.url)
await confirmOperator(values.email, `invitere ${values.email} som ${values.rolle}`)

const db = createDb(process.env.DATABASE_URL!)
try {
  const link = await createInvitationAsOperator(db, {
    email: values.email,
    role,
    personId: values.profil ?? null,
    reason: values.reason,
  })
  printLink(new URL(`/invitasjon/${link.token}`, base), link.expiresAt, [
    `Invitasjon til ${link.email} som ${values.rolle}.`,
    'Lenken virker én gang. Den som åpner den, velger passord eller passkey og er inne.',
  ])
  if (role === 'owner' || role === 'admin') {
    console.log(
      'Adminrettighetene kan brukes når personen logger inn med passkey eller har tofaktor (se «Konto og sikkerhet»).',
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
