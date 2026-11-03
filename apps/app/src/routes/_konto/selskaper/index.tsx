import type { Company } from '@esaf/core'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Briefcase, Building2, Landmark, MapPin, Plus, Rocket, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { z } from 'zod'
import { SearchInput } from '#/components/SearchInput.tsx'
import { FilterSummary, Segmented, sameText, tally } from '#/components/Filters.tsx'
import {
  Avatar,
  Button,
  buttonClass,
  Card,
  CompanyLogo,
  EmptyState,
  PageHeader,
  Select,
} from '#/components/ui.tsx'
import { roleText, statusLabels, statusOrder, type CompanyStatus } from '#/lib/companies.ts'
import { fetchCompanies } from '#/lib/companies.functions.ts'
import { fold } from '#/lib/member-search.ts'

const views = ['es', 'jobb', 'styre', 'alle'] as const
const sorts = ['navn', 'nyest'] as const

export const Route = createFileRoute('/_konto/selskaper/')({
  validateSearch: z.object({
    q: z.string().optional().catch(undefined),
    /**
     * Uten: startet av alumni. `es`: startet på Entreprenørskolen. `jobb`: der
     * alumni jobber eller har jobbet. `styre`: bare styreverv. `alle`: alle.
     */
    vis: z.enum(views).optional().catch(undefined),
    bransje: z.string().optional().catch(undefined),
    status: z.enum(statusOrder).optional().catch(undefined),
    kull: z.coerce.number().int().optional().catch(undefined),
    /** Uten: flest fra ES først. */
    sorter: z.enum(sorts).optional().catch(undefined),
  }),
  loader: () => fetchCompanies(),
  head: () => ({ meta: [{ title: 'Selskaper – ESAF' }] }),
  component: Companies,
})

type Search = ReturnType<typeof Route.useSearch>

const PAGE = 48

