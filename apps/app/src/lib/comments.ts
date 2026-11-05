import type { CommentReactionKind } from '@esaf/db'

/** Reaksjonene på en kommentar, i rekkefølgen de vises. */
export const reactions: { kind: CommentReactionKind; emoji: string; label: string }[] = [
  { kind: 'like', emoji: '👍', label: 'Liker' },
  { kind: 'heart', emoji: '❤️', label: 'Hjerte' },
  { kind: 'laugh', emoji: '😂', label: 'Ler' },
  { kind: 'party', emoji: '🎉', label: 'Feirer' },
  { kind: 'eyes', emoji: '👀', label: 'Følger med' },
]

export const reactionKinds = ['like', 'heart', 'laugh', 'party', 'eyes'] as const

type Reaction = {
  kind: CommentReactionKind
  count: number
  viewerReacted: boolean
  people: string[]
}

/** Reaksjonene etter at den innloggede har trykket, før serveren har svart. */
export function toggleReaction<T extends Reaction>(
  list: T[],
  kind: CommentReactionKind,
  name: string,
): Reaction[] {
  const current = list.find((r) => r.kind === kind)
  if (!current) return [...list, { kind, count: 1, viewerReacted: true, people: [name] }]
  if (!current.viewerReacted) {
    return list.map((r) =>
      r === current
        ? { ...r, count: r.count + 1, viewerReacted: true, people: [...r.people, name] }
        : r,
    )
  }
  return list.flatMap((r) => {
    if (r !== current) return [r]
    if (r.count <= 1) return []
    return [
      {
        ...r,
        count: r.count - 1,
        viewerReacted: false,
        people: r.people.filter((p) => p !== name),
      },
    ]
  })
}

export type CommentThread<T> = {
  id: string
  /** Null når kommentaren øverst i tråden er slettet, men svarene står. */
  root: T | null
  replies: T[]
}

/**
 * Deler en flat liste, eldste først, i tråder. Trådene står der den øverste
 * kommentaren står; er den slettet, der det første svaret står.
 */
export function commentThreads<T extends { id: string; parentId: string | null }>(
  comments: T[],
): CommentThread<T>[] {
  const threads = new Map<string, CommentThread<T>>()
  for (const comment of comments) {
    const id = comment.parentId ?? comment.id
    const thread = threads.get(id) ?? { id, root: null, replies: [] }
    threads.set(id, thread)
    if (comment.parentId) thread.replies.push(comment)
    else thread.root = comment
  }
  return [...threads.values()]
}
