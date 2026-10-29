import type { CohortRepresentative, RepresentativeBadge } from '@esaf/core'
import { Link } from '@tanstack/react-router'
import { Megaphone } from 'lucide-react'
import { Avatar, cx, Verified } from './ui.tsx'

/**
 * Vervene som kullrepresentant på profilen, som `<li>` i listen over verv:
 * nåværende som tydelige merker, tidligere i en roligere stil med årene. Hvert
 * merke lenker til kullet.
 */
export function RepresentativeBadges({ badges }: { badges: RepresentativeBadge[] }) {
  return (
    <>
      {badges.map((b) => (
        <li key={b.graduationYear}>
          <Link
            to="/kull/$year"
            params={{ year: b.graduationYear }}
            title={b.current && b.period ? `Kullrepresentant ${b.period}` : undefined}
            className={cx(
              'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 transition ring-inset',
              b.current
                ? 'bg-brand-50 text-brand-700 ring-brand-600/15 hover:bg-brand-100'
                : 'text-stone-500 ring-stone-200 hover:text-stone-800 hover:ring-stone-300',
            )}
          >
            <Megaphone className="size-3.5" aria-hidden />
            Kullrepresentant ES {b.graduationYear}
            {!b.current && b.period && <span className="tabular-nums">, {b.period}</span>}
          </Link>
        </li>
      ))}
    </>
  )
}

/** Lite merke i lister og søk: «Kullrep. ES 2024». */
export function RepresentativeTag({ years, className }: { years: number[]; className?: string }) {
  if (!years.length) return null
  return (
    <span
      title={`Kullrepresentant for ES ${years.join(' og ES ')}`}
      className={cx(
        'inline-flex shrink-0 items-center gap-1 rounded-full bg-brand-50 px-1.5 py-px text-[11px] font-medium text-brand-700 ring-1 ring-brand-600/15 ring-inset',
        className,
      )}
    >
      <Megaphone className="size-3" aria-hidden />
      <span>
        Kullrep.<span className="sr-only">resentant for</span> ES {years.join(', ')}
      </span>
    </span>
  )
}

/** Én representant på kullsiden. */
export function RepresentativeCard({ rep }: { rep: CohortRepresentative }) {
  return (
    <Link
      to="/medlemmer/$personId"
      params={{ personId: rep.personId }}
      className="flex items-center gap-3 rounded-2xl bg-white p-3 pr-4 shadow-card ring-1 ring-stone-200/70 transition hover:-translate-y-px hover:shadow-lift hover:ring-stone-300"
    >
      <Avatar name={rep.fullName} photo={rep.photo} size="md" muted={!rep.claimed} />
      <span className="min-w-0">
        <span className="flex items-center gap-1 text-sm font-semibold text-stone-950">
          <span className="truncate">{rep.fullName}</span>
          <Verified claimed={rep.claimed} />
        </span>
        <span className="block text-xs text-stone-500 tabular-nums">
          {rep.startYear ? `Kullrepresentant siden ${rep.startYear}` : 'Kullrepresentant'}
          {rep.otherCohort && ' · fra et annet kull'}
        </span>
        {rep.note && <span className="block truncate text-xs text-stone-500">{rep.note}</span>}
      </span>
    </Link>
  )
}
