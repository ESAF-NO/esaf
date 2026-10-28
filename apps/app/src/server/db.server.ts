import { createDb, type Db } from '@esaf/db'
import { env } from './env.server.ts'

const globalForDb = globalThis as unknown as { esafDb?: Db }

// Gjenbruk samme pool ved hot reload i utvikling.
export const db = (globalForDb.esafDb ??= createDb(env.DATABASE_URL))
