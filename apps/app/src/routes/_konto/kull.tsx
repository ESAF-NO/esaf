import type { CohortSummary } from '@esaf/core'
import { createFileRoute, Link } from '@tanstack/react-router'
import { GraduationCap } from 'lucide-react'
import { AvatarStack, EmptyState, PageHeader } from '#/components/ui.tsx'
import { fetchCommunity } from '#/lib/feed.functions.ts'
import { esPeriod, plural } from '#/lib/format.ts'

export const Route = createFileRoute('/_konto/kull')({
  loader: () => fetchCommunity(),
  head: () => ({ meta: [{ title: 'Kull – ESAF' }] }),
  component: Cohorts,
})

function Cohorts() {
  const { cohorts, members, claimed, ownYears } = Route.useLoaderData()
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
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {cohorts.map((c) => (
            <li key={c.graduationYear}>
              <CohortCard cohort={c} own={ownYears.includes(c.graduationYear)} />
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

function CohortCard({ cohort: c, own }: { cohort: CohortSummary; own: boolean }) {
  const share = c.members ? Math.round((c.claimed / c.members) * 100) : 0
  return (
    <Link
      to="/medlemmer"
      search={{ kull: c.graduationYear }}
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
