import type { CommentView } from '@esaf/core'
import { createFileRoute, Link, useLocation, useRouter } from '@tanstack/react-router'
import { ArrowLeft, ExternalLink, MessageCircle, Pencil, Pin, PinOff, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { AttachmentList, useAttachments } from '#/components/Attachments.tsx'
import { Composer } from '#/components/Composer.tsx'
import { Markdown } from '#/components/Markdown.tsx'
import { AuthorLine, PinnedLabel, VoteButton } from '#/components/PostCard.tsx'
import { Avatar, Button, buttonClass, Card, ChannelBadge, cx, ErrorText } from '#/components/ui.tsx'
import {
  editComment,
  fetchPost,
  pinPost,
  removeComment,
  removePost,
  submitComment,
} from '#/lib/feed.functions.ts'
import { useDraft } from '#/lib/drafts.ts'
import { plural } from '#/lib/format.ts'

export const Route = createFileRoute('/_konto/feed/$postId')({
  loader: ({ params }) => fetchPost({ data: { postId: params.postId } }),
  head: ({ loaderData }) => ({ meta: [{ title: `${loaderData?.title ?? 'Innlegg'} – ESAF` }] }),
  component: PostPage,
})

const errorText = (err: unknown, fallback: string) =>
  err instanceof Error ? err.message : fallback

function PostPage() {
  const post = Route.useLoaderData()
  const router = useRouter()
  const [pinning, setPinning] = useState(false)

  async function onDeletePost() {
    if (!confirm('Slette innlegget?')) return
    await removePost({ data: { postId: post.id } })
    await router.navigate({ to: '/feed' })
  }

  async function onTogglePin() {
    setPinning(true)
    try {
      await pinPost({ data: { postId: post.id, pinned: !post.pinned } })
      await router.invalidate()
    } finally {
      setPinning(false)
    }
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
          <div className="flex flex-wrap items-center gap-2">
            <ChannelBadge channel={post.channel} />
            {post.pinned && <PinnedLabel />}
          </div>
          <div className="-mr-2 flex items-center">
            {post.canPin && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onTogglePin}
                disabled={pinning}
                aria-label={post.pinned ? 'Løsne innlegget' : 'Fest innlegget øverst'}
                title={
                  post.pinned ? 'Løsne innlegget' : 'Fest innlegget øverst i feeden og kanalen'
                }
              >
                {post.pinned ? (
                  <PinOff className="size-4" aria-hidden />
                ) : (
                  <Pin className="size-4" aria-hidden />
                )}
                <span className="hidden sm:inline">{post.pinned ? 'Løsne' : 'Fest'}</span>
              </Button>
            )}
            {post.canEdit && (
              <Link
                to="/feed/$postId/rediger"
                params={{ postId: post.id }}
                className={buttonClass({ variant: 'ghost', size: 'sm' })}
                aria-label="Rediger innlegget"
              >
                <Pencil className="size-4" aria-hidden />
                <span className="hidden sm:inline">Rediger</span>
              </Link>
            )}
            {post.canDelete && (
              <Button
                variant="danger"
                size="sm"
                onClick={onDeletePost}
                aria-label="Slett innlegget"
              >
                <Trash2 className="size-4" aria-hidden />
                <span className="hidden sm:inline">Slett</span>
              </Button>
            )}
          </div>
        </div>
        <h1 className="text-xl leading-tight font-semibold tracking-tight text-stone-950 sm:text-2xl">
          {post.title}
        </h1>
        <div className="mt-3">
          <AuthorLine
            author={post.author}
            date={post.createdAt}
            editedAt={post.editedAt}
            size="sm"
          />
        </div>
        {post.body && (
          <Markdown className="mt-5 text-[15px] leading-relaxed text-stone-700">
            {post.body}
          </Markdown>
        )}
        <AttachmentList
          attachments={post.attachments}
          // Forfatteren tar bort vedlegg under «Rediger»; moderatorer kan fjerne dem her.
          removable={(a) => a.canRemove && !post.isOwn}
          className="mt-5"
        />
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
        <CommentForm
          postId={post.id}
          people={[post.author, ...post.commentList.map((c) => c.author)]}
        />
        <ol className="space-y-4">
          {post.commentList.map((c) => (
            <CommentItem key={c.id} comment={c} />
          ))}
        </ol>
      </section>
    </div>
  )
}