function Companies() {
  const companies = Route.useLoaderData()
  const search = Route.useSearch()
  const { q, vis, bransje, status, kull, sorter } = search
  const { viewer } = Route.useRouteContext()
  const navigate = useNavigate({ from: Route.fullPath })
  const [shown, setShown] = useState(PAGE)

  const founded = useMemo(() => companies.filter((c) => c.startedByAlumni), [companies])
  const atEs = useMemo(() => companies.filter((c) => c.esCompany), [companies])
  const workplaces = useMemo(
    () => companies.filter((c) => !c.startedByAlumni && !c.boardOnly),
    [companies],
  )
  const boards = useMemo(() => companies.filter((c) => c.boardOnly), [companies])
  const tab =
    vis === 'alle'
      ? companies
      : vis === 'es'
        ? atEs
        : vis === 'jobb'
          ? workplaces
          : vis === 'styre'
            ? boards
            : founded

  // Valgene i nedtrekkslistene er det som finnes i fanen, med antall.
  const industries = useMemo(() => tally(tab, (c) => c.industries), [tab])
  const statuses = useMemo(
    () =>
      statusOrder
        .map((s) => ({ status: s, n: tab.filter((c) => c.status === s).length }))
        .filter((s) => s.n > 0),
    [tab],
  )
  const years = useMemo(
    () => [...new Set(tab.flatMap((c) => c.cohortYears))].sort((a, b) => b - a),
    [tab],
  )

  const results = useMemo(() => {
    const words = fold(q ?? '')
      .split(/\s+/)
      .filter(Boolean)
    const hits = tab.filter((c) => {
      if (bransje && !c.industries.some((tag) => sameText(tag, bransje))) return false
      if (status && c.status !== status) return false
      if (kull !== undefined && !c.cohortYears.includes(kull)) return false
      const text = fold(
        [
          c.name,
          ...c.formerNames,
          c.tagline,
          c.location,
          ...c.industries,
          ...c.people.flatMap((p) => [p.fullName, p.title]),
        ]
          .filter(Boolean)
          .join(' '),
      )
      return words.every((w) => text.includes(w))
    })
    if (sorter === 'navn') return [...hits].sort((a, b) => a.name.localeCompare(b.name, 'nb'))
    if (sorter === 'nyest') {
      const newest = (c: Company) => Math.max(0, ...c.cohortYears)
      return [...hits].sort((a, b) => newest(b) - newest(a) || a.name.localeCompare(b.name, 'nb'))
    }
    return hits
  }, [tab, q, bransje, status, kull, sorter])

  const setSearch = (patch: Partial<Search>) => {
    setShown(PAGE)
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })
  }
  const filtered = Boolean(q || bransje || status || kull !== undefined)
  const reset = () =>
    setSearch({ q: undefined, bransje: undefined, status: undefined, kull: undefined })

  return (
    <>
      <PageHeader
        title="Selskaper"
        description={
          companies.length
            ? `${founded.length} startet av ES-alumni, ${atEs.length} av dem på Entreprenørskolen · ${workplaces.length} arbeidsplasser · ${boards.length} med ES-alumni i styret`
            : 'Selskaper ES-alumni har startet, jobber i eller har jobbet i.'
        }
      />

      <div className="mb-4 flex flex-col gap-3">
        <Segmented
          label="Hvilke selskaper"
          value={vis}
          onChange={(value) => setSearch({ vis: value })}
          options={[
            { value: undefined, label: 'Startet av alumni', count: founded.length },
            { value: 'es', label: 'Startet på ES', count: atEs.length },
            { value: 'jobb', label: 'Arbeidsplasser', count: workplaces.length },
            { value: 'styre', label: 'Styreverv', count: boards.length },
            { value: 'alle', label: 'Alle', count: companies.length },
          ]}
        />
        <div className="flex flex-col gap-2 lg:flex-row">
          <div className="relative min-w-0 flex-1">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400"
              aria-hidden
            />
            <SearchInput
              query={q ?? ''}
              onSearch={(value) => setSearch({ q: value || undefined })}
              placeholder="Søk etter selskap, person eller stilling"
              aria-label="Søk etter selskaper"
              className="pl-9"
            />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex">
            {(industries.length > 0 || bransje) && (
              <Select
                value={industries.find((i) => sameText(bransje, i.label))?.label ?? ''}
                onChange={(e) => setSearch({ bransje: e.target.value || undefined })}
                aria-label="Bransje"
                className="sm:w-44"
              >
                <option value="">Alle bransjer</option>
                {industries.map((i) => (
                  <option key={i.label} value={i.label}>
                    {i.label} ({i.n})
                  </option>
                ))}
              </Select>
            )}
            {(years.length > 0 || kull !== undefined) && (
              <Select
                value={kull ?? ''}
                onChange={(e) =>
                  setSearch({ kull: e.target.value ? Number(e.target.value) : undefined })
                }
                aria-label="Kull"
                className="sm:w-32"
              >
                <option value="">Alle kull</option>
                {years.map((y) => (
                  <option key={y} value={y}>
                    ES {y}
                  </option>
                ))}
              </Select>
            )}
            {(statuses.length > 1 || status) && (
              <Select
                value={status ?? ''}
                onChange={(e) =>
                  setSearch({ status: (e.target.value || undefined) as CompanyStatus | undefined })
                }
                aria-label="Status"
                className="sm:w-40"
              >
                <option value="">Alle statuser</option>
                {statuses.map((s) => (
                  <option key={s.status} value={s.status}>
                    {statusLabels[s.status]} ({s.n})
                  </option>
                ))}
              </Select>
            )}
            <Select
              value={sorter ?? ''}
              onChange={(e) =>
                setSearch({ sorter: (e.target.value || undefined) as Search['sorter'] })
              }
              aria-label="Sortering"
              className="sm:w-40"
            >
              <option value="">Flest fra ES</option>
              <option value="nyest">Nyeste kull</option>
              <option value="navn">Navn A–Å</option>
            </Select>
          </div>
        </div>
      </div>

      {results.length === 0 ? (
        <EmptyState
          icon={Building2}
          title={filtered ? 'Ingen selskaper matcher søket' : 'Ingen selskaper ennå'}
        >
          {filtered ? (
            <>
              <p>Prøv et annet søk, eller fjern filtrene.</p>
              <Button variant="secondary" size="sm" className="mt-4" onClick={reset}>
                Nullstill filtre
              </Button>
            </>
          ) : (
            <p>
              Selskaper dukker opp her når medlemmer legger inn erfaring og ES-selskap på profilen
              sin.
            </p>
          )}
          {!filtered && viewer.personId && (
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
        <>
          <FilterSummary onReset={filtered ? reset : undefined}>
            {filtered ? `${results.length} av ${tab.length} selskaper` : `${tab.length} selskaper`}
          </FilterSummary>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {results.slice(0, shown).map((c) => (
              <li key={c.id}>
                <CompanyCard company={c} />
              </li>
            ))}
          </ul>
          {shown < results.length && (
            <div className="mt-6 text-center">
              <Button variant="secondary" onClick={() => setShown((n) => n + PAGE)}>
                Vis flere ({results.length - shown} til)
              </Button>
            </div>
          )}
        </>
      )}
    </>
  )
}

/** Hele kortet går til selskapssiden; personene i det går til profilene sine. */
function CompanyCard({ company: c }: { company: Company }) {
  return (
    <Card className="relative flex h-full flex-col p-5 transition hover:-translate-y-px hover:shadow-lift hover:ring-stone-300">
      <div className="flex items-center gap-3">
        <CompanyLogo name={c.name} logo={c.logo} size="lg" />
        <div className="min-w-0">
          <h2 className="truncate font-semibold text-stone-950">
            <Link
              to="/selskaper/$slug"
              params={{ slug: c.slug }}
              className="after:absolute after:inset-0 after:rounded-2xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-brand-500"
            >
              {c.name}
            </Link>
          </h2>
          <p className="flex flex-wrap items-center gap-x-2 text-sm text-stone-500">
            {c.startedByAlumni ? (
              <span className="inline-flex items-center gap-1 font-medium text-brand-700">
                <Rocket className="size-3.5" aria-hidden />
                {c.esCompany ? 'ES-selskap' : 'Gründerselskap'}
              </span>
            ) : c.boardOnly ? (
              <span className="inline-flex items-center gap-1">
                <Landmark className="size-3.5" aria-hidden />
                Styreverv
              </span>
            ) : (
              <span className="inline-flex items-center gap-1">
                <Briefcase className="size-3.5" aria-hidden />
                Arbeidsplass
              </span>
            )}
            {c.cohortYears.length > 0 && <span>ES {c.cohortYears.join(', ')}</span>}
            {c.status !== 'active' && <span>{statusLabels[c.status]}</span>}
          </p>
        </div>
      </div>
      {(c.tagline || c.location) && (
        <div className="mt-3 space-y-1 text-sm">
          {c.tagline && <p className="line-clamp-2 text-stone-700">{c.tagline}</p>}
          {c.location && (
            <p className="inline-flex items-center gap-1 text-xs text-stone-500">
              <MapPin className="size-3" aria-hidden /> {c.location}
            </p>
          )}
        </div>
      )}
      <div className="mt-auto pt-4">
        <div className="border-t border-stone-100 pt-4">
          <p className="mb-2 text-xs font-medium text-stone-500">
            {c.boardOnly
              ? c.people.length === 1
                ? 'I styret'
                : `${c.people.length} i styret`
              : c.people.length === 1
                ? 'Fra ES'
                : `${c.people.length} fra ES`}
          </p>
          <ul className="space-y-2">
            {c.people.slice(0, 4).map((p) => (
              <li key={p.personId}>
                <Link
                  to="/medlemmer/$personId"
                  params={{ personId: p.personId }}
                  className="relative flex items-center gap-2 rounded-lg text-sm text-stone-700 hover:text-brand-600"
                >
                  <Avatar name={p.fullName} photo={p.photo} size="xs" muted={!p.claimed} />
                  <span className="min-w-0 flex-1 truncate">{p.fullName}</span>
                  <span className="max-w-[45%] shrink-0 truncate text-xs text-stone-500">
                    {roleText(p)}
                  </span>
                </Link>
              </li>
            ))}
            {c.people.length > 4 && (
              <li className="pl-8 text-xs text-stone-500">+{c.people.length - 4} til</li>
            )}
          </ul>
        </div>
      </div>
    </Card>
  )
}
