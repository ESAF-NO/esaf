import { definePlugin } from 'nitro'

/** Hvor ofte merkene regnes ut, og hvor lenge etter oppstart det skjer første gang. */
const INTERVAL_MS = 5 * 60 * 1000
const FIRST_RUN_MS = 60 * 1000

/**
 * Holder merkene med regel oppdatert mens serveren kjører: endringer admins gjør
 * i arrangementer, styret, kull og selskaper gir eller tar merker innen noen
 * minutter. Det man gjør selv («Jeg var der»), oppdateres med en gang. Reglene
 * ligger i `syncBadges` i @esaf/core. Tidtakerne holder ikke prosessen i live.
 */
export default definePlugin(() => {
  let running = false
  async function run() {
    // En treg runde skal ikke få en ny til å starte oppå seg.
    if (running) return
    running = true
    try {
      const [{ syncBadges }, { db }] = await Promise.all([
        import('@esaf/core'),
        import('../db.server.ts'),
      ])
      const result = await syncBadges(db)
      if (result.awarded.length || result.removed) {
        console.info(
          `[esaf/app] Merker oppdatert: ${result.awarded.length} delt ut, ${result.removed} fjernet.`,
        )
      }
    } catch (error) {
      console.error('[esaf/app] Oppdateringen av merker feilet:', error)
    } finally {
      running = false
    }
  }
  setTimeout(() => {
    void run()
    setInterval(() => void run(), INTERVAL_MS).unref()
  }, FIRST_RUN_MS).unref()
})
