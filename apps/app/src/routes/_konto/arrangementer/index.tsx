import type { EventTypeSummary } from '@esaf/core'
import { createFileRoute, Link } from '@tanstack/react-router'
import { CalendarDays, ChevronRight, Settings2, Tent } from 'lucide-react'
import { EventCreateActions } from '#/components/EventCreate.tsx'
import { StrongAuthCallout } from '#/components/StrongAuth.tsx'
import { buttonClass, Card, cx, EmptyState, PageHeader } from '#/components/ui.tsx'
import { channels } from '#/lib/channels.ts'
import { typePlural } from '#/lib/events.ts'
import { plural } from '#/lib/format.ts'
import { fetchEventTypes } from '#/lib/events.functions.ts'

export const Route = createFileRoute('/_konto/arrangementer/')({
  loader: () => fetchEventTypes(),
  head: () => ({ meta: [{ title: 'Arrangementer – ESAF' }] }),
  component: EventTypes,
})

/**
 * Alle typer arrangementer med tall, ESAF-helgen først og størst. Hver type har
 * sin egen side med arrangementene og hvem som var der.
 */
function EventTypes() {
  const { types, canManage } = Route.useLoaderData()
  const [first, ...rest] = types

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Arrangementer"
        description="Det ESAF har arrangert, og hvem som var der."
        actions={
          canManage && (
            <div className="flex flex-wrap justify-end gap-2">
              <Link to="/admin/arrangementer" className={buttonClass({ variant: 'ghost' })}>
                <Settings2 className="size-4" aria-hidden /> Typer og import
              </Link>
              <EventCreateActions types={types} />
            </div>
          )
        }
      />
      <StrongAuthCallout className="mb-6">
        legge inn arrangementer, historikk og deltakere
      </StrongAuthCallout>
      <p className="-mt-3 mb-6 max-w-2xl text-sm text-stone-500">
        Invitasjoner og innlegg om det som skjer framover står i feeden under{' '}
        <Link
          to="/feed"
          search={{ kanal: 'arrangement' }}
          className="font-medium text-stone-700 hover:text-brand-600"
        >
          {channels.arrangement.plural}
        </Link>
        .
      </p>

      {!first ? (
        <EmptyState icon={CalendarDays} title="Ingen arrangementer ennå">
          {canManage
            ? 'Lag en type under «Typer og import» først.'
            : 'De dukker opp her når styret har lagt dem inn.'}
        </EmptyState>
      ) : (
        <div className="space-y-4">
          <TypeCard type={first} featured />
          {rest.length > 0 && (
            <ul className="grid gap-4 sm:grid-cols-2">
              {rest.map((t) => (
                <li key={t.id}>
                  <TypeCard type={t} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function TypeCard({ type: t, featured }: { type: EventTypeSummary; featured?: boolean }) {
  const Icon = featured ? Tent : CalendarDays
  const stats = [
    plural(t.events, 'arrangement', 'arrangementer'),
    t.people > 0 && `${plural(t.people, 'person', 'personer')} har vært med`,
    t.upcoming > 0 && `${t.upcoming} kommer`,
  ].filter(Boolean)
  return (
    <Card
      className={cx('relative h-full transition hover:ring-stone-300', featured ? 'p-6' : 'p-5')}
    >
      <div className="flex items-start gap-4">
        <span
          className={cx(
            'grid shrink-0 place-items-center rounded-xl',
            featured ? 'size-12 bg-brand-50 text-brand-600' : 'size-10 bg-stone-100 text-stone-500',
          )}
        >
          <Icon className={featured ? 'size-6' : 'size-5'} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2
            className={cx(
              'font-semibold tracking-tight text-stone-950',
              featured ? 'text-xl' : 'text-base',
            )}
          >
            <Link
              to="/arrangementer/$typeSlug"
              params={{ typeSlug: t.slug }}
              className="after:absolute after:inset-0 hover:text-brand-600"
            >
              {featured ? t.name : typePlural(t)}
            </Link>
          </h2>
          {t.description && (
            <p className="mt-1 line-clamp-2 text-sm text-stone-600">{t.description}</p>
          )}
          <p className="mt-2 text-sm text-stone-500 tabular-nums">{stats.join(' · ')}</p>
          {t.latest && (
            <p className="mt-1 text-sm text-stone-500">
              Sist: <span className="text-stone-700">{t.latest.name}</span>
            </p>
          )}
        </div>
        <ChevronRight className="mt-1 size-5 shrink-0 text-stone-300" aria-hidden />
      </div>
    </Card>
  )
}
