import emojibase from 'emojibase-data/nb/data.json' with { type: 'json' }
import { describe, expect, it } from 'vitest'
import { isReactionEmoji, MAX_REACTIONS_PER_COMMENT } from '@esaf/core'
import {
  commentThreads,
  maxReactions,
  quickReactions,
  quickReactionsFor,
  toggleReaction,
} from '../src/lib/comments.ts'
import { supportedEmoji } from '../scripts/emoji-data.ts'

const c = (id: string, parentId: string | null = null) => ({ id, parentId })

describe('commentThreads', () => {
  it('samler svarene under kommentaren, i rekkefølge', () => {
    const threads = commentThreads([c('a'), c('b'), c('a1', 'a'), c('b1', 'b'), c('a2', 'a')])
    expect(threads.map((t) => [t.root?.id, t.replies.map((r) => r.id)])).toEqual([
      ['a', ['a1', 'a2']],
      ['b', ['b1']],
    ])
  })

  it('beholder svarene når kommentaren er slettet', () => {
    const threads = commentThreads([c('a'), c('x1', 'x'), c('b')])
    expect(threads.map((t) => t.id)).toEqual(['a', 'x', 'b'])
    expect(threads[1]).toEqual({ id: 'x', root: null, replies: [c('x1', 'x')] })
  })
})

describe('toggleReaction', () => {
  const like = { emoji: '👍', count: 1, viewerReacted: false, people: ['Kari'] }

  it('legger til, øker og tar bort', () => {
    expect(toggleReaction([], '❤️', 'Ola')).toEqual([
      { emoji: '❤️', count: 1, viewerReacted: true, people: ['Ola'] },
    ])
    const mine = toggleReaction([like], '👍', 'Ola')
    expect(mine).toEqual([{ emoji: '👍', count: 2, viewerReacted: true, people: ['Kari', 'Ola'] }])
    expect(toggleReaction(mine, '👍', 'Ola')).toEqual([
      { emoji: '👍', count: 1, viewerReacted: false, people: ['Kari'] },
    ])
    expect(toggleReaction(toggleReaction([], '👍', 'Ola'), '👍', 'Ola')).toEqual([])
  })
})

describe('quickReactionsFor', () => {
  const emoji = (favorites: string[]) => quickReactionsFor(favorites).map((r) => r.emoji)

  it('gir standardene til den som ikke har reagert', () => {
    expect(quickReactionsFor([])).toEqual(quickReactions)
  })

  it('setter det personen bruker mest først, og fyller med standardene', () => {
    expect(emoji(['🦄', '🎉'])).toEqual(['🦄', '🎉', '👍', '❤️', '😂'])
  })

  it('har alltid like mange, og navn på standardene', () => {
    expect(emoji(['🦄', '🐙', '🌮', '🚀', '🔥'])).toEqual(['🦄', '🐙', '🌮', '🚀', '🔥'])
    expect(quickReactionsFor(['❤️'])[0]).toEqual({ emoji: '❤️', label: 'Hjerte' })
    expect(quickReactionsFor(['🦄'])[0]).toEqual({ emoji: '🦄', label: '🦄' })
  })
})

describe('emoji i reaksjoner', () => {
  it('har snarveier serveren godtar, og samme tak som serveren', () => {
    expect(quickReactions.every((r) => isReactionEmoji(r.emoji))).toBe(true)
    expect(maxReactions).toBe(MAX_REACTIONS_PER_COMMENT)
  })

  it('tilbyr i velgeren bare emoji serveren godtar, med hudfarger', () => {
    const emoji = supportedEmoji([
      { emoji: '👋', group: 1, skins: [{ emoji: '👋🏽' }, { emoji: '👋x' }] },
      { emoji: 'x', group: 1, skins: [{ emoji: '👍' }] },
      { emoji: '🏻' },
    ])
    expect(emoji).toEqual([{ emoji: '👋', group: 1, skins: [{ emoji: '👋🏽' }] }, { emoji: '🏻' }])
  })

  it('beholder nesten alt i Emojibase', () => {
    const all = emojibase.filter((e) => 'group' in e)
    const kept = supportedEmoji(all)
    expect(kept.length / all.length).toBeGreaterThan(0.95)
  })
})
