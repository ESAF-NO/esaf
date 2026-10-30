import type { Company } from '@esaf/core'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Building2, MapPin, Plus, Rocket, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import {
  Avatar,
  Button,
  buttonClass,
  Card,
  CompanyLogo,
  cx,
  EmptyState,
  Input,
  PageHeader,
  Select,
} from '#/components/ui.tsx'
import { roleText, statusLabels, statusOrder, type CompanyStatus } from '#/lib/companies.ts'
import { fetchCompanies } from '#/lib/companies.functions.ts'
import { fold } from '#/lib/member-search.ts'

export const Route = createFileRoute('/_konto/selskaper/')({
  validateSearch: z.object({
    q: z.string().optional().catch(undefined),
    vis: z.enum(['alle']).optional().catch(undefined),
    bransje: z.string().optional().catch(undefined),
    status: z.enum(statusOrder).optional().catch(undefined),
  }),
  loader: () => fetchCompanies(),
  head: () => ({ meta: [{ title: 'Selskaper – ESAF' }] }),
  component: Companies,
})

const PAGE = 48
const same = (a: string, b: string) => a.toLocaleLowerCase('nb') === b.toLocaleLowerCase('nb')

function Companies() {
  const companies = Route.useLoaderData()
  const { q, vis, bransje, status } = Route.useSearch()
  const { viewer } = Route.useRouteContext()
  const navigate = useNavigate({ from: Route.fullPath })
  const [shown, setShown] = useState(PAGE)
  const all = vis === 'alle'
  const founded = useMemo(() => companies.filter((c) => c.startedByAlumni), [companies])
  const tab = all ? companies : founded

  // Bransjene som finnes i fanen, mest brukt først. Skrivemåten varierer, så de telles uten store bokstaver.
  const industries = useMemo(() => {
    const counts = new Map<string, { label: string; n: number }>()
    for (const c of tab) {
      for (const tag of c.industries) {
        const key = tag.toLocaleLowerCase('nb')
        counts.set(key, { label: counts.get(key)?.label ?? tag, n: (counts.get(key)?.n ?? 0) + 1 })
      }
    }
    return [...counts.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label, 'nb'))
  }, [tab])

  // Statusene som finnes i fanen, i fast rekkefølge.
  const statuses = useMemo(
    () =>
      statusOrder
        .map((s) => ({ status: s, n: tab.filter((c) => c.status === s).length }))
        .filter((s) => s.n > 0),
    [tab],
  )

  const results = useMemo(() => {
    const words = fold(q ?? '')
      .split(/\s+/)
      .filter(Boolean)
    return tab.filter((c) => {
      if (bransje && !c.industries.some((tag) => same(tag, bransje))) return false
      if (status && c.status !== status) return false
      const text = fold(
        [
          c.name,
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
  }, [tab, q, bransje, status])

  const setSearch = (patch: { q?: string; bransje?: string; status?: CompanyStatus }) => {
    setShown(PAGE)
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })
  }

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

      <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-center">
        <div
          className="inline-flex shrink-0 self-start rounded-xl bg-stone-200/60 p-1"
          role="tablist"
        >
          {(
            [
              [undefined, 'Startet av alumni'],
              ['alle', 'Alle selskaper'],
            ] as const
          ).map(([value, label]) => (
            <Link
              key={label}
              from={Route.fullPath}
              to="/selskaper"
              search={(prev) => ({ ...prev, vis: value })}
              onClick={() => setShown(PAGE)}
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
        <div className="flex flex-1 flex-col gap-2 sm:flex-row">
          <div className="relative min-w-0 flex-1 md:max-w-md">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400"
              aria-hidden
            />
            <CompanySearchInput
              query={q ?? ''}
              onSearch={(value) => setSearch({ q: value || undefined })}
              placeholder="Søk etter selskap, person eller stilling"
              aria-label="Søk etter selskaper"
              className="pl-9"
            />
          </div>
          {(industries.length > 0 || bransje) && (
            <Select
              value={industries.find((i) => bransje && same(i.label, bransje))?.label ?? ''}
              onChange={(e) => setSearch({ bransje: e.target.value || undefined })}
              aria-label="Bransje"
              className="shrink-0 sm:w-48"
            >
              <option value="">Alle bransjer</option>
              {industries.map((i) => (
                <option key={i.label} value={i.label}>
                  {i.label} ({i.n})
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
              className="shrink-0 sm:w-44"
            >
              <option value="">Alle statuser</option>
              {statuses.map((s) => (
                <option key={s.status} value={s.status}>
                  {statusLabels[s.status]} ({s.n})
                </option>
              ))}
            </Select>
          )}
        </div>
      </div>

      {results.length === 0 ? (
        <EmptyState
          icon={Building2}
          title={q || bransje || status ? 'Ingen selskaper matcher søket' : 'Ingen selskaper ennå'}
        >
          {q || bransje || status ? (
            <p>Prøv et annet søk, eller se alle selskaper.</p>
          ) : (
            <p>
              Selskaper dukker opp her når medlemmer legger inn erfaring og ES-selskap på profilen
              sin.
            </p>
          )}
          {!q && !bransje && !status && viewer.personId && (
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
            {c.startedByAlumni && (
              <span className="inline-flex items-center gap-1 font-medium text-brand-700">
                <Rocket className="size-3.5" aria-hidden />
                {c.esCompany ? 'ES-selskap' : 'Gründerselskap'}
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
            {c.people.length === 1 ? 'Fra ES' : `${c.people.length} fra ES`}
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

/** Keep keystrokes independent of asynchronous URL navigation and list rendering. */
function CompanySearchInput({
  query,
  onSearch,
  ...props
}: {
  query: string
  onSearch: (query: string) => void
} & Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useState(query)
  const latest = useRef(query)
  const dirty = useRef(false)
  const commit = useRef(onSearch)
  useEffect(() => {
    commit.current = onSearch
  }, [onSearch])

  useEffect(() => {
    // An older navigation must never replace text entered since it started.
    if (query === latest.current) dirty.current = false
    if (!dirty.current) {
      latest.current = query
      setDraft(query)
    }
  }, [query])

  useEffect(() => {
    if (!dirty.current || draft === query) return
    const timer = setTimeout(() => commit.current(draft), 250)
    return () => clearTimeout(timer)
  }, [draft, query])

  return (
    <Input
      {...props}
      type="search"
      value={draft}
      onChange={(event) => {
        latest.current = event.target.value
        dirty.current = true
        setDraft(event.target.value)
      }}
    />
  )
}
