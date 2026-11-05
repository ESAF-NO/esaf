/** Snarveiene for den som ikke har reagert ennå. Alle andre emoji ligger i velgeren. */
export const quickReactions = [
  { emoji: '👍', label: 'Liker' },
  { emoji: '❤️', label: 'Hjerte' },
  { emoji: '😂', label: 'Ler' },
  { emoji: '🎉', label: 'Feirer' },
  { emoji: '👀', label: 'Følger med' },
]

/** Snarveiene til en person: det de bruker mest, og standardene på de ledige plassene. */
export function quickReactionsFor(favorites: string[]) {
  const emoji = new Set([...favorites, ...quickReactions.map((r) => r.emoji)])
  return [...emoji]
    .slice(0, quickReactions.length)
    .map((e) => quickReactions.find((r) => r.emoji === e) ?? { emoji: e, label: e })
}

/** Samme tak som `MAX_REACTIONS_PER_COMMENT` i @esaf/core, som ikke kan brukes i nettleseren. */
export const maxReactions = 20

type Reaction = {
  emoji: string
  count: number
  viewerReacted: boolean
  people: string[]
}

/** Reaksjonene etter at den innloggede har trykket, før serveren har svart. */
export function toggleReaction<T extends Reaction>(
  list: T[],
  emoji: string,
  name: string,
): Reaction[] {
  const current = list.find((r) => r.emoji === emoji)
  if (!current) return [...list, { emoji, count: 1, viewerReacted: true, people: [name] }]
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
