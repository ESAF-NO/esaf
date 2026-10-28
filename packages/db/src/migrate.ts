import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { createDb } from './client.ts'
import { loadRootEnv } from './env.ts'

/**
 * Kjører genererte SQL-migreringer fra ./drizzle. Brukes både lokalt og i
 * produksjon (som eget steg før appen startes). Appen gjør aldri schema-push.
 */
export async function runMigrations(connectionString: string) {
  const db = createDb(connectionString)
  try {
    await migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) })
  } finally {
    await db.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadRootEnv()
  const url =
    process.argv[2] === '--test' ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL
  if (!url) {
    console.error('Mangler DATABASE_URL (eller TEST_DATABASE_URL med --test). Se .env.example.')
    process.exit(1)
  }
  await runMigrations(url)
  console.log(`Migreringer kjørt mot ${new URL(url).pathname.slice(1)}.`)
}
