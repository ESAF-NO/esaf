import type { Company, CompanyRole } from '@esaf/core'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Building2, Plus, Rocket, Search } from 'lucide-react'
import { useMemo } from 'react'
import { z } from 'zod'
import {
  Avatar,
  buttonClass,
  Card,
  CompanyMark,
  cx,
  EmptyState,
  Input,
  PageHeader,
} from '#/components/ui.tsx'
import { fetchCompanies } from '#/lib/feed.functions.ts'
import { fold } from '#/lib/member-search.ts'

export const Route = createFileRoute('/_konto/selskaper')({
  validateSearch: z.object({
    q: z.string().optional().catch(undefined),
    vis: z.enum(['alle']).optional().catch(undefined),
  }),
  loader: () => fetchCompanies(),
  head: () => ({ meta: [{ title: 'Selskaper – ESAF' }] }),
  component: Companies,
})

/** Hva personen er eller var i selskapet, kort nok til å stå ved navnet. */
function roleText(role: CompanyRole, title: string | null) {
  if (role === 'founder') return 'Gründer'
  if (role === 'es') return 'ES-team'
  if (role === 'current') return title ?? 'Jobber der'
  return title ? `Tidl. ${title}` : 'Har jobbet der'
}

function Companies() {
  const companies = Route.useLoaderData()
  const { q, vis } = Route.useSearch()
  const { viewer } = Route.useRouteContext()
  const navigate = useNavigate({ from: Route.fullPath })
  const all = vis === 'alle'
  const founded = useMemo(() => companies.filter((c) => c.startedByAlumni), [companies])

  const results = useMemo(() => {
    const words = fold(q ?? '')
      .split(/\s+/)
      .filter(Boolean)
    return (all ? companies : founded).filter((c) => {
      const text = fold([c.name, ...c.people.flatMap((p) => [p.fullName, p.title])].join(' '))
      return words.every((w) => text.includes(w))
    })
  }, [companies, founded, all, q])

  return (
    <>
      <PageHeader
        title="Selskaper"
        description={
          companies.length
            ? `${founded.length} startet av ES-alumni · ${companies.length} der ES-ere jobber eller har jobbet`
            : 'Selskaper ES-alumni har startet, jobber i eller har jobbet i.'
        }
      />

      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="inline-flex shrink-0 rounded-xl bg-stone-200/60 p-1" role="tablist">
          {(
            [
              [undefined, 'Startet av alumni'],
              ['alle', 'Alle selskaper'],
            ] as const
          ).map(([value, label]) => (
            <Link
              key={label}
              to="/selskaper"
              search={(prev) => ({ ...prev, vis: value })}
              role="tab"
              aria-selected={vis === value}
              className={cx(
                'inline-flex h-8 items-center rounded-lg px-3 text-sm font-medium transition',
                vis === value
                  ? 'bg-white text-stone-950 shadow-card'
                  : 'text-stone-600 hover:text-stone-900',
              )}
            >
              {label}
            </Link>
          ))}
        </div>
        <div className="relative flex-1 sm:max-w-md">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400"
            aria-hidden
          />
          <Input
            type="search"
            value={q ?? ''}
            onChange={(e) =>
              navigate({
                search: (prev) => ({ ...prev, q: e.target.value || undefined }),
                replace: true,
              })
            }
            placeholder="Søk etter selskap, person eller stilling"
            aria-label="Søk etter selskaper"
            className="pl-9"
          />
        </div>
      </div>

      {results.length === 0 ? (
        <EmptyState
          icon={Building2}
          title={q ? 'Ingen selskaper matcher søket' : 'Ingen selskaper ennå'}
        >
          <p>
            Selskaper dukker opp her når medlemmer legger inn erfaring og ES-selskap på profilen
            sin.
          </p>
          {!q && viewer.personId && (
            <Link
              to="/medlemmer/$personId/rediger"
              params={{ personId: viewer.personId }}
              className={buttonClass({ variant: 'secondary', size: 'sm' }, 'mt-4')}
            >
              <Plus className="size-4" aria-hidden /> Legg inn din erfaring
            </Link>
          )}
        </EmptyState>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {results.map((c) => (
            <li key={c.slug}>
              <CompanyCard company={c} />
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

function CompanyCard({ company: c }: { company: Company }) {
  return (
    <Card className="flex h-full flex-col p-5">
      <div className="flex items-center gap-3">
        <CompanyMark name={c.name} className="size-12 text-lg" />
        <div className="min-w-0">
          <h2 className="truncate font-semibold text-stone-950">{c.name}</h2>
          <p className="flex flex-wrap items-center gap-x-2 text-sm text-stone-500">
            {c.startedByAlumni && (
              <span className="inline-flex items-center gap-1 font-medium text-brand-700">
                <Rocket className="size-3.5" aria-hidden />
                {c.esCompany ? 'ES-selskap' : 'Gründerselskap'}
              </span>
            )}
            {c.cohortYears.length > 0 && <span>ES {c.cohortYears.join(', ')}</span>}
          </p>
        </div>
      </div>
      <div className="mt-4 border-t border-stone-100 pt-4">
        <p className="mb-2 text-xs font-medium text-stone-500">
          {c.people.length === 1 ? 'Fra ES' : `${c.people.length} fra ES`}
        </p>
        <ul className="space-y-2">
          {c.people.slice(0, 4).map((p) => (
            <li key={p.personId}>
              <Link
                to="/medlemmer/$personId"
                params={{ personId: p.personId }}
                className="flex items-center gap-2 rounded-lg text-sm text-stone-700 hover:text-brand-600"
              >
                <Avatar name={p.fullName} size="xs" muted={!p.claimed} />
                <span className="min-w-0 flex-1 truncate">{p.fullName}</span>
                <span className="max-w-[45%] shrink-0 truncate text-xs text-stone-500">
                  {roleText(p.role, p.title)}
                </span>
              </Link>
            </li>
          ))}
          {c.people.length > 4 && (
            <li className="pl-8 text-xs text-stone-500">+{c.people.length - 4} til</li>
          )}
        </ul>
      </div>
    </Card>
  )
}
