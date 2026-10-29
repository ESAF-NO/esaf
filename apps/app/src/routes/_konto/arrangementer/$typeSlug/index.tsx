import type { EventSummary } from '@esaf/core'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowLeft, CalendarDays, Check, MapPin } from 'lucide-react'
import type { ReactNode } from 'react'
import { CohortChart, ParticipantsChart, RoleBadge } from '#/components/EventCharts.tsx'
import { EventCreateActions } from '#/components/EventCreate.tsx'
import { StrongAuthCallout } from '#/components/StrongAuth.tsx'
import { buttonClass, Card, PageHeader } from '#/components/ui.tsx'
import { eventWhen, roleSummary, typePlural } from '#/lib/events.ts'
import { fetchEventTypeOptions, fetchEventTypeOverview } from '#/lib/events.functions.ts'
import { plural } from '#/lib/format.ts'

export const Route = createFileRoute('/_konto/arrangementer/$typeSlug/')({
  loader: async ({ params, context: { viewer } }) => {
    const [overview, types] = await Promise.all([
      fetchEventTypeOverview({ data: { slug: params.typeSlug } }),
      // Typene til «Nytt arrangement», bare for admins.
      viewer.permissions.includes('profiles.edit') ? fetchEventTypeOptions() : [],
    ])
    return { overview, types }
  },
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.overview.type.name ?? 'Arrangementer'} – ESAF` }],
  }),
  component: EventTypePage,
  notFoundComponent: TypeNotFound,
})

/**
 * Oversikten for én type: deltakere per arrangement over tid og per kull, og
 * alle arrangementene med tall. Bare aktive medlemmer telles.
 */
function EventTypePage() {
  const { overview: o, types } = Route.useLoaderData()
  const past = o.events.filter((e) => !e.upcoming)
  const roles = roleSummary(o.roles)
  const name = typePlural(o.type)

  return (
    <div className="mx-auto max-w-5xl">
      <Link
        to="/arrangementer"
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-900"
      >
        <ArrowLeft className="size-4" aria-hidden /> Arrangementer
      </Link>
      <PageHeader
        title={o.type.name}
        description={
          o.events.length
            ? [
                plural(o.events.length, 'arrangement', 'arrangementer'),
                `${plural(o.people, 'person', 'personer')} har vært med`,
                plural(o.participations, 'deltakelse', 'deltakelser'),
              ].join(' · ')
            : undefined
        }
        actions={
          o.canManage &&
          o.events.length > 0 && (
            <div className="flex flex-wrap justify-end gap-2">
              <EventCreateActions types={types} typeId={o.type.id} />
            </div>
          )
        }
      />
      <StrongAuthCallout className="mb-6">
        legge inn arrangementer, historikk og deltakere
      </StrongAuthCallout>

      {o.events.length === 0 ? (
        <TypeEmpty
          canManage={o.canManage}
          action={<EventCreateActions types={types} typeId={o.type.id} />}
        />
      ) : (
        <div className="space-y-10">
          <p className="max-w-2xl text-sm text-stone-500">
            {o.type.description && <>{o.type.description} </>}
            Var du der? Åpne arrangementet og trykk «Jeg var der», så teller du med.
            {roles && ` Til sammen: ${roles}.`}
          </p>

          {past.length > 1 && (
            <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
              <Card className="p-5">
                <h2 className="text-sm font-semibold text-stone-950">Deltakere per arrangement</h2>
                <p className="mt-0.5 text-xs text-stone-500">Eldste til venstre.</p>
                <ParticipantsChart events={[...past].reverse()} typeSlug={o.type.slug} />
              </Card>
              {o.cohorts.length > 0 && (
                <Card className="p-5">
                  <h2 className="text-sm font-semibold text-stone-950">Per kull</h2>
                  <p className="mt-0.5 text-xs text-stone-500">
                    Hvor mange fra kullet som har vært med minst én gang.
                  </p>
                  <CohortChart cohorts={o.cohorts} />
                </Card>
              )}
            </div>
          )}

          <section aria-labelledby="alle">
            <h2 id="alle" className="mb-3 text-sm font-semibold text-stone-950">
              {name}
            </h2>
            <Card>
              <ul className="divide-y divide-stone-100">
                {o.events.map((e) => (
                  <EventRow key={e.id} event={e} typeSlug={o.type.slug} />
                ))}
              </ul>
            </Card>
          </section>
        </div>
      )}
    </div>
  )
}

/**
 * Ingen arrangementer av typen. Admins får de to måtene å legge dem inn på;
 * medlemmer får vite at styret legger dem inn.
 */
function TypeEmpty({ canManage, action }: { canManage: boolean; action: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-stone-300 bg-white/50 px-6 py-14 text-center">
      <div className="mx-auto grid size-11 place-items-center rounded-full bg-stone-100 text-stone-500">
        <CalendarDays className="size-5" aria-hidden />
      </div>
      <p className="mt-3 font-medium text-stone-900">Ingen arrangementer ennå</p>
      {canManage ? (
        <>
          <p className="mx-auto mt-1 max-w-md text-sm text-stone-500">
            Legg inn ett arrangement med dato, eller mange tidligere på én gang med «Legg inn
            historikk» når du bare vet året eller semesteret. Deltakerne legger du til på hvert
            arrangement etterpå.
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div>
        </>
      ) : (
        <p className="mx-auto mt-1 max-w-md text-sm text-stone-500">
          De dukker opp her når styret har lagt dem inn. Da kan du åpne dem og trykke «Jeg var der»,
          så teller du med.
        </p>
      )}
    </div>
  )
}

function EventRow({ event: e, typeSlug }: { event: EventSummary; typeSlug: string }) {
  const roles = roleSummary(e.roles)
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <Link
          to="/arrangementer/$typeSlug/$eventId"
          params={{ typeSlug, eventId: e.id }}
          className="font-medium text-stone-950 hover:text-brand-600"
        >
          {e.name}
        </Link>
        <p className="flex flex-wrap items-center gap-x-3 text-sm text-stone-500 tabular-nums">
          <span>{eventWhen(e)}</span>
          {e.location && (
            <span className="inline-flex items-center gap-1">
              <MapPin className="size-3.5" aria-hidden /> {e.location}
            </span>
          )}
          {roles && <span>{roles}</span>}
        </p>
      </div>
      {e.participated && (
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700 ring-1 ring-brand-600/15 ring-inset">
            <Check className="size-3" aria-hidden /> Du var der
          </span>
          <RoleBadge role={e.myRole} />
        </span>
      )}
      <span className="w-28 text-right text-sm text-stone-600 tabular-nums">
        {e.upcoming ? 'Kommer' : plural(e.participants, 'deltaker', 'deltakere')}
      </span>
    </li>
  )
}

function TypeNotFound() {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-xl font-semibold tracking-tight text-stone-950">
        Fant ikke arrangementene
      </h1>
      <p className="mt-2 text-sm text-stone-500">Typen kan ha blitt slettet.</p>
      <Link
        to="/arrangementer"
        className={buttonClass({ variant: 'secondary', size: 'sm' }, 'mt-6')}
      >
        Se alle arrangementer
      </Link>
    </div>
  )
}
