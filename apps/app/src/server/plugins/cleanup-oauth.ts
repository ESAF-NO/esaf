import { definePlugin } from 'nitro'

/** Hvor ofte oppryddingen kjører, og hvor lenge etter oppstart den kjører første gang. */
const INTERVAL_MS = 60 * 60 * 1000
const FIRST_RUN_MS = 3 * 60 * 1000

/**
 * Rydder i OAuth-tabellene for MCP-klienter jevnlig mens serveren kjører:
 * utløpte nøkler, og klienter som registrerte seg uten å bli godkjent (eldre enn
 * et døgn). Reglene ligger i `pruneOAuth` i @esaf/core. Tidtakerne holder ikke
 * prosessen i live.
 */
export default definePlugin(() => {
  async function run() {
    try {
      const [{ pruneOAuth }, { db }] = await Promise.all([
        import('@esaf/core'),
        import('../db.server.ts'),
      ])
      const result = await pruneOAuth(db)
      if (result.accessTokens || result.refreshTokens || result.clients) {
        console.info(
          `[esaf/app] OAuth ryddet: ${result.accessTokens} tilgangsnøkler, ${result.refreshTokens} fornyelsesnøkler, ${result.clients} klienter.`,
        )
      }
    } catch (error) {
      console.error('[esaf/app] Oppryddingen av OAuth feilet:', error)
    }
  }
  setTimeout(() => {
    void run()
    setInterval(() => void run(), INTERVAL_MS).unref()
  }, FIRST_RUN_MS).unref()
})
