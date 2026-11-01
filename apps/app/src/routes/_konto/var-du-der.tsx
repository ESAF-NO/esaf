import type { BadgeChip, MissedEventGroup } from '@esaf/core'
import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { ArrowLeft, Check, MapPin, PartyPopper } from 'lucide-react'
import { useState } from 'react'
import { NewBadgesDialog } from '#/components/Badges.tsx'
import { Button, Card, cx, EmptyState, ErrorText, PageHeader } from '#/components/ui.tsx'
import { addMyParticipations, fetchMissedEvents } from '#/lib/badges.functions.ts'
import { eventWhen } from '#/lib/events.ts'
import { plural } from '#/lib/format.ts'

export const Route = createFileRoute('/_konto/var-du-der')({
  loader: () => fetchMissedEvents(),
  head: () => ({ meta: [{ title: 'Var du der? – ESAF' }] }),
  component: MissedEventsPage,
  errorComponent: ({ error }) => (
    <ErrorText>{error instanceof Error ? error.message : 'Noe gikk galt.'}</ErrorText>
  ),
})

/**
 * «Var du der?»: arrangementene fra din tid du ikke står på, med hvor mange
 * fra kullet ditt som var der. Kryss av og lagre alt på én gang; merkene som
 * hører til, kommer med en gang.
 */
function MissedEventsPage() {
  const groups = Route.useLoaderData()
  const router = useRouter()
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<{ added: number; badges: BadgeChip[] } | null>(null)

  const toggle = (ids: string[], on: boolean) =>
    setPicked((current) => {
      const next = new Set(current)
      for (const id of ids) {
        if (on) next.add(id)
        else next.delete(id)
      }
      return next
    })

  async function save() {
    setBusy(true)
    setError(null)
    try {
      const result = await addMyParticipations({ data: { eventIds: [...picked] } })
      setPicked(new Set())
      setSaved(result)
      await router.invalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke lagre.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl pb-24">
      <Link
        to="/merker"
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-900"
      >
        <ArrowLeft className="size-4" aria-hidden /> Merker
      </Link>
      <PageHeader
        title="Var du der?"
        description="Arrangementene fra din tid som ikke har deg på lista. Kryss av for dem du var på. Det vises på profilen din, og merkene som hører til kommer med en gang."
      />

      {saved && saved.badges.length === 0 && (
        <p className="mb-4 flex items-center gap-2 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-900 ring-1 ring-emerald-200 ring-inset">
          <Check className="size-4" aria-hidden /> Lagret: du står nå på{' '}
          {plural(saved.added, 'arrangement', 'arrangementer')} til.
        </p>
      )}

      {groups.length === 0 ? (
        <EmptyState icon={PartyPopper} title="Alt er fylt inn">
          Du står på alle arrangementene fra din tid som er lagt inn. Se{' '}
          <Link to="/merker" className="font-medium text-stone-700 hover:text-brand-600">
            merkene dine
          </Link>
          .
        </EmptyState>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <EventGroup key={g.type.id} group={g} picked={picked} toggle={toggle} />
          ))}
        </div>
      )}

      {picked.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-stone-200 bg-white/95 px-4 py-3 backdrop-blur">
          <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-stone-700">
              {plural(picked.size, 'arrangement', 'arrangementer')} valgt
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setPicked(new Set())} disabled={busy}>
                Fjern valg
              </Button>
              <Button variant="brand" onClick={save} disabled={busy}>
                {busy ? 'Lagrer …' : 'Jeg var der'}
              </Button>
            </div>
            {error && (
              <div className="w-full">
                <ErrorText>{error}</ErrorText>
              </div>
            )}
          </div>
        </div>
      )}

      {saved && saved.badges.length > 0 && (
        <NewBadgesDialog badges={saved.badges} onClose={() => setSaved(null)} />
      )}
    </div>
  )
}

function EventGroup({
  group: g,
  picked,
  toggle,
}: {
  group: MissedEventGroup
  picked: Set<string>
  toggle: (ids: string[], on: boolean) => void
}) {
  const ids = g.events.map((e) => e.id)
  const all = ids.every((id) => picked.has(id))
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-stone-100 px-5 py-3">
        <h2 className="text-sm font-semibold text-stone-950">
          {g.type.name}{' '}
          <span className="font-normal text-stone-500 tabular-nums">{g.events.length}</span>
        </h2>
        <button
          type="button"
          onClick={() => toggle(ids, !all)}
          className="text-xs font-medium text-stone-500 hover:text-stone-900"
        >
          {all ? 'Fjern alle' : 'Velg alle'}
        </button>
      </div>
      <ul className="divide-y divide-stone-100">
        {g.events.map((e) => {
          const on = picked.has(e.id)
          return (
            <li key={e.id}>
              <label
                className={cx(
                  'flex cursor-pointer items-start gap-3 px-5 py-3 transition',
                  on ? 'bg-brand-50/60' : 'hover:bg-stone-50',
                )}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(event) => toggle([e.id], event.target.checked)}
                  className="mt-1 size-4 accent-brand-600"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-stone-950">{e.name}</span>
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-stone-500">
                    <span>{eventWhen(e)}</span>
                    {e.location && (
                      <span className="inline-flex items-center gap-1">
                        <MapPin className="size-3" aria-hidden /> {e.location}
                      </span>
                    )}
                    {e.participants > 0 && (
                      <span>
                        {plural(e.participants, 'medlem', 'medlemmer')} var der
                        {e.fromCohort > 0 && (
                          <strong className="font-medium text-stone-700">
                            , {e.fromCohort} fra kullet ditt
                          </strong>
                        )}
                      </span>
                    )}
                  </span>
                </span>
              </label>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
