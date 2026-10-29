import type { WeekendCohortStat, WeekendSummary } from '@esaf/core'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Check, MapPin, Plus, Tent } from 'lucide-react'
import { useState } from 'react'
import { Button, Card, EmptyState, PageHeader } from '#/components/ui.tsx'
import { emptyWeekend, WeekendDialog } from '#/components/WeekendForm.tsx'
import { dateRange, plural } from '#/lib/format.ts'
import { fetchWeekends, newWeekend } from '#/lib/weekends.functions.ts'

export const Route = createFileRoute('/_konto/esaf-helgen/')({
  loader: () => fetchWeekends(),
  head: () => ({ meta: [{ title: 'ESAF-helgen – ESAF' }] }),
  component: Weekends,
})

function Weekends() {
  const o = Route.useLoaderData()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const past = o.weekends.filter((w) => !w.upcoming)

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="ESAF-helgen"
        description={
          o.weekends.length
            ? [
                plural(o.weekends.length, 'helg', 'helger'),
                `${plural(o.people, 'person', 'personer')} har vært med`,
                plural(o.attendances, 'oppmøte', 'oppmøter'),
              ].join(' · ')
            : undefined
        }
        actions={
          o.canManage && (
            <Button variant="brand" onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden /> Ny helg
            </Button>
          )
        }
      />

      {o.weekends.length === 0 ? (
        <EmptyState icon={Tent} title="Ingen helger ennå">
          Helgene dukker opp her når styret har lagt dem inn.
        </EmptyState>
      ) : (
        <div className="space-y-10">
          <p className="max-w-2xl text-sm text-stone-500">
            Samlingen for alle fra Entreprenørskolen, som regel én gang i året. Var du der? Åpne
            helgen og trykk «Jeg var der», så teller du med.
          </p>

          {past.length > 1 && (
            <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
              <Card className="p-5">
                <h2 className="text-sm font-semibold text-stone-950">Deltakere per helg</h2>
                <p className="mt-0.5 text-xs text-stone-500">Eldste til venstre.</p>
                <AttendanceChart weekends={[...past].reverse()} />
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

          <section aria-labelledby="alle-helger">
            <h2 id="alle-helger" className="mb-3 text-sm font-semibold text-stone-950">
              Alle helgene
            </h2>
            <Card>
              <ul className="divide-y divide-stone-100">
                {o.weekends.map((w) => (
                  <WeekendRow key={w.id} weekend={w} />
                ))}
              </ul>
            </Card>
          </section>
        </div>
      )}

      {creating && (
        <WeekendDialog
          title="Ny ESAF-helg"
          initial={emptyWeekend}
          submitLabel="Opprett"
          onClose={() => setCreating(false)}
          onSubmit={async (values) => {
            const { id } = await newWeekend({ data: values })
            await navigate({ to: '/esaf-helgen/$weekendId', params: { weekendId: id } })
          }}
        />
      )}
    </div>
  )
}

function WeekendRow({ weekend: w }: { weekend: WeekendSummary }) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <Link
          to="/esaf-helgen/$weekendId"
          params={{ weekendId: w.id }}
          className="font-medium text-stone-950 hover:text-brand-600"
        >
          {w.name}
        </Link>
        <p className="flex flex-wrap items-center gap-x-3 text-sm text-stone-500 tabular-nums">
          <span>{dateRange(w.startDate, w.endDate)}</span>
          {w.location && (
            <span className="inline-flex items-center gap-1">
              <MapPin className="size-3.5" aria-hidden /> {w.location}
            </span>
          )}
        </p>
      </div>
      {w.attended && (
        <span className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700 ring-1 ring-brand-600/15 ring-inset">
          <Check className="size-3" aria-hidden /> Du var der
        </span>
      )}
      <span className="w-28 text-right text-sm text-stone-600 tabular-nums">
        {w.upcoming ? 'Kommer' : plural(w.attendees, 'deltaker', 'deltakere')}
      </span>
    </li>
  )
}

