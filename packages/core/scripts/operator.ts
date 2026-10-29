/** Felles for skriptene som lager lenker fra kommandolinjen. */
import { createInterface } from 'node:readline/promises'

/** Rollene slik de skrives på kommandolinjen. */
export const operatorRoles = {
  hovedadmin: 'owner',
  admin: 'admin',
  moderator: 'moderator',
  medlem: 'member',
} as const

/**
 * Adressen lenkene peker til: `--url`, ellers `BETTER_AUTH_URL`. Må være
 * appens egen adresse, ellers virker ikke passkeys etterpå.
 */
export function linkBase(url: string | undefined): URL {
  const value = url ?? process.env.BETTER_AUTH_URL
  if (!value || !URL.canParse(value)) {
    console.error(
      'Mangler appens adresse. Sett BETTER_AUTH_URL eller bruk --url https://app.esaf.no.',
    )
    process.exit(1)
  }
  return new URL(value)
}

/**
 * Viser databasen og krever at e-posten skrives inn på nytt, i en interaktiv
 * terminal. Avslutter ellers.
 */
export async function confirmOperator(email: string, action: string) {
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
  const confirmation = await rl.question(`Skriv e-posten på nytt for å ${action}: `)
  rl.close()
  if (confirmation.trim().toLowerCase() !== email.trim().toLowerCase()) {
    console.error('E-postene var ikke like. Avbrutt.')
    process.exit(1)
  }
}

/** Skriver ut lenken. Den lagres ikke noe sted og kan ikke hentes fram igjen. */
export function printLink(url: URL, expiresAt: Date, lines: string[]) {
  const until = expiresAt.toLocaleString('nb-NO', { timeZone: 'Europe/Oslo' })
  console.log('')
  for (const line of lines) console.log(line)
  console.log(`Gjelder til ${until}. Lenken vises bare nå; lag en ny om den blir borte.`)
  console.log('')
  console.log(url.href)
  console.log('')
}