/** Egen komponent, så det du skriver ikke tegner hele kommentarlisten på nytt. */
function CommentForm({ postId, people }: { postId: string; people: { personId: string }[] }) {
  const { viewer } = Route.useRouteContext()
  const router = useRouter()
  // Kommentaren huskes som utkast til den er sendt, også om du går fra siden.
  const [body, setBody, clearDraft] = useDraft(`kommentar:${postId}`, '')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const attachments = useAttachments({ til: 'kommentar' })
  const empty = !body.trim() && !attachments.items.length

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (empty || attachments.busy) return
    setSending(true)
    setError(null)
    try {
      await submitComment({ data: { postId, body, attachmentIds: attachments.ids } })
      clearDraft()
      attachments.reset()
      await router.invalidate()
    } catch (err) {
      setError(errorText(err, 'Kunne ikke publisere kommentaren.'))
    } finally {
      setSending(false)
    }
  }

  return (
    <form onSubmit={onSubmit} {...attachments.drop.props} className="mb-8 flex gap-3">
      {viewer.fullName && (
        <Avatar
          name={viewer.fullName}
          photo={viewer.photo}
          size="md"
          className="mt-0.5 hidden sm:inline-grid"
        />
      )}
      <div className="min-w-0 flex-1 space-y-2">
        <Composer
          id="ny-kommentar"
          label="Skriv en kommentar"
          value={body}
          onChange={setBody}
          placeholder="Skriv en kommentar …"
          maxLength={5000}
          attachments={attachments}
          suggestFirst={people}
          compact
          dragging={attachments.drop.dragging}
          actions={
            <Button
              type="submit"
              variant="brand"
              size="sm"
              disabled={sending || empty || attachments.busy}
            >
              {sending ? 'Sender …' : attachments.busy ? 'Laster opp …' : 'Send'}
            </Button>
          }
        />
        {error && <ErrorText>{error}</ErrorText>}
      </div>
    </form>
  )
}

function CommentItem({ comment: c }: { comment: CommentView }) {
  const router = useRouter()
  // Varsler lenker til #kommentar-<id>; den kommentaren markeres når siden åpnes.
  const highlighted = useLocation({ select: (l) => l.hash === `kommentar-${c.id}` })
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(c.body)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const attachments = useAttachments({ til: 'kommentar' }, c.attachments)
  const empty = !draft.trim() && !attachments.items.length

  function startEditing() {
    setDraft(c.body)
    attachments.reset(c.attachments)
    setError(null)
    setEditing(true)
  }

  async function onSave(e: FormEvent) {
    e.preventDefault()
    if (empty || attachments.busy) return
    setSaving(true)
    setError(null)
    try {
      await editComment({ data: { commentId: c.id, body: draft, attachmentIds: attachments.ids } })
      await router.invalidate()
      setEditing(false)
    } catch (err) {
      setError(errorText(err, 'Kunne ikke lagre kommentaren.'))
    } finally {
      setSaving(false)
    }
  }

  async function onDelete() {
    if (!confirm('Slette kommentaren?')) return
    await removeComment({ data: { commentId: c.id } })
    await router.invalidate()
  }

  const action = 'rounded-md p-1 text-stone-400 transition hover:bg-stone-100 hover:text-stone-700'

  return (
    <li id={`kommentar-${c.id}`} className="group flex scroll-mt-24 gap-3">
      <Link to="/medlemmer/$personId" params={{ personId: c.author.personId }} className="mt-0.5">
        <Avatar
          name={c.author.fullName}
          photo={c.author.photo}
          size="md"
          muted={!c.author.claimed}
        />
      </Link>
      <div
        className={cx(
          'min-w-0 flex-1 rounded-2xl rounded-tl-md bg-white px-4 py-3 shadow-card transition',
          highlighted ? 'ring-2 ring-brand-300' : 'ring-1 ring-stone-200/70',
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <AuthorLine author={c.author} date={c.createdAt} editedAt={c.editedAt} avatar={false} />
          {!editing && (c.canEdit || c.canDelete) && (
            // Med mus vises handlingene når du holder over kommentaren. På berøringsskjermer
            // finnes ikke hover, så der står de fremme hele tiden.
            <div className="-mt-0.5 -mr-1.5 flex shrink-0 transition pointer-fine:opacity-0 pointer-fine:group-focus-within:opacity-100 pointer-fine:group-hover:opacity-100">
              {c.canEdit && (
                <button
                  type="button"
                  onClick={startEditing}
                  className={action}
                  aria-label="Rediger kommentar"
                >
                  <Pencil className="size-4" />
                </button>
              )}
              {c.canDelete && (
                <button
                  type="button"
                  onClick={onDelete}
                  className={`${action} hover:bg-red-50 hover:text-red-600`}
                  aria-label="Slett kommentar"
                >
                  <Trash2 className="size-4" />
                </button>
              )}
            </div>
          )}
        </div>
        {editing ? (
          <form onSubmit={onSave} className="mt-2 space-y-2" {...attachments.drop.props}>
            <Composer
              id={`rediger-kommentar-${c.id}`}
              label="Rediger kommentaren"
              value={draft}
              onChange={setDraft}
              placeholder="Skriv en kommentar …"
              maxLength={5000}
              attachments={attachments}
              autoFocus
              minRows={2}
              onEscape={() => setEditing(false)}
              dragging={attachments.drop.dragging}
              actions={
                <>
                  <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                    Avbryt
                  </Button>
                  <Button
                    type="submit"
                    variant="brand"
                    size="sm"
                    disabled={saving || empty || attachments.busy}
                  >
                    {saving ? 'Lagrer …' : 'Lagre'}
                  </Button>
                </>
              }
            />
            {error && <ErrorText>{error}</ErrorText>}
          </form>
        ) : (
          <>
            {c.body && (
              <Markdown className="mt-1.5 text-sm leading-relaxed text-stone-700">
                {c.body}
              </Markdown>
            )}
            <AttachmentList
              attachments={c.attachments}
              removable={(a) => a.canRemove && !c.canEdit}
              className="mt-2"
            />
          </>
        )}
      </div>
    </li>
  )
}
