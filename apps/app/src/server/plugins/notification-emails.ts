import { definePlugin } from 'nitro'

/** Hvor ofte varsler sendes på e-post, og hvor lenge etter oppstart det skjer første gang. */
const INTERVAL_MS = 60 * 1000
const FIRST_RUN_MS = 90 * 1000
const PRUNE_INTERVAL_MS = 60 * 60 * 1000

/**
 * Sender varsler på e-post mens serveren kjører, etter hva hvert medlem har valgt
 * (med en gang, daglig eller ukentlig). Reglene ligger i `sendNotificationEmails`
 * i @esaf/core; en lås i databasen gjør at to servere (under en deploy) aldri
 * sender det samme. Uten e-postleverandør gjøres ingenting. Én gang i timen
 * slettes e-postloggen eldre enn ett år. Tidtakerne holder ikke prosessen i live.
 */
export default definePlugin(() => {
  let running = false
  let prunedAt = 0
  async function run() {
    if (running) return
    running = true
    try {
      const [{ pruneEmailLog, sendNotificationEmails }, { db }, { mailer }, { env }] =
        await Promise.all([
          import('@esaf/core'),
          import('../db.server.ts'),
          import('../email.server.ts'),
          import('../env.server.ts'),
        ])
      if (Date.now() - prunedAt > PRUNE_INTERVAL_MS) {
        prunedAt = Date.now()
        await pruneEmailLog(db)
      }
      if (!mailer) return
      const result = await sendNotificationEmails(db, {
        mailer,
        appUrl: env.BETTER_AUTH_URL,
        secret: env.BETTER_AUTH_SECRET,
      })
      if (result.emails || result.failed) {
        console.info(
          `[esaf/varsler] E-post: ${result.emails} sendt (${result.notifications} ${result.notifications === 1 ? 'varsel' : 'varsler'}), ${result.failed} feilet.`,
        )
      }
    } catch (error) {
      console.error('[esaf/varsler] Utsendingen av varsler på e-post feilet:', error)
    } finally {
      running = false
    }
  }
  setTimeout(() => {
    void run()
    setInterval(() => void run(), INTERVAL_MS).unref()
  }, FIRST_RUN_MS).unref()
})
