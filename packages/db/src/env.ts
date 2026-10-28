import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Leser repo-rotens .env for lokale verktøy (migrering, drizzle-kit, admin-CLI).
 * Variabler som allerede er satt i miljøet vinner. I produksjon finnes normalt ingen .env.
 */
export function loadRootEnv() {
  const path = fileURLToPath(new URL('../../../.env', import.meta.url))
  if (existsSync(path)) process.loadEnvFile(path)
}
