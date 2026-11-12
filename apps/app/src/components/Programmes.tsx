import type { CompanyEvent, ProgrammeCompany } from '@esaf/core'
import { Link } from '@tanstack/react-router'
import { Card, CompanyLogo } from './ui.tsx'
import { programmeKindLabels } from '#/lib/companies.ts'
import { partialDate } from '#/lib/format.ts'

/** «Akselerator · W22 · 2022» */
function programmeDetail(kind: ProgrammeCompany['kind'], batch: string | null, year: string) {
  return [programmeKindLabels[kind], batch, year].filter(Boolean).join(' · ')
}

/**
 * Programmene selskapet gikk gjennom (akseleratorer, inkubatorer), eldste
 * først, med lenke til programmets side. Fra historikken.
 */
export function ProgrammesCard({ events }: { events: CompanyEvent[] }) {
  const programmes = events
    .filter((e) => e.programme && !e.review)
    .sort((a, b) => a.date.localeCompare(b.date))
  if (!programmes.length) return null
  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-stone-950">Programmer</h2>
      <ul className="mt-3 space-y-3">
        {programmes.map((e) => {
          const p = e.programme!
          const detail = programmeDetail(p.kind, p.batch, e.date.slice(0, 4))
          const name = p.company?.name ?? e.text
          const body = (
            <>
              <CompanyLogo name={name} logo={p.company?.logo ?? null} size="sm" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-stone-900">{name}</span>
                <span className="block truncate text-xs text-stone-500">{detail}</span>
              </span>
            </>
          )
          return (
            <li key={e.id}>
              {p.company ? (
                <Link
                  to="/selskaper/$slug"
                  params={{ slug: p.company.slug }}
                  className="-mx-2 flex items-center gap-3 rounded-xl px-2 py-1.5 transition hover:bg-stone-50"
                >
                  {body}
                </Link>
              ) : (
                <div className="flex items-center gap-3 py-1.5">{body}</div>
              )}
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

/**
 * På siden til et program: selskapene i ESAF som har vært med, gruppert på år,
 * nyeste først.
 */
export function ProgrammeCompaniesCard({
  name,
  companies,
}: {
  name: string
  companies: ProgrammeCompany[]
}) {
  if (!companies.length) return null
  const years = new Map<string, ProgrammeCompany[]>()
  for (const c of companies) {
    const year = c.date.slice(0, 4)
    years.set(year, [...(years.get(year) ?? []), c])
  }
  const distinct = new Set(companies.map((c) => c.company.id)).size
  return (
    <Card className="p-5 sm:p-6">
      <h2 className="text-sm font-semibold text-stone-950">
        Selskaper i programmet{' '}
        <span className="font-normal text-stone-500 tabular-nums">{distinct}</span>
      </h2>
      <p className="mt-1 text-sm text-stone-500">
        Selskaper fra ES-miljøet som har vært med i {name}.
      </p>
      <div className="mt-4 space-y-5">
        {[...years].map(([year, rows]) => (
          <section key={year}>
            <h3 className="text-xs font-semibold text-stone-500 tabular-nums">{year}</h3>
            <ul className="mt-1">
              {rows.map((r) => (
                <li key={r.eventId}>
                  <Link
                    to="/selskaper/$slug"
                    params={{ slug: r.company.slug }}
                    className="-mx-2 flex items-center gap-3 rounded-xl px-2 py-2.5 transition hover:bg-stone-50"
                  >
                    <CompanyLogo name={r.company.name} logo={r.company.logo} size="md" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-stone-900">
                        {r.company.name}
                      </span>
                      {r.company.tagline && (
                        <span className="block truncate text-sm text-stone-500">
                          {r.company.tagline}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-xs text-stone-500">
                      {r.batch ?? partialDate(r.date, r.datePrecision)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Card>
  )
}
