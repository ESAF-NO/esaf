import type { CohortRaceBadge, CohortSummary, RankedCohort } from '@esaf/core'
import { createFileRoute, Link } from '@tanstack/react-router'
import { GraduationCap } from 'lucide-react'
import { useState } from 'react'
import { AvatarStack, Card, cx, EmptyState, PageHeader } from '#/components/ui.tsx'
import { fetchCommunity } from '#/lib/feed.functions.ts'
import { esPeriod, plural } from '#/lib/format.ts'

export const Route = createFileRoute('/_konto/kull/')({
  loader: () => fetchCommunity(),
  head: () => ({ meta: [{ title: 'Kull – ESAF' }] }),
  component: Cohorts,
})

function Cohorts() {
  const { cohorts, members, claimed, ownYears, race, raceBadges } = Route.useLoaderData()
  const newest = cohorts[0]?.graduationYear
  const oldest = cohorts.at(-1)?.graduationYear

  return (
    <>
      <PageHeader
        title="Kull"
        description={
          cohorts.length
            ? `${cohorts.length} kull fra ES ${oldest} til ES ${newest} · ${members} personer · ${claimed} har tatt i bruk profilen`
            : undefined
        }
      />
      {cohorts.length === 0 ? (
        <EmptyState icon={GraduationCap} title="Ingen kull ennå">
          Kullene dukker opp her når kullisten er importert.
        </EmptyState>
      ) : (
        <>
          <CohortRace race={race} cohorts={cohorts} badges={raceBadges} ownYears={ownYears} />
          <h2 className="mb-3 text-lg font-semibold tracking-tight text-stone-950">Alle kull</h2>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {cohorts.map((c) => (
              <li key={c.graduationYear}>
                <CohortCard cohort={c} own={ownYears.includes(c.graduationYear)} />
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}

/** Plassene som vises store. */
const PODIUM = 3
/** Hvor mange flere som vises i lista før «Vis hele lista». Ditt eget kull vises alltid. */
const LIST = 5

const percent = (share: number) =>
  // Aldri 100 % før alle er med, og aldri 0 % når noen er det.
  share >= 1 ? 100 : share > 0 ? Math.min(99, Math.max(1, Math.round(share * 100))) : 0

/** Hva merkene gjelder, i én setning: «Det første kullet der alle er med, får «Først til 100 %».» */
function badgeLine(badges: CohortRaceBadge[]) {
  return badges
    .map((b) =>
      b.place === null
        ? `Alle kull der alle er med, får «${b.name}».`
        : b.place === 1
          ? `Det første kullet der alle er med, får «${b.name}».`
          : `De ${b.place} første kullene der alle er med, får «${b.name}».`,
    )
    .join(' ')
}

/**
 * Kullkampen: kullene etter andelen som har tatt i bruk profilen. De tre beste
 * vises store, resten i en liste. Reglene står i @esaf/core (cohort-race.ts).
 */
function CohortRace({
  race,
  cohorts,
  badges,
  ownYears,
}: {
  race: RankedCohort[]
  cohorts: CohortSummary[]
  badges: CohortRaceBadge[]
  ownYears: number[]
}) {
  const [expanded, setExpanded] = useState(false)
  const faces = new Map(
    cohorts.map((c) => [c.graduationYear, c.preview.filter((p) => p.claimed)] as const),
  )
  const started = race.filter((r) => r.rank !== null)
  const waiting = race.length - started.length
  const podium = started.slice(0, PODIUM)
  const rest = started.slice(PODIUM)
  const own = (r: RankedCohort) => ownYears.includes(r.graduationYear)
  const listed = expanded ? rest : rest.filter((r, i) => i < LIST || own(r))
  const hidden = rest.length - listed.length

  return (
    <section className="mb-10" aria-labelledby="kullkampen">
      <div className="mb-3">
        <h2 id="kullkampen" className="text-lg font-semibold tracking-tight text-stone-950">
          Kullkampen
        </h2>
        <p className="mt-0.5 text-sm text-stone-500">
          Andelen i hvert kull som har tatt i bruk profilen. {badgeLine(badges)}
        </p>
      </div>

      {podium.length === 0 ? (
        <Card className="p-5 text-sm text-stone-500">
          Ingen kull er i gang ennå. Det første som tar i bruk profilen, tar ledelsen.
        </Card>
      ) : (
        <>
          <ol className="grid gap-3 sm:grid-cols-3">
            {podium.map((r) => (
              <li key={r.cohortId}>
                <PodiumCard standing={r} own={own(r)} faces={faces.get(r.graduationYear) ?? []} />
              </li>
            ))}
          </ol>

          {listed.length > 0 && (
            <Card className="mt-3 px-5 py-1">
              <ol className="divide-y divide-stone-100">
                {listed.map((r) => (
                  <RaceRow key={r.cohortId} standing={r} own={own(r)} />
                ))}
              </ol>
            </Card>
          )}

          <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
            {(hidden > 0 || (expanded && rest.length > LIST)) && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="font-medium text-brand-700 hover:text-brand-800"
                aria-expanded={expanded}
              >
                {expanded ? 'Vis færre' : `Vis hele lista (${started.length} kull)`}
              </button>
            )}
            {waiting > 0 && (
              <p className="text-stone-500">
                {waiting === 1 ? 'Ett kull' : `${waiting} kull`} har ingen med ennå.
              </p>
            )}
          </div>
        </>
      )}
    </section>
  )
}

function PodiumCard({
  standing: r,
  own,
  faces,
}: {
  standing: RankedCohort
  own: boolean
  faces: CohortSummary['preview']
}) {
  const p = percent(r.share)
  return (
    <Link
      to="/kull/$year"
      params={{ year: r.graduationYear }}
      className={cx(
        'group flex h-full flex-col rounded-2xl bg-white p-5 shadow-card ring-1 transition hover:-translate-y-px hover:shadow-lift',
        own ? 'ring-brand-600/30' : 'ring-stone-200/70 hover:ring-stone-300',
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-stone-900 tabular-nums group-hover:text-brand-600">
          ES {r.graduationYear}
          {own && <span className="font-normal text-stone-500"> · ditt kull</span>}
        </span>
        <span
          className={cx(
            'text-sm font-semibold tabular-nums',
            r.rank === 1 ? 'text-brand-600' : 'text-stone-400',
          )}
        >
          {r.rank}.
        </span>
      </div>
      <p className="mt-2 text-3xl font-semibold tracking-tight sm:mt-3 sm:text-4xl text-stone-950 tabular-nums">
        {p}
        <span className="ml-0.5 text-2xl text-stone-400">%</span>
      </p>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-stone-100">
        <div className="h-full rounded-full bg-brand-500" style={{ width: `${p}%` }} />
      </div>
      <div className="mt-4 flex items-center justify-between gap-3">
        {faces.length > 0 ? <AvatarStack people={faces} /> : <span />}
        <span className="text-xs text-stone-500 tabular-nums">
          {r.completedPlace === 1
            ? 'Først til 100 %'
            : `${r.claimed} av ${plural(r.members, 'person', 'personer')}`}
        </span>
      </div>
    </Link>
  )
}

function RaceRow({ standing: r, own }: { standing: RankedCohort; own: boolean }) {
  const p = percent(r.share)
  return (
    <li>
      <Link
        to="/kull/$year"
        params={{ year: r.graduationYear }}
        className="group flex items-center gap-4 py-3 text-sm"
      >
        <span className="w-6 shrink-0 text-stone-400 tabular-nums">{r.rank}.</span>
        <span className="w-20 shrink-0 font-medium text-stone-900 tabular-nums group-hover:text-brand-600 sm:w-36">
          ES {r.graduationYear}
          {own && <span className="hidden font-normal text-stone-500 sm:inline"> · ditt kull</span>}
        </span>
        <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-stone-100">
          <span className="block h-full rounded-full bg-brand-500" style={{ width: `${p}%` }} />
        </span>
        <span className="hidden w-14 shrink-0 text-right text-xs text-stone-500 tabular-nums sm:block">
          {r.claimed} av {r.members}
        </span>
        <span className="w-10 shrink-0 text-right font-medium text-stone-900 tabular-nums">
          {p} %
        </span>
      </Link>
    </li>
  )
}

function CohortCard({ cohort: c, own }: { cohort: CohortSummary; own: boolean }) {
  const share = c.members ? Math.round((c.claimed / c.members) * 100) : 0
  return (
    <Link
      to="/kull/$year"
      params={{ year: c.graduationYear }}
      className="group flex h-full flex-col rounded-2xl bg-white p-5 shadow-card ring-1 ring-stone-200/70 transition hover:-translate-y-px hover:shadow-lift hover:ring-stone-300"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-2xl font-semibold tracking-tight text-stone-950 tabular-nums group-hover:text-brand-600">
            ES {c.graduationYear}
          </p>
          <p className="text-sm text-stone-500 tabular-nums">{esPeriod(c.graduationYear)}</p>
        </div>
        {own && (
          <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700 ring-1 ring-brand-600/15 ring-inset">
            Ditt kull
          </span>
        )}
      </div>
      <div className="mt-5 flex items-center justify-between gap-3">
        <AvatarStack people={c.preview} />
        <span className="shrink-0 text-sm font-medium text-stone-700">
          {plural(c.members, 'person', 'personer')}
        </span>
      </div>
      <div className="mt-auto pt-4">
        <div className="h-1.5 overflow-hidden rounded-full bg-stone-100">
          <div className="h-full rounded-full bg-brand-500" style={{ width: `${share}%` }} />
        </div>
        <p className="mt-1.5 text-xs text-stone-500">
          {c.claimed} av {c.members} har tatt i bruk profilen
        </p>
      </div>
    </Link>
  )
}