/** Stolper fra bunnlinjen, én per helg. Verdien vises over stolpen ved hover og fokus. */
function AttendanceChart({ weekends }: { weekends: WeekendSummary[] }) {
  const max = Math.max(1, ...weekends.map((w) => w.attendees))
  const peak = weekends.reduce((a, b) => (b.attendees > a.attendees ? b : a))
  const latest = weekends.at(-1)!
  return (
    <figure className="mt-5">
      <div className="relative h-44 border-b border-stone-200">
        <ol className="absolute inset-0 flex items-end gap-[2px]">
          {weekends.map((w) => {
            const label = w === peak || w === latest
            return (
              <li key={w.id} className="group relative flex h-full min-w-0 flex-1 items-end">
                <Link
                  to="/esaf-helgen/$weekendId"
                  params={{ weekendId: w.id }}
                  aria-label={`${w.name}: ${plural(w.attendees, 'deltaker', 'deltakere')}`}
                  // Treffflaten er hele høyden, ikke bare stolpen.
                  className="flex h-full w-full items-end justify-center focus-visible:outline-none"
                >
                  <span
                    className="block w-full max-w-10 rounded-t-[4px] bg-brand-500 transition group-hover:bg-brand-600 group-focus-within:bg-brand-600"
                    style={{
                      height: `${Math.max(w.attendees ? 2 : 0, (w.attendees / max) * 92)}%`,
                    }}
                  />
                </Link>
                <span
                  aria-hidden
                  className={
                    label
                      ? 'pointer-events-none absolute inset-x-0 text-center text-[11px] font-medium text-stone-600 tabular-nums group-hover:opacity-0'
                      : 'hidden'
                  }
                  style={{ bottom: `calc(${(w.attendees / max) * 92}% + 2px)` }}
                >
                  {w.attendees}
                </span>
                <span
                  role="tooltip"
                  className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 rounded-lg bg-stone-900 px-2.5 py-1.5 text-xs whitespace-nowrap text-white shadow-lg group-focus-within:block group-hover:block"
                >
                  <span className="block font-medium">{w.name}</span>
                  <span className="text-stone-300 tabular-nums">
                    {plural(w.attendees, 'deltaker', 'deltakere')}
                  </span>
                </span>
              </li>
            )
          })}
        </ol>
      </div>
      <ol aria-hidden className="mt-1.5 flex gap-[2px] text-[11px] text-stone-500 tabular-nums">
        {weekends.map((w, i) => {
          const year = w.startDate.slice(0, 4)
          const show = i === 0 || weekends[i - 1]!.startDate.slice(0, 4) !== year
          // Med mange helger vises bare annethvert år, så etikettene ikke kolliderer.
          const thin = weekends.length > 14 && Number(year) % 2 === 1
          return (
            <li
              key={w.id}
              className="min-w-0 flex-1 overflow-visible text-center whitespace-nowrap"
            >
              {show && !thin ? `’${year.slice(2)}` : ''}
            </li>
          )
        })}
      </ol>
      <figcaption className="sr-only">
        Deltakere per helg, fra {weekends[0]!.name} til {latest.name}. Tallene står også i listen
        under.
      </figcaption>
    </figure>
  )
}

/** Liggende stolper per kull, nyeste kull øverst. */
function CohortChart({ cohorts }: { cohorts: WeekendCohortStat[] }) {
  const max = Math.max(1, ...cohorts.map((c) => c.people))
  return (
    <ul className="mt-4 max-h-80 space-y-1.5 overflow-y-auto pr-1">
      {cohorts.map((c) => (
        <li
          key={c.graduationYear}
          title={`ES ${c.graduationYear}: ${plural(c.people, 'person', 'personer')}, ${plural(c.attendances, 'oppmøte', 'oppmøter')}`}
          className="grid grid-cols-[4.25rem_minmax(0,1fr)_2rem] items-center gap-2 text-xs"
        >
          <Link
            to="/kull/$year"
            params={{ year: c.graduationYear }}
            className="font-medium text-stone-700 tabular-nums hover:text-brand-600"
          >
            ES {c.graduationYear}
          </Link>
          <span className="h-3 rounded-r-[4px] bg-stone-100">
            <span
              className="block h-full rounded-r-[4px] bg-brand-500"
              style={{ width: `${(c.people / max) * 100}%` }}
            />
          </span>
          <span className="text-right text-stone-600 tabular-nums">
            {c.people}
            <span className="sr-only">
              {' '}
              {c.people === 1 ? 'person' : 'personer'},{' '}
              {plural(c.attendances, 'oppmøte', 'oppmøter')}
            </span>
          </span>
        </li>
      ))}
    </ul>
  )
}
