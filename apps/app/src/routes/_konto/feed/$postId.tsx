import type { CommentView } from '@esaf/core'
import { createFileRoute, Link, useLocation, useRouter } from '@tanstack/react-router'
import {
  ArrowLeft,
  ExternalLink,
  MessageCircle,
  Pencil,
  Pin,
  PinOff,
  Plus,
  SmilePlus,
  Trash2,
} from 'lucide-react'
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import { AttachmentList, useAttachments } from '#/components/Attachments.tsx'
import { Composer } from '#/components/Composer.tsx'
import { Markdown } from '#/components/Markdown.tsx'
import { AuthorLine, PinnedLabel, VoteButton } from '#/components/PostCard.tsx'
import { Avatar, Button, buttonClass, Card, ChannelBadge, cx, ErrorText } from '#/components/ui.tsx'
import {
  editComment,
  fetchPost,
  pinPost,
  reactToComment,
  removeComment,
  removePost,
  submitComment,
} from '#/lib/feed.functions.ts'
import {
  commentThreads,
  maxReactions,
  quickReactionsFor,
  toggleReaction,
  type CommentThread as CommentThreadData,
} from '#/lib/comments.ts'
import { useDraft } from '#/lib/drafts.ts'
import { plural } from '#/lib/format.ts'
import { insertMention } from '#/lib/mentions.ts'
import { useDismiss } from '#/lib/use-dismiss.ts'

export const Route = createFileRoute('/_konto/feed/$postId')({
  loader: ({ params }) => fetchPost({ data: { postId: params.postId } }),
  head: ({ loaderData }) => ({ meta: [{ title: `${loaderData?.title ?? 'Innlegg'} – ESAF` }] }),
  component: PostPage,
})

const EmojiPicker = lazy(() => import('#/components/EmojiPicker.tsx'))

const errorText = (err: unknown, fallback: string) =>
  err instanceof Error ? err.message : fallback

const names = new Intl.ListFormat('nb', { type: 'conjunction' })

const commentAction =
  'inline-flex h-7 items-center rounded-md px-1.5 text-xs font-medium text-stone-500 transition hover:bg-stone-100 hover:text-stone-900'

function PostPage() {
  const post = Route.useLoaderData()
  const router = useRouter()
  const [pinning, setPinning] = useState(false)
  const threads = commentThreads(post.commentList)
  const people = [post.author, ...post.commentList.map((c) => c.author)]

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
        <CommentForm postId={post.id} people={people} />
        <ol className="space-y-5">
          {threads.map((thread) => (
            <Thread key={thread.id} thread={thread} postId={post.id} people={people} />
          ))}
        </ol>
      </section>
    </div>
  )
}

