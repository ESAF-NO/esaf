import type { NotificationView } from '@esaf/core'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { CheckCheck } from 'lucide-react'
import { useState } from 'react'
import {
  NoNotifications,
  NotificationItem,
  useOpenNotification,
} from '#/components/Notifications.tsx'
import { Button, Card, ErrorText, PageHeader } from '#/components/ui.tsx'
import { fetchNotifications, readAllNotifications } from '#/lib/notifications.functions.ts'

const PAGE_SIZE = 30

export const Route = createFileRoute('/_konto/varsler')({
  loader: async () => ({
    ...(await fetchNotifications({ data: { limit: PAGE_SIZE } })),
    // Ny nøkkel ved hver lasting, så eldre sider som er hentet, starter på nytt.
    loadedAt: Date.now(),
  }),
  head: () => ({ meta: [{ title: 'Varsler – ESAF' }] }),
  component: NotificationsPage,
})

// Dagen regnes i norsk tid, så serveren og nettleseren grupperer likt.
const osloDay = new Intl.DateTimeFormat('nb-NO', { timeZone: 'Europe/Oslo', dateStyle: 'short' })
const dayOf = (date: Date | string) => osloDay.format(new Date(date))

function byDay(items: NotificationView[]) {
  const today = dayOf(new Date())
  return [
    { id: 'i-dag', title: 'I dag', items: items.filter((n) => dayOf(n.createdAt) === today) },
    {
      id: 'tidligere',
      title: 'Tidligere',
      items: items.filter((n) => dayOf(n.createdAt) !== today),
    },
  ].filter((group) => group.items.length > 0)
}

function NotificationsPage() {
  const first = Route.useLoaderData()
  return <NotificationList key={first.loadedAt} first={first} />
}

function NotificationList({ first }: { first: ReturnType<typeof Route.useLoaderData> }) {
  const router = useRouter()
  const openNotification = useOpenNotification()
  const [older, setOlder] = useState<NotificationView[]>([])
  const [hasMore, setHasMore] = useState(first.hasMore)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const items = [...first.items, ...older]

  async function showOlder() {
    setBusy(true)
    setError(null)
    try {
      const page = await fetchNotifications({
        data: { limit: PAGE_SIZE, before: items.at(-1)!.id },
      })
      setOlder((list) => [...list, ...page.items])
      setHasMore(page.hasMore)
    } catch {
      setError('Fikk ikke hentet eldre varsler. Prøv igjen.')
    } finally {
      setBusy(false)
    }
  }

  async function markAll() {
    setBusy(true)
    setError(null)
    try {
      await readAllNotifications()
      // Henter lista og antallet i toppen på nytt.
      await router.invalidate()
    } catch {
      setError('Fikk ikke merket varslene som lest. Prøv igjen.')
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Varsler"
        description="Kommentarer, omtaler, forslag til selskaper du er knyttet til, svar på dine egne forslag, og merker du får."
        actions={
          first.unread > 0 && (
            <Button variant="secondary" size="sm" onClick={markAll} disabled={busy}>
              <CheckCheck className="size-4" aria-hidden /> Merk alle som lest
            </Button>
          )
        }
      />
      {error && (
        <div className="mb-4">
          <ErrorText>{error}</ErrorText>
        </div>
      )}

      {items.length === 0 ? (
        <Card>
          <NoNotifications />
        </Card>
      ) : (
        <div className="space-y-6">
          {byDay(items).map((group) => (
            <section key={group.id} aria-labelledby={`varsler-${group.id}`}>
              <h2
                id={`varsler-${group.id}`}
                className="mb-2 px-1 text-sm font-medium text-stone-500"
              >
                {group.title}
              </h2>
              <Card className="overflow-hidden">
                <ul className="divide-y divide-stone-100">
                  {group.items.map((n) => (
                    <li key={n.id}>
                      <NotificationItem notification={n} onOpen={openNotification} />
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          ))}
          {hasMore && (
            <div className="flex justify-center">
              <Button variant="secondary" onClick={showOlder} disabled={busy}>
                {busy ? 'Henter …' : 'Vis eldre varsler'}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
