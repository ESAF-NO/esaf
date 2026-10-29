import type { EventCohortStat, EventRole, EventSummary } from '@esaf/core'
import { Link } from '@tanstack/react-router'
import { roleLabels } from '#/lib/events.ts'
import { plural } from '#/lib/format.ts'
import { cx } from './ui.tsx'

// Grafer og merker for arrangementer. Grafene er vanlig HTML og CSS, og tallene
// står også i listene.

const roleTones: Record<EventRole, string> = {
  organizer: 'bg-brand-50 text-brand-700 ring-brand-600/15',
  speaker: 'bg-sky-50 text-sky-700 ring-sky-600/15',
  volunteer: 'bg-emerald-50 text-emerald-700 ring-emerald-600/15',
}

/** «Arrangør», «Foredragsholder» eller «Frivillig». Ingenting for deltakere uten rolle. */
export function RoleBadge({ role, className }: { role: EventRole | null; className?: string }) {
  if (!role) return null
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center rounded-full px-1.5 py-px text-[11px] font-medium ring-1 ring-inset',
        roleTones[role],
        className,
      )}
    >
      {roleLabels[role]}
    </span>
  )
}

/** Stolper fra bunnlinjen, én per arrangement, eldste til venstre. Verdien vises over stolpen ved hover og fokus. */
export function ParticipantsChart({
  events,
  typeSlug,
}: {
  events: EventSummary[]
  typeSlug: string
}) {
  const max = Math.max(1, ...events.map((w) => w.participants))
  const peak = events.reduce((a, b) => (b.participants > a.participants ? b : a))
  const latest = events.at(-1)!
  return (
    <figure className="mt-5">
      <div className="relative h-44 border-b border-stone-200">
        <ol className="absolute inset-0 flex items-end gap-[2px]">
          {events.map((w) => {
            const label = w === peak || w === latest
            return (
              <li key={w.id} className="group relative flex h-full min-w-0 flex-1 items-end">
                <Link
                  to="/arrangementer/$typeSlug/$eventId"
                  params={{ typeSlug, eventId: w.id }}
                  aria-label={`${w.name}: ${plural(w.participants, 'deltaker', 'deltakere')}`}
                  // Treffflaten er hele høyden, ikke bare stolpen.
                  className="flex h-full w-full items-end justify-center focus-visible:outline-none"
                >
                  <span
                    className="block w-full max-w-10 rounded-t-[4px] bg-brand-500 transition group-hover:bg-brand-600 group-focus-within:bg-brand-600"
                    style={{
                      height: `${Math.max(w.participants ? 2 : 0, (w.participants / max) * 92)}%`,
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
                  style={{ bottom: `calc(${(w.participants / max) * 92}% + 2px)` }}
                >
                  {w.participants}
                </span>
                <span
                  role="tooltip"
                  className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 rounded-lg bg-stone-900 px-2.5 py-1.5 text-xs whitespace-nowrap text-white shadow-lg group-focus-within:block group-hover:block"
                >
                  <span className="block font-medium">{w.name}</span>
                  <span className="text-stone-300 tabular-nums">
                    {plural(w.participants, 'deltaker', 'deltakere')}
                  </span>
                </span>
              </li>
            )
          })}
        </ol>
      </div>
      <ol aria-hidden className="mt-1.5 flex gap-[2px] text-[11px] text-stone-500 tabular-nums">
        {events.map((w, i) => {
          const year = w.startDate.slice(0, 4)
          const show = i === 0 || events[i - 1]!.startDate.slice(0, 4) !== year
          // Med mange arrangementer vises bare annethvert år, så etikettene ikke kolliderer.
          const thin = events.length > 14 && Number(year) % 2 === 1
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
        Deltakere per arrangement, fra {events[0]!.name} til {latest.name}. Tallene står også i
        listen under.
      </figcaption>
    </figure>
  )
}

/** Liggende stolper per kull, nyeste kull øverst. */
export function CohortChart({ cohorts }: { cohorts: EventCohortStat[] }) {
  const max = Math.max(1, ...cohorts.map((c) => c.people))
  return (
    <ul className="mt-4 max-h-80 space-y-1.5 overflow-y-auto pr-1">
      {cohorts.map((c) => (
        <li
          key={c.graduationYear}
          title={`ES ${c.graduationYear}: ${plural(c.people, 'person', 'personer')}, ${plural(c.participations, 'deltakelse', 'deltakelser')}`}
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
              {plural(c.participations, 'deltakelse', 'deltakelser')}
            </span>
          </span>
        </li>
      ))}
    </ul>
  )
}