/** Egen komponent, så det du skriver ikke tegner hele kommentarlisten på nytt. */
function CommentForm({
  postId,
  people,
  replyTo,
  onClose,
}: {
  postId: string
  people: { personId: string }[]
  /** Kommentaren det svares på. Uten den er det en ny kommentar til innlegget. */
  replyTo?: CommentView
  onClose?: () => void
}) {
  const { viewer } = Route.useRouteContext()
  const router = useRouter()
  // Svar på et svar begynner med navnet, så det er tydelig hvem det er til.
  const opening =
    replyTo?.parentId && replyTo.author.personId !== viewer.personId
      ? insertMention('', 0, 0, {
          personId: replyTo.author.personId,
          name: replyTo.author.fullName,
        }).markup
      : ''
  const id = replyTo ? `svar-${replyTo.id}` : 'ny-kommentar'
  // Kommentaren huskes som utkast til den er sendt, også om du går fra siden.
  const [body, setBody, clearDraft] = useDraft(
    replyTo ? `svar:${replyTo.id}` : `kommentar:${postId}`,
    opening,
  )
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const attachments = useAttachments({ til: 'kommentar' })
  const empty = !body.trim() && !attachments.items.length

  // Markøren skal stå etter navnet, ikke foran det.
  useEffect(() => {
    if (!replyTo) return
    const field = document.getElementById(id) as HTMLTextAreaElement | null
    field?.setSelectionRange(field.value.length, field.value.length)
  }, [id, replyTo])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (empty || attachments.busy) return
    setSending(true)
    setError(null)
    try {
      await submitComment({
        data: { postId, body, attachmentIds: attachments.ids, replyTo: replyTo?.id },
      })
      clearDraft()
      attachments.reset()
      await router.invalidate()
      onClose?.()
    } catch (err) {
      setError(errorText(err, 'Kunne ikke publisere kommentaren.'))
    } finally {
      setSending(false)
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      {...attachments.drop.props}
      className={cx('flex gap-3', !replyTo && 'mb-8')}
    >
      {viewer.fullName && (
        <Avatar
          name={viewer.fullName}
          photo={viewer.photo}
          size={replyTo ? 'sm' : 'md'}
          className="mt-0.5 hidden sm:inline-grid"
        />
      )}
      <div className="min-w-0 flex-1 space-y-2">
        <Composer
          id={id}
          label={replyTo ? `Svar ${replyTo.author.fullName}` : 'Skriv en kommentar'}
          value={body}
          onChange={setBody}
          placeholder={replyTo ? 'Skriv et svar …' : 'Skriv en kommentar …'}
          maxLength={5000}
          attachments={attachments}
          suggestFirst={people}
          compact={!replyTo}
          autoFocus={Boolean(replyTo)}
          minRows={replyTo ? 2 : undefined}
          onEscape={onClose}
          dragging={attachments.drop.dragging}
          actions={
            <>
              {onClose && (
                <Button variant="ghost" size="sm" onClick={onClose}>
                  Avbryt
                </Button>
              )}
              <Button
                type="submit"
                variant="brand"
                size="sm"
                disabled={sending || empty || attachments.busy}
              >
                {sending ? 'Sender …' : attachments.busy ? 'Laster opp …' : 'Send'}
              </Button>
            </>
          }
        />
        {error && <ErrorText>{error}</ErrorText>}
      </div>
    </form>
  )
}

/** En kommentar med svarene under, og skrivefeltet når noen svarer. */
function Thread({
  thread,
  postId,
  people,
}: {
  thread: CommentThreadData<CommentView>
  postId: string
  people: { personId: string }[]
}) {
  const [replyTo, setReplyTo] = useState<CommentView | null>(null)
  const close = useCallback(() => setReplyTo(null), [])
  return (
    <li>
      {thread.root ? (
        <CommentItem comment={thread.root} onReply={setReplyTo} />
      ) : (
        <p className="rounded-2xl bg-stone-100 px-4 py-3 text-sm text-stone-500">
          Kommentaren er slettet.
        </p>
      )}
      {(thread.replies.length > 0 || replyTo) && (
        <div className="mt-3 ml-4 space-y-3 border-l-2 border-stone-200/70 pl-3 sm:ml-5 sm:pl-5">
          {thread.replies.length > 0 && (
            <ol className="space-y-3" aria-label="Svar">
              {thread.replies.map((c) => (
                <li key={c.id}>
                  <CommentItem comment={c} onReply={setReplyTo} reply />
                </li>
              ))}
            </ol>
          )}
          {replyTo && (
            <CommentForm
              key={replyTo.id}
              postId={postId}
              people={[replyTo.author, ...people]}
              replyTo={replyTo}
              onClose={close}
            />
          )}
        </div>
      )}
    </li>
  )
}

