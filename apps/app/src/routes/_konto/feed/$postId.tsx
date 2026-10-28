import { createFileRoute, Link, useLocation, useRouter } from '@tanstack/react-router'
import { ArrowLeft, ExternalLink, MessageCircle, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { MentionText } from '#/components/MentionText.tsx'
import { MentionTextarea } from '#/components/MentionTextarea.tsx'
import { AuthorLine, VoteButton } from '#/components/PostCard.tsx'
import { Avatar, Button, Card, ChannelBadge, cx, ErrorText } from '#/components/ui.tsx'
import { fetchPost, removeComment, removePost, submitComment } from '#/lib/feed.functions.ts'
import { plural } from '#/lib/format.ts'

export const Route = createFileRoute('/_konto/feed/$postId')({
  loader: ({ params }) => fetchPost({ data: { postId: params.postId } }),
  head: ({ loaderData }) => ({ meta: [{ title: `${loaderData?.title ?? 'Innlegg'} – ESAF` }] }),
  component: PostPage,
})

function PostPage() {
  const post = Route.useLoaderData()
  const { viewer } = Route.useRouteContext()
  const router = useRouter()
  // Varsler lenker til kommentaren med #kommentar-<id>; den markeres når siden åpnes.
  const hash = useLocation({ select: (l) => l.hash })
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  async function onComment(e: FormEvent) {
    e.preventDefault()
    setSending(true)
    setError(null)
    try {
      await submitComment({ data: { postId: post.id, body } })
      setBody('')
      await router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke publisere kommentaren.')
    } finally {
      setSending(false)
    }
  }

  async function onDeletePost() {
    if (!confirm('Slette innlegget?')) return
    await removePost({ data: { postId: post.id } })
    await router.navigate({ to: '/feed' })
  }

  async function onDeleteComment(commentId: string) {
    if (!confirm('Slette kommentaren?')) return
    await removeComment({ data: { commentId } })
    await router.invalidate()
  }

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        to="/feed"
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-stone-500 transition hover:text-stone-900"
      >
        <ArrowLeft className="size-4" aria-hidden /> Tilbake
      </Link>

      <Card className="p-5 sm:p-7">
        <div className="mb-4 flex items-center justify-between gap-3">
          <ChannelBadge channel={post.channel} />
          {post.canDelete && (
            <Button variant="danger" size="sm" onClick={onDeletePost}>
              <Trash2 className="size-4" aria-hidden /> Slett
            </Button>
          )}
        </div>
        <h1 className="text-xl leading-tight font-semibold tracking-tight text-stone-950 sm:text-2xl">
          {post.title}
        </h1>
        <div className="mt-3">
          <AuthorLine author={post.author} date={post.createdAt} size="sm" />
        </div>
        {post.body && (
          <div className="mt-5 text-[15px] leading-relaxed whitespace-pre-line text-stone-700">
            <MentionText text={post.body} />
          </div>
        )}
        {post.url && (
          <a
            href={post.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-5 flex items-center gap-3 rounded-xl bg-stone-50 p-3 text-sm ring-1 ring-stone-200 transition ring-inset hover:bg-stone-100"
          >
            <span className="grid size-9 place-items-center rounded-lg bg-white text-stone-500 ring-1 ring-stone-200">
              <ExternalLink className="size-4" aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block font-medium text-stone-900">
                {new URL(post.url).hostname.replace(/^www\./, '')}
              </span>
              <span className="block truncate text-stone-500">{post.url}</span>
            </span>
          </a>
        )}
        <div className="mt-6 flex items-center gap-3 border-t border-stone-100 pt-4">
          <VoteButton postId={post.id} votes={post.votes} voted={post.viewerVoted} layout="row" />
          <span className="inline-flex items-center gap-1.5 text-sm text-stone-500">
            <MessageCircle className="size-4" aria-hidden />
            {plural(post.commentList.length, 'kommentar', 'kommentarer')}
          </span>
        </div>
      </Card>

      <section aria-labelledby="kommentarer" className="mt-6">
        <h2 id="kommentarer" className="sr-only">
          Kommentarer
        </h2>

        <form onSubmit={onComment} className="mb-6 flex gap-3">
          {viewer.fullName && (
            <Avatar name={viewer.fullName} size="md" className="mt-0.5 hidden sm:inline-grid" />
          )}
          <div className="flex-1 space-y-2">
            <MentionTextarea
              value={body}
              onValueChange={setBody}
              suggestFirst={[post.author, ...post.commentList.map((c) => c.author)]}
              placeholder="Skriv en kommentar …"
              aria-label="Kommentar"
              className="min-h-20"
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter')
                  e.currentTarget.form?.requestSubmit()
              }}
            />
            {error && <ErrorText>{error}</ErrorText>}
            <div className="flex items-center justify-end gap-3">
              <span className="hidden text-xs text-stone-400 sm:inline">
                @ for å nevne noen · ⌘ + Enter for å sende
              </span>
              <Button type="submit" variant="primary" size="sm" disabled={sending || !body.trim()}>
                {sending ? 'Sender …' : 'Kommenter'}
              </Button>
            </div>
          </div>
        </form>

        <ol className="space-y-4">
          {post.commentList.map((c) => (
            <li key={c.id} id={`kommentar-${c.id}`} className="group flex scroll-mt-24 gap-3">
              <Link
                to="/medlemmer/$personId"
                params={{ personId: c.author.personId }}
                className="mt-0.5"
              >
                <Avatar name={c.author.fullName} size="md" muted={!c.author.claimed} />
              </Link>
              <div
                className={cx(
                  'min-w-0 flex-1 rounded-2xl rounded-tl-md bg-white px-4 py-3 shadow-card transition',
                  hash === `kommentar-${c.id}`
                    ? 'ring-2 ring-brand-300'
                    : 'ring-1 ring-stone-200/70',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <AuthorLine author={c.author} date={c.createdAt} avatar={false} />
                  {c.canDelete && (
                    <button
                      type="button"
                      onClick={() => onDeleteComment(c.id)}
                      className="rounded-md p-1 text-stone-300 opacity-0 transition group-hover:opacity-100 hover:bg-red-50 hover:text-red-600 focus:opacity-100"
                      aria-label="Slett kommentar"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  )}
                </div>
                <p className="mt-1.5 text-sm leading-relaxed whitespace-pre-line text-stone-700">
                  <MentionText text={c.body} />
                </p>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}
