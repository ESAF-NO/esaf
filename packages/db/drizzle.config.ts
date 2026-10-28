import { defineConfig } from 'drizzle-kit'
import { loadRootEnv } from './src/env.ts'

loadRootEnv()

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  casing: 'snake_case',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://esaf:esaf_local_dev@localhost:5432/esaf',
  },
})
