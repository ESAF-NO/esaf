/**
 * Regelen for reaksjoner, uten andre avhengigheter: byggesteget som lager
 * emoji-dataene til velgeren (`apps/app/scripts/emoji-data.ts`) bruker den også, så
 * velgeren aldri tilbyr noe serveren avviser.
 */

/** Så mange av personens mest brukte emoji følger med et innlegg, til snarveiene. */
export const FAVORITE_REACTIONS = 5

/** Så mange ulike emoji kan en kommentar ha, så en rad ikke kan spammes full. */
export const MAX_REACTIONS_PER_COMMENT = 20

// Flagget v finnes ikke i TypeScript-målet vårt, men i Node 24.
const rgiEmoji = new RegExp('^\\p{RGI_Emoji}$', 'v')

/**
 * Akkurat én emoji i standardform. ❤ uten variantvelger er ikke godkjent, så samme
 * tegn aldri blir to ulike reaksjoner.
 */
export const isReactionEmoji = (value: string) => rgiEmoji.test(value)
