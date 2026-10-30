import { definePlugin } from 'nitro'

/** Hvor ofte oppryddingen kjører, og hvor lenge etter oppstart den kjører første gang. */
const INTERVAL_MS = 60 * 60 * 1000
const FIRST_RUN_MS = 2 * 60 * 1000

/**
 * Rydder i vedleggene jevnlig mens serveren kjører: filer som aldri ble festet
 * til et innlegg eller en kommentar (eldre enn et døgn), filer der forelderen er
 * slettet, og filer som ikke lot seg slette fra lagringen før. Reglene ligger i
 * `cleanupAssets` i @esaf/core. Tidtakerne holder ikke prosessen i live.
 */
export default definePlugin(() => {
  async function run() {
    try {
      const [{ cleanupAssets }, { db }, { storage }] = await Promise.all([
        import('@esaf/core'),
        import('../db.server.ts'),
        import('../photos.server.ts'),
      ])
      const result = await cleanupAssets(db, storage)
      if (result.deleted || result.purged) {
        console.info(
          `[esaf/app] Vedlegg ryddet: ${result.deleted} slettet, ${result.purged} fjernet fra lagringen.`,
        )
      }
    } catch (error) {
      console.error('[esaf/app] Oppryddingen av vedlegg feilet:', error)
    }
  }
  setTimeout(() => {
    void run()
    setInterval(() => void run(), INTERVAL_MS).unref()
  }, FIRST_RUN_MS).unref()
})
