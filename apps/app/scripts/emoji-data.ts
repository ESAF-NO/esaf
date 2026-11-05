/**
 * Legger emoji-dataene til reaksjonsvelgeren i public/, så velgeren henter dem fra
 * appen og ikke fra et CDN. Bare emoji serveren godtar er med: Emojibase kan være
 * nyere enn Unicode-versjonen i Node, og da skal velgeren ikke tilby dem ennå.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isReactionEmoji } from '../../../packages/core/src/reactions.ts'

type Emoji = { emoji: string; skins?: { emoji: string }[] }

export function supportedEmoji<T extends Emoji>(list: T[]): T[] {
  return list
    .filter((e) => isReactionEmoji(e.emoji) || !('group' in e))
    .map((e) => (e.skins ? { ...e, skins: e.skins.filter((s) => isReactionEmoji(s.emoji)) } : e))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const source = dirname(createRequire(import.meta.url).resolve('emojibase-data/nb/data.json'))
  const target = fileURLToPath(new URL('../public/emoji/nb/', import.meta.url))
  mkdirSync(target, { recursive: true })
  const data = JSON.parse(readFileSync(join(source, 'data.json'), 'utf8')) as Emoji[]
  writeFileSync(join(target, 'data.json'), JSON.stringify(supportedEmoji(data)))
  copyFileSync(join(source, 'messages.json'), join(target, 'messages.json'))
}
