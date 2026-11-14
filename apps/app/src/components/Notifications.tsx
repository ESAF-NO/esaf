import type { NotificationView } from '@esaf/core'
import { Link, linkOptions, useLocation, useRouteContext, useRouter } from '@tanstack/react-router'
import { Bell } from 'lucide-react'
import {
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { fullDate, timeAgo } from '#/lib/format.ts'
import {
  fetchNotifications,
  fetchUnreadNotifications,
  readAllNotifications,
  readNotification,
} from '#/lib/notifications.functions.ts'
import { linkRoleLabels } from './Contributions.tsx'
import { Avatar, cx } from './ui.tsx'

/** Hvor et varsel leder: til kommentaren, innlegget, selskapet, personen eller kullet. */
function target(n: NotificationView) {
  if (n.company) {
    return linkOptions({
      to: '/selskaper/$slug',
      params: { slug: n.company.slug },
      hash: n.type === 'company_suggestion' ? 'forslag' : undefined,
    })
  }
  if (n.post) {
    return linkOptions({
      to: '/feed/$postId',
      params: { postId: n.post.id },
      hash: n.commentId ? `kommentar-${n.commentId}` : undefined,
    })
  }
  if (n.type === 'cohort_joined' && n.actor) {
    return linkOptions({ to: '/medlemmer/$personId', params: { personId: n.actor.personId } })
  }
  return linkOptions({ to: '/medlemmer', search: { kull: n.graduationYear ?? undefined } })
}

function Sentence({ n }: { n: NotificationView }) {
  const who = (
    <strong className="font-semibold text-stone-900">{n.actor?.fullName ?? 'Noen'}</strong>
  )
  const title = n.post && <span className="font-medium text-stone-900">«{n.post.title}»</span>
  const company = (
    <span className="font-medium text-stone-900">{n.company?.name ?? 'et selskap'}</span>
  )
  const role = n.linkRole ? linkRoleLabels[n.linkRole] : 'med'
  switch (n.type) {
    case 'company_suggestion':
      return n.suggestionKind === 'event' ? (
        <>
          {who} foreslår en ny hendelse i historikken til {company}
        </>
      ) : n.suggestionKind === 'article' ? (
        <>
          {who} foreslår en sak om {company} under «I media»
        </>
      ) : (
        <>
          {who} foreslår endringer i {company}
        </>
      )
    case 'suggestion_accepted':
      return (
        <>
          {who} godtok forslaget ditt til {company}
        </>
      )
    case 'suggestion_rejected':
      return (
        <>
          {who} avslo forslaget ditt til {company}
        </>
      )
    case 'company_link_request':
      return (
        <>
          {who} sier at du var {role === 'med' ? 'med' : role} i {company}. Stemmer det?
        </>
      )
    case 'company_link_confirmed':
      return (
        <>
          {who} bekreftet at de var {role} i {company}
        </>
      )
    case 'company_addition':
      return n.additionKind === 'event' ? (
        <>
          {who} la til en hendelse i historikken til {company}
        </>
      ) : n.additionKind === 'article' ? (
        <>
          {who} la til en sak om {company} under «I media»
        </>
      ) : (
        <>
          {who} la til en person i {company}
        </>
      )
    case 'comment_on_post':
      return (
        <>
          {who} kommenterte innlegget ditt {title}
        </>
      )
    case 'comment_on_thread':
      return (
        <>
          {who} kommenterte også {title}
        </>
      )
    case 'comment_reply':
      return (
        <>
          {who} svarte på kommentaren din til {title}
        </>
      )
    case 'mention':
      return n.commentId ? (
        <>
          {who} nevnte deg i en kommentar til {title}
        </>
      ) : (
        <>
          {who} nevnte deg i {title}
        </>
      )
    case 'welcome':
      return (
        <>
          <strong className="font-semibold text-stone-900">Velkommen til ESAF!</strong>{' '}
          Forespørselen din er godkjent.
        </>
      )
    case 'cohort_joined':
      return (
        <>
          {who}
          {n.graduationYear ? ` fra ES ${n.graduationYear}` : ''} er nå med i ESAF.
        </>
      )
  }
}

function detail(n: NotificationView): string | null {
  if (n.type === 'welcome') {
    return n.graduationYear
      ? `Se hvem fra ES ${n.graduationYear} som er her.`
      : 'Se hvem som er her.'
  }
  return n.excerpt
}

function Picture({ n, size }: { n: NotificationView; size: 'sm' | 'md' }) {
  if (n.actor) return <Avatar name={n.actor.fullName} size={size} muted={!n.actor.claimed} />
  // Varsler fra ESAF selv, som velkomsten, får logoen.
  return (
    <span
      aria-hidden
      className={cx(
        'grid shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 font-bold text-white shadow-sm',
        size === 'sm' ? 'size-8 text-xs' : 'size-10 text-sm',
      )}
    >
      E
    </span>
  )
}

export function NotificationItem({
  notification: n,
  compact = false,
  onOpen,
}: {
  notification: NotificationView
  /** Tettere, til lista under klokka. */
  compact?: boolean
  onOpen: (n: NotificationView, e: MouseEvent<HTMLAnchorElement>) => void
}) {
  const extra = detail(n)
  return (
    <Link
      {...target(n)}
      onClick={(e) => onOpen(n, e)}
      className={cx(
        'flex gap-3 transition hover:bg-stone-50 focus-visible:bg-stone-50',
        compact ? 'rounded-xl px-3 py-2.5' : 'px-4 py-3.5 sm:px-5',
      )}
    >
      <Picture n={n} size={compact ? 'sm' : 'md'} />
      <span className="min-w-0 flex-1">
        <span
          className={cx('text-sm leading-snug text-stone-600', compact ? 'line-clamp-3' : 'block')}
        >
          {!n.read && <span className="sr-only">Ulest: </span>}
          <Sentence n={n} />
        </span>
        {extra && (
          <span
            className={cx(
              'mt-0.5 text-sm text-stone-500',
              compact ? 'line-clamp-1' : 'line-clamp-2',
            )}
          >
            {extra}
          </span>
        )}
        <time
          dateTime={new Date(n.createdAt).toISOString()}
          title={fullDate(n.createdAt)}
          className="mt-1 block text-xs text-stone-400"
        >
          {timeAgo(n.createdAt)}
        </time>
      </span>
      {!n.read && <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-brand-500" />}
    </Link>
  )
}

/**
 * Åpner et varsel: merker det som lest og går dit det leder. Med Cmd/Ctrl
 * eller Shift åpnes lenken som vanlig i ny fane, og varselet merkes i bakgrunnen.
 */
export function useOpenNotification(onUnread?: (count: number) => void) {
  const router = useRouter()
  return async (n: NotificationView, e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      if (!n.read) readNotification({ data: { id: n.id } }).then(onUnread, () => {})
      return
    }
    e.preventDefault()
    if (!n.read) {
      try {
        // Ferdig før navigeringen, så antallet i toppen er riktig når siden er lastet.
        onUnread?.(await readNotification({ data: { id: n.id } }))
      } catch {
        // Varselet står da fortsatt som ulest, men lenken skal virke uansett.
      }
    }
    await router.navigate(target(n))
  }
}

export function NoNotifications({ children }: { children?: ReactNode }) {
  return (
    <div className="px-6 py-10 text-center">
      <div className="mx-auto grid size-10 place-items-center rounded-full bg-stone-100 text-stone-500">
        <Bell className="size-5" aria-hidden />
      </div>
      <p className="mt-3 text-sm font-medium text-stone-900">Ingen varsler ennå</p>
      <p className="mx-auto mt-1 max-w-xs text-sm text-stone-500">
        Du får varsel når noen kommenterer innleggene dine eller der du har kommentert, når noen
        nevner deg med @, og om forslag og selskaper du er knyttet til.
      </p>
      {children}
    </div>
  )
}

const POLL_MS = 60_000

/**
 * Antall uleste. Kommer med fra serveren ved hver navigering, og hentes på nytt
 * hvert minutt mens fanen er synlig og når den blir synlig igjen. Et nyere tall
 * fra spørring eller egne endringer gjelder til neste navigering.
 */
function useUnreadCount() {
  const { viewer } = useRouteContext({ from: '__root__' })
  const [latest, setLatest] = useState<{ count: number; since: typeof viewer } | null>(null)
  const unread = latest?.since === viewer ? latest.count : viewer.unreadNotifications
  const update = (count: number) => setLatest({ count, since: viewer })
  const onPolled = useEffectEvent(update)

  useEffect(() => {
    async function poll() {
      if (document.visibilityState !== 'visible') return
      try {
        onPolled(await fetchUnreadNotifications())
      } catch {
        // Nettverket kan være borte en stund; neste runde prøver igjen.
      }
    }
    const timer = window.setInterval(poll, POLL_MS)
    document.addEventListener('visibilitychange', poll)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', poll)
    }
  }, [])

  return [unread, update] as const
}

