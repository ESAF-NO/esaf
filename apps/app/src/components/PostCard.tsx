import type { Author, PostSummary } from '@esaf/core'
import { Link } from '@tanstack/react-router'
import { ArrowBigUp, ExternalLink, MessageCircle, Pin } from 'lucide-react'
import { useState } from 'react'
import { vote } from '#/lib/feed.functions.ts'
import { fullDate, timeAgo } from '#/lib/format.ts'
import { Avatar, ChannelBadge, cx, Verified } from './ui.tsx'

export function VoteButton({
  postId,
  votes,
  voted,
  layout = 'column',
}: {
  postId: string
  votes: number
  voted: boolean
  layout?: 'column' | 'row'
}) {
  const [state, setState] = useState({ votes, voted })
  const [busy, setBusy] = useState(false)

  async function toggle() {
    if (busy) return
    setBusy(true)
    // Optimistisk: oppdater med en gang, rett opp med svaret fra serveren.
    setState((s) => ({ voted: !s.voted, votes: s.votes + (s.voted ? -1 : 1) }))
    try {
      setState(await vote({ data: { postId } }))
    } catch {
      setState({ votes, voted })
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={state.voted}
      aria-label={state.voted ? 'Fjern stemme' : 'Stem opp'}
      className={cx(
        'relative z-10 flex shrink-0 items-center justify-center rounded-xl font-semibold tabular-nums transition ring-1 ring-inset',
        layout === 'column' ? 'h-14 w-12 flex-col text-sm' : 'h-9 gap-1 px-3 text-sm',
        state.voted
          ? 'bg-brand-50 text-brand-700 ring-brand-200'
          : 'bg-white text-stone-600 ring-stone-200 hover:bg-stone-50 hover:text-stone-900',
      )}
    >
      <ArrowBigUp
        className={cx('size-5', state.voted && 'fill-brand-500 text-brand-600')}
        aria-hidden
      />
      {state.votes}
    </button>
  )
}

/** Diskret merke på innlegg en moderator har festet øverst. */
export function PinnedLabel() {
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-stone-500">
      <Pin className="size-3" aria-hidden /> Festet
    </span>
  )
}

export function AuthorLine({
  author,
  date,
  editedAt,
  size = 'xs',
  avatar = true,
}: {
  author: Author
  date: Date
  /** Når forfatteren sist redigerte teksten. */
  editedAt?: Date | null
  size?: 'xs' | 'sm'
  /** Skjul avataren der den allerede vises ved siden av, som i kommentarer. */
  avatar?: boolean
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      <Link
        to="/medlemmer/$personId"
        params={{ personId: author.personId }}
        className="flex min-w-0 items-center gap-2 font-medium text-stone-800 hover:text-stone-950"
      >
        {avatar && (
          <Avatar name={author.fullName} photo={author.photo} size={size} muted={!author.claimed} />
        )}
        <span className="truncate">{author.fullName}</span>
        <Verified claimed={author.claimed} className="-ml-1" />
      </Link>
      {author.cohortYears.length > 0 && (
        <span className="hidden shrink-0 text-stone-400 sm:inline">
          ES {author.cohortYears.join(', ')}
        </span>
      )}
      <span className="hidden text-stone-300 sm:inline" aria-hidden>
        ·
      </span>
      <time
        dateTime={new Date(date).toISOString()}
        title={fullDate(date)}
        className="shrink-0 text-stone-400"
      >
        {timeAgo(date)}
      </time>
      {editedAt && (
        <>
          <span className="text-stone-300" aria-hidden>
            ·
          </span>
          {/* På smale skjermer bare «redigert»; tidspunktet står i title. */}
          <time
            dateTime={new Date(editedAt).toISOString()}
            title={`Redigert ${fullDate(editedAt)}`}
            className="shrink-0 text-stone-400"
          >
            redigert<span className="hidden sm:inline"> {timeAgo(editedAt)}</span>
          </time>
        </>
      )}
    </div>
  )
}

export function PostCard({ post }: { post: PostSummary }) {
  return (
    <article className="group relative flex gap-4 rounded-2xl bg-white p-4 shadow-card ring-1 ring-stone-200/70 transition hover:shadow-lift hover:ring-stone-300/80 sm:p-5">
      <VoteButton postId={post.id} votes={post.votes} voted={post.viewerVoted} />
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <ChannelBadge channel={post.channel} />
          {post.pinned && <PinnedLabel />}
          {post.url && (
            <a
              href={post.url}
              target="_blank"
              rel="noopener noreferrer"
              className="relative z-10 inline-flex items-center gap-1 truncate text-xs text-stone-400 hover:text-brand-600"
            >
              <ExternalLink className="size-3" aria-hidden />
              {new URL(post.url).hostname.replace(/^www\./, '')}
            </a>
          )}
        </div>
        <h2 className="text-[15px] leading-snug font-semibold text-stone-950 sm:text-base">
          <Link
            to="/feed/$postId"
            params={{ postId: post.id }}
            className="after:absolute after:inset-0 after:rounded-2xl focus:outline-none"
          >
            {post.title}
          </Link>
        </h2>
        {post.excerpt && (
          <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-stone-600">{post.excerpt}</p>
        )}
        <div className="relative z-10 mt-3 flex items-center justify-between gap-3">
          <AuthorLine author={post.author} date={post.createdAt} />
          <span className="inline-flex shrink-0 items-center gap-1.5 text-sm text-stone-500">
            <MessageCircle className="size-4" aria-hidden />
            {post.comments}
          </span>
        </div>
      </div>
    </article>
  )
}
