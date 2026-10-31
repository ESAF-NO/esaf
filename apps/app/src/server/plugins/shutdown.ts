import { definePlugin } from 'nitro'

/** Hvor lenge forespørsler som allerede er i gang, får til å bli ferdige. */
const GRACE_MS = 1500

/**
 * Avslutter prosessen raskt når containeren stoppes (SIGTERM), for eksempel når en
 * ny versjon tar over. Serveren slutter å ta imot nye tilkoblinger med en gang, men
 * ventet ellers til Docker drepte den etter ti sekunder. Så lenge prosessen lever,
 * sender proxyen fortsatt annenhver forespørsel hit, og de fikk 502. Nå får
 * forespørsler i gang litt tid, så avslutter prosessen, og proxyen slutter å sende
 * hit med en gang.
 */
export default definePlugin(() => {
  if (process.env.NODE_ENV !== 'production') return
  process.once('SIGTERM', () => {
    setTimeout(() => process.exit(0), GRACE_MS).unref()
  })
})