/** Klokka i toppen, med antall uleste og de siste varslene. */
export function NotificationBell() {
  const href = useLocation({ select: (l) => l.href })
  const [unread, setUnread] = useUnreadCount()
  // Lista hører til siden den ble åpnet på, så den lukkes av seg selv ved navigering.
  const [openAt, setOpenAt] = useState<string | null>(null)
  const open = openAt === href
  const [page, setPage] = useState<{ items: NotificationView[] } | null>(null)
  const [failed, setFailed] = useState(false)
  const wrapper = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const openNotification = useOpenNotification(setUnread)

  async function load() {
    setFailed(false)
    try {
      const next = await fetchNotifications({ data: { limit: 8 } })
      setPage(next)
      setUnread(next.unread)
    } catch {
      setFailed(true)
    }
  }

  function toggle() {
    if (open) {
      setOpenAt(null)
      return
    }
    setOpenAt(href)
    void load()
  }

  async function markAll() {
    setPage((p) => p && { items: p.items.map((n) => ({ ...n, read: true })) })
    setUnread(0)
    try {
      await readAllNotifications()
    } catch {
      void load()
    }
  }

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (!wrapper.current?.contains(e.target as Node)) setOpenAt(null)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      setOpenAt(null)
      button.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={wrapper} className="relative">
      <button
        ref={button}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={unread ? `Varsler, ${unread} uleste` : 'Varsler'}
        className={cx(
          'relative grid size-10 place-items-center rounded-xl transition hover:bg-stone-100 hover:text-stone-900',
          open ? 'bg-stone-100 text-stone-900' : 'text-stone-600',
        )}
      >
        <Bell className="size-5" aria-hidden />
        {unread > 0 && (
          <span
            aria-hidden
            className="absolute top-1 right-1 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-brand-600 px-1 text-[11px] leading-none font-semibold text-white tabular-nums ring-2 ring-stone-50"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="Varsler"
          className="fixed inset-x-3 top-[4.25rem] z-40 animate-in overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-stone-200 sm:absolute sm:inset-x-auto sm:top-full sm:right-0 sm:mt-2 sm:w-[25rem]"
        >
          <div className="flex items-center justify-between gap-3 border-b border-stone-100 px-4 py-3">
            <h2 className="text-sm font-semibold text-stone-950">Varsler</h2>
            {unread > 0 && (
              <button
                type="button"
                onClick={markAll}
                className="rounded-md text-sm font-medium text-brand-700 hover:underline"
              >
                Merk alle som lest
              </button>
            )}
          </div>
          <div className="max-h-[min(30rem,calc(100dvh-10rem))] overflow-y-auto p-1.5">
            {!page ? (
              <p className="px-3 py-10 text-center text-sm text-stone-500">
                {failed ? (
                  <>
                    Fikk ikke hentet varslene.{' '}
                    <button
                      type="button"
                      onClick={load}
                      className="font-medium text-brand-700 hover:underline"
                    >
                      Prøv igjen
                    </button>
                  </>
                ) : (
                  'Henter varsler …'
                )}
              </p>
            ) : page.items.length === 0 ? (
              <NoNotifications />
            ) : (
              <ul>
                {page.items.map((n) => (
                  <li key={n.id}>
                    <NotificationItem
                      notification={n}
                      compact
                      onOpen={(item, e) => {
                        if (!(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) setOpenAt(null)
                        void openNotification(item, e)
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="border-t border-stone-100 p-1.5">
            <Link
              to="/varsler"
              onClick={() => setOpenAt(null)}
              className="block rounded-xl px-3 py-2 text-center text-sm font-medium text-stone-600 transition hover:bg-stone-50 hover:text-stone-900"
            >
              Se alle varsler
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}