/** Reaksjonene på en kommentar, og knappen for å gi en ny. */
function Reactions({ comment: c }: { comment: CommentView }) {
  const { viewer } = Route.useRouteContext()
  const [list, setList] = useState(c.reactions)
  // Når siden hentes på nytt, er det serverens tall som gjelder.
  const [seen, setSeen] = useState(c.reactions)
  if (seen !== c.reactions) {
    setSeen(c.reactions)
    setList(c.reactions)
  }
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const close = useCallback(() => setPicking(false), [])

  async function toggle(emoji: string) {
    close()
    if (busy) return
    setBusy(true)
    const before = list
    // Optimistisk: oppdater med en gang, rett opp med svaret fra serveren.
    setList(toggleReaction(list, emoji, viewer.fullName ?? ''))
    try {
      setList(await reactToComment({ data: { commentId: c.id, emoji } }))
    } catch {
      setList(before)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {list.map((r) => (
        <button
          key={r.emoji}
          type="button"
          onClick={() => void toggle(r.emoji)}
          aria-pressed={r.viewerReacted}
          aria-label={`${r.emoji}: ${r.count}`}
          title={names.format(r.people)}
          className={cx(
            'inline-flex h-7 items-center gap-1 rounded-full px-2 text-xs font-medium tabular-nums ring-1 transition ring-inset',
            r.viewerReacted
              ? 'bg-brand-50 text-brand-700 ring-brand-200'
              : 'bg-white text-stone-600 ring-stone-200 hover:bg-stone-50',
          )}
        >
          <span aria-hidden>{r.emoji}</span>
          {r.count}
        </button>
      ))}
      {list.length < maxReactions && (
        <div className="relative">
          <button
            type="button"
            onClick={() => setPicking((p) => !p)}
            aria-expanded={picking}
            aria-label="Reager på kommentaren"
            title="Reager"
            className={commentAction}
          >
            <SmilePlus className="size-4" aria-hidden />
          </button>
          {picking && <ReactionMenu onClose={close} onPick={(e) => void toggle(e)} />}
        </div>
      )}
    </>
  )
}

/** Snarveiene, og alle emoji når de ikke er nok. */
function ReactionMenu({
  onClose,
  onPick,
}: {
  onClose: () => void
  onPick: (emoji: string) => void
}) {
  const { favoriteReactions } = Route.useLoaderData()
  const box = useRef<HTMLDivElement>(null)
  const [all, setAll] = useState(false)
  const [shift, setShift] = useState(0)
  const [above, setAbove] = useState(false)
  useDismiss(box, onClose)

  // Knappen kan stå hvor som helst i raden: hold menyen inne på skjermen. Målt fra
  // knappen, for menyen flytter seg selv, og fra clientWidth, som den ikke kan blåse opp.
  useLayoutEffect(() => {
    const menu = box.current
    const button = menu?.parentElement?.getBoundingClientRect()
    if (!menu || !button) return
    const { clientWidth, clientHeight } = document.documentElement
    const margin = 8
    const header = 64
    setShift(Math.min(0, clientWidth - margin - button.left - menu.offsetWidth))
    setAbove(
      button.bottom + menu.offsetHeight + margin > clientHeight &&
        button.top - menu.offsetHeight - margin > header,
    )
  }, [all])

  return (
    <div
      ref={box}
      role={all ? 'dialog' : 'menu'}
      aria-label={all ? 'Alle emoji' : 'Reaksjoner'}
      style={{ transform: `translateX(${shift}px)` }}
      className={cx(
        'absolute left-0 z-20 animate-in rounded-xl bg-white shadow-lift ring-1 ring-stone-200',
        above ? 'bottom-full mb-1' : 'top-full mt-1',
        all ? 'h-88 w-80 max-w-[calc(100vw-1rem)] overflow-hidden' : 'flex p-1',
      )}
    >
      {all ? (
        <Suspense
          fallback={
            <p className="grid h-full place-items-center text-sm text-stone-500">Laster …</p>
          }
        >
          <EmojiPicker onPick={onPick} />
        </Suspense>
      ) : (
        <>
          {quickReactionsFor(favoriteReactions).map((r) => (
            <button
              key={r.emoji}
              type="button"
              role="menuitem"
              onClick={() => onPick(r.emoji)}
              aria-label={r.label}
              title={r.label}
              className="grid size-9 place-items-center rounded-lg text-lg transition hover:bg-stone-100"
            >
              <span aria-hidden>{r.emoji}</span>
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            onClick={() => setAll(true)}
            aria-label="Alle emoji"
            title="Alle emoji"
            className="grid size-9 place-items-center rounded-lg text-stone-500 transition hover:bg-stone-100 hover:text-stone-900"
          >
            <Plus className="size-4" aria-hidden />
          </button>
        </>
      )}
    </div>
  )
}

function CommentItem({
  comment: c,
  onReply,
  reply = false,
}: {
  comment: CommentView
  onReply: (comment: CommentView) => void
  /** Står under en annen kommentar. */
  reply?: boolean
}) {
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
    <div id={`kommentar-${c.id}`} className="group flex scroll-mt-24 gap-3">
      <Link to="/medlemmer/$personId" params={{ personId: c.author.personId }} className="mt-0.5">
        <Avatar
          name={c.author.fullName}
          photo={c.author.photo}
          size={reply ? 'sm' : 'md'}
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
              layout="comment"
              className="mt-2"
            />
            <div className="mt-2 -ml-1 flex flex-wrap items-center gap-1">
              <Reactions comment={c} />
              <button type="button" onClick={() => onReply(c)} className={commentAction}>
                Svar
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
