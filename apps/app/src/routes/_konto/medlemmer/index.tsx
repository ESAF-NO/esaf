import type { MemberListItem } from '@esaf/core'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { MapPin, Search, SearchX, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { z } from 'zod'
import {
  Avatar,
  Button,
  cx,
  EmptyState,
  Input,
  PageHeader,
  Select,
  Tag,
  Verified,
} from '#/components/ui.tsx'
import { filterMembers } from '#/lib/member-search.ts'
import { getMembers } from '#/lib/members.functions.ts'

export const Route = createFileRoute('/_konto/medlemmer/')({
  head: () => ({ meta: [{ title: 'Personer – ESAF' }] }),
  validateSearch: z.object({
    q: z.string().optional().catch(undefined),
    kull: z.coerce.number().int().optional().catch(undefined),
    verifisert: z.boolean().optional().catch(undefined),
  }),
  loader: () => getMembers(),
  component: People,
})

const PAGE = 48

function People() {
  const members = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const [shown, setShown] = useState(PAGE)

  const years = useMemo(
    () =>
      [...new Set(members.flatMap((m) => m.cohorts.map((c) => c.graduationYear)))].sort(
        (a, b) => b - a,
      ),
    [members],
  )
  // Mest brukte emner og bransjer som snarveier. Skrivemåte varierer, så de telles uten store bokstaver.
  const topTopics = useMemo(() => {
    const counts = new Map<string, { label: string; n: number }>()
    for (const m of members) {
      for (const t of [...m.expertise, ...m.industries]) {
        const key = t.toLocaleLowerCase('nb')
        const hit = counts.get(key)
        counts.set(key, { label: hit?.label ?? t, n: (hit?.n ?? 0) + 1 })
      }
    }
    return [...counts.values()]
      .filter((t) => t.n > 1)
      .sort((a, b) => b.n - a.n)
      .slice(0, 12)
      .map((t) => t.label)
  }, [members])

  const results = useMemo(
    () =>
      filterMembers(members, search)
        .filter((m) => !search.verifisert || m.claimed)
        // Verifiserte og utfylte profiler først.
        .sort(
          (a, b) =>
            Number(b.claimed) - Number(a.claimed) ||
            Number(b.experience.length > 0) - Number(a.experience.length > 0) ||
            a.fullName.localeCompare(b.fullName, 'nb'),
        ),
    [members, search],
  )
  const claimed = members.filter((m) => m.claimed).length
  const setSearch = (patch: Partial<typeof search>) => {
    setShown(PAGE)
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })
  }

  return (
    <>
      <PageHeader
        title="Personer"
        description={`${members.length} fra Entreprenørskolen · ${claimed} har tatt i bruk profilen sin`}
      />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400"
            aria-hidden
          />
          <Input
            type="search"
            value={search.q ?? ''}
            onChange={(e) => setSearch({ q: e.target.value || undefined })}
            placeholder="Navn, selskap, bransje, studieretning eller ekspertise"
            aria-label="Søk etter personer"
            className="pl-9"
          />
        </div>
        <div className="flex gap-2">
          <Select
            value={search.kull ?? ''}
            onChange={(e) =>
              setSearch({ kull: e.target.value ? Number(e.target.value) : undefined })
            }
            aria-label="Kull"
            className="w-36"
          >
            <option value="">Alle kull</option>
            {years.map((y) => (
              <option key={y} value={y}>
                ES {y}
              </option>
            ))}
          </Select>
          <Button
            variant="secondary"
            aria-pressed={Boolean(search.verifisert)}
            onClick={() => setSearch({ verifisert: search.verifisert ? undefined : true })}
            className={cx(
              search.verifisert && 'bg-brand-50 text-brand-700 ring-brand-200 hover:bg-brand-50',
            )}
          >
            <Verified claimed className="size-4" /> Verifiserte
          </Button>
        </div>
      </div>

      {topTopics.length > 0 && (
        <div className="mb-6 flex flex-wrap gap-2">
          {topTopics.map((tag) => {
            const active = search.q?.toLocaleLowerCase('nb') === tag.toLocaleLowerCase('nb')
            return (
              <button
                key={tag}
                type="button"
                onClick={() => setSearch({ q: active ? undefined : tag })}
                className={cx(
                  'inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium ring-1 transition ring-inset',
                  active
                    ? 'bg-stone-900 text-white ring-stone-900'
                    : 'bg-white text-stone-600 ring-stone-200 hover:ring-stone-300',
                )}
              >
                {tag}
                {active && <X className="size-3" aria-hidden />}
              </button>
            )
          })}
        </div>
      )}

      {results.length === 0 ? (
        <EmptyState icon={SearchX} title="Ingen treff">
          Prøv et annet søk, eller fjern filtrene.
        </EmptyState>
      ) : (
        <>
          <p className="mb-3 text-sm text-stone-500" aria-live="polite">
            {results.length === members.length ? 'Alle' : `${results.length} treff`}
          </p>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {results.slice(0, shown).map((m) => (
              <li key={m.personId}>
                <PersonCard member={m} />
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

function PersonCard({ member: m }: { member: MemberListItem }) {
  const headline = [m.jobTitle, m.currentCompany].filter(Boolean).join(' · ')
  const earlier = [...new Set(m.experience.filter((e) => e.endYear !== null).map((e) => e.company))]
  const tags = [...new Set([...m.expertise, ...m.industries])]
  return (
    <Link
      to="/medlemmer/$personId"
      params={{ personId: m.personId }}
      className="group flex h-full gap-3.5 rounded-2xl bg-white p-4 shadow-card ring-1 ring-stone-200/70 transition hover:-translate-y-px hover:shadow-lift hover:ring-stone-300"
    >
      <Avatar name={m.fullName} size="lg" muted={!m.claimed} />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1 font-semibold text-stone-950">
          <span className="truncate">{m.fullName}</span>
          <Verified claimed={m.claimed} />
        </p>
        <p className="truncate text-sm text-stone-600">{headline || m.studyBackground || ' '}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-500">
          {m.cohorts.length > 0 && (
            <span className="font-medium text-stone-700">
              ES {m.cohorts.map((c) => c.graduationYear).join(', ')}
            </span>
          )}
          {m.city && (
            <span className="inline-flex items-center gap-1">
              <MapPin className="size-3" aria-hidden />
              {m.city}
            </span>
          )}
        </div>
        {earlier.length > 0 && (
          <p className="mt-1.5 truncate text-xs text-stone-500">
            Tidligere: {earlier.slice(0, 3).join(', ')}
          </p>
        )}
        {tags.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1">
            {tags.slice(0, 3).map((t) => (
              <Tag key={t}>{t}</Tag>
            ))}
            {tags.length > 3 && <Tag className="bg-transparent">+{tags.length - 3}</Tag>}
          </div>
        )}
      </div>
    </Link>
  )
}
