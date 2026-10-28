import { definePlugin } from 'nitro'

/**
 * Nitro-plugins kjøres én gang når serveren starter. Ved å validere miljøet her
 * stopper produksjonsserveren med en tydelig feil i stedet for å starte og
 * deretter feile ved første forespørsel.
 */
export default definePlugin(async () => {
  try {
    await import('../env.server.ts')
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
})
