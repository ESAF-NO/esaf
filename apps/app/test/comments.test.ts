import { describe, expect, it } from 'vitest'
import { commentThreads, reactionKinds, reactions, toggleReaction } from '../src/lib/comments.ts'

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
  const like = { kind: 'like' as const, count: 1, viewerReacted: false, people: ['Kari'] }

  it('legger til, øker og tar bort', () => {
    expect(toggleReaction([], 'heart', 'Ola')).toEqual([
      { kind: 'heart', count: 1, viewerReacted: true, people: ['Ola'] },
    ])
    const mine = toggleReaction([like], 'like', 'Ola')
    expect(mine).toEqual([{ kind: 'like', count: 2, viewerReacted: true, people: ['Kari', 'Ola'] }])
    expect(toggleReaction(mine, 'like', 'Ola')).toEqual([
      { kind: 'like', count: 1, viewerReacted: false, people: ['Kari'] },
    ])
    expect(toggleReaction(toggleReaction([], 'like', 'Ola'), 'like', 'Ola')).toEqual([])
  })
})

it('har et tegn for hver reaksjon', () => {
  expect(reactions.map((r) => r.kind)).toEqual([...reactionKinds])
})
