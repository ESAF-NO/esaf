import { createGifSearch, DomainError } from '@esaf/core'
import { env } from './env.server.ts'

/** GIF-søket, eller null uten nøkkel. Da vises ingen knapp; GIF-er kan fortsatt lastes opp. */
export const gifs = env.GIPHY_API_KEY ? createGifSearch(env.GIPHY_API_KEY) : null

export function requireGifs() {
  if (!gifs) throw new DomainError('GIF-søket er ikke slått på.')
  return gifs
}
