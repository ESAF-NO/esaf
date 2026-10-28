import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema.ts'

export function createDb(connectionString: string) {
  const pool = new Pool({ connectionString, max: 10 })
  const db = drizzle({ client: pool, schema, casing: 'snake_case' })
  return Object.assign(db, { close: () => pool.end() })
}

export type Db = ReturnType<typeof createDb>

/** Enkel tilkoblingssjekk for helseendepunkt. */
export async function pingDatabase(db: Db) {
  await db.execute(sql`select 1`)
}
