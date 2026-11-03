import type { MemberListItem } from '@esaf/core'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { Rocket, Search, SearchX, Sparkles, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { z } from 'zod'
import { FilterSummary, sameText, tally, ToggleChip } from '#/components/Filters.tsx'
import { comparePeople, PersonCard } from '#/components/PersonCard.tsx'
import { SearchInput } from '#/components/SearchInput.tsx'
import { Button, cx, EmptyState, PageHeader, Select, Verified } from '#/components/ui.tsx'
import { filterMembers } from '#/lib/member-search.ts'
import { findPeopleByTopic, getMembers } from '#/lib/members.functions.ts'

const searchSchema = z.object({
  q: z.string().optional().catch(undefined),
  kull: z.coerce.number().int().optional().catch(undefined),
  /** Tilknytning til ES: student, mentor eller ansatt (i kullet over, om det er valgt). */
  rolle: z.enum(['student', 'mentor', 'staff']).optional().catch(undefined),
  sted: z.string().optional().catch(undefined),
  grunder: z.boolean().optional().catch(undefined),
  verifisert: z.boolean().optional().catch(undefined),
})

export const Route = createFileRoute('/_konto/medlemmer/')({
  head: () => ({ meta: [{ title: 'Personer – ESAF' }] }),
  validateSearch: searchSchema,
  loader: async () => ({ members: await getMembers() }),
  component: People,
})

type Found = Awaited<ReturnType<typeof findPeopleByTopic>>
type Member = MemberListItem
type Search = z.infer<typeof searchSchema>

const roles = [
  { value: 'student', label: 'Studenter' },
  { value: 'mentor', label: 'Mentorer' },
  { value: 'staff', label: 'Ansatte ved ES' },
] as const

/** Filtrene utenom søkeordene. Kull og rolle må gjelde samme kull. */
function matches(m: Member, s: Search) {
  if (s.verifisert && !m.claimed) return false
  if (s.grunder && !m.experience.some((e) => e.founder)) return false
  if (s.sted && !sameText(m.city, s.sted)) return false
  if (s.kull !== undefined || s.rolle) {
    return m.cohorts.some(
      (c) =>
        (s.kull === undefined || c.graduationYear === s.kull) &&
        (!s.rolle || c.relation === s.rolle),
    )
  }
  return true
}

const PAGE = 48

function People() {
  const { members } = Route.useLoaderData()
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

  // Søket på serveren finner også folk på det de kan (også ord som ikke står i
  // profilen, som «space» for noen i et romfartsselskap), med grunnen til treffet.
  // Mens det går, vises ordtreffene fra lista med en gang.
  const find = useServerFn(findPeopleByTopic)
  const query = search.q?.trim() ?? ''
  const [ranked, setRanked] = useState<{ q: string; found: Found } | null>(null)
  useEffect(() => {
    if (query.length < 2) return
    let cancelled = false
    const timer = setTimeout(() => {
      find({ data: { q: query } })
        .then((found) => {
          if (!cancelled) setRanked({ q: query, found })
        })
        .catch(() => {})
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, find])
  const serverHits = ranked?.q === query && query.length >= 2 ? ranked.found : null
  const reasons = useMemo(
    () =>
      new Map(
        (serverHits ?? []).map((h) => [h.personId, h.matchedBy === 'name' ? null : h.reason]),
      ),
    [serverHits],
  )

  const results = useMemo(() => {
    const local = filterMembers(members, { q: search.q })
      .filter((m) => matches(m, search))
      .sort(comparePeople)
    if (!serverHits) return local
    const byId = new Map(members.map((m) => [m.personId, m]))
    const fromServer = serverHits.flatMap((h) => {
      const m = byId.get(h.personId)
      return m && matches(m, search) ? [m] : []
    })
    const seen = new Set(fromServer.map((m) => m.personId))
    return [...fromServer, ...local.filter((m) => !seen.has(m.personId))]
  }, [members, search, serverHits])
  const claimed = members.filter((m) => m.claimed).length
  const founders = useMemo(
    () => members.filter((m) => m.experience.some((e) => e.founder)).length,
    [members],
  )
  const cities = useMemo(() => tally(members, (m) => [m.city]).filter((c) => c.n > 1), [members])
  const setSearch = (patch: Partial<Search>) => {
    setShown(PAGE)
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })
  }
  const filtered = Boolean(
    search.q ||
    search.kull !== undefined ||
    search.rolle ||
    search.sted ||
    search.grunder ||
    search.verifisert,
  )
  const reset = () =>
    setSearch({
      q: undefined,
      kull: undefined,
      rolle: undefined,
      sted: undefined,
      grunder: undefined,
      verifisert: undefined,
    })

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
          <SearchInput
            query={search.q ?? ''}
            onSearch={(value) => setSearch({ q: value || undefined })}
            placeholder="Navn, eller hva de kan: «space», «oppdrett», «fintech», «maskinlæring»"
            aria-label="Søk etter personer"
            className="pl-9"
          />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <Select
            value={search.kull ?? ''}
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
          <Select
            value={search.rolle ?? ''}
            onChange={(e) => setSearch({ rolle: (e.target.value || undefined) as Search['rolle'] })}
            aria-label="Tilknytning til ES"
            className="sm:w-40"
          >
            <option value="">Alle roller</option>
            {roles.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </Select>
          {(cities.length > 0 || search.sted) && (
            <Select
              value={cities.find((c) => sameText(search.sted, c.label))?.label ?? ''}
              onChange={(e) => setSearch({ sted: e.target.value || undefined })}
              aria-label="Sted"
              className="sm:w-40"
            >
              <option value="">Alle steder</option>
              {cities.map((c) => (
                <option key={c.label} value={c.label}>
                  {c.label} ({c.n})
                </option>
              ))}
            </Select>
          )}
        </div>
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        <ToggleChip
          pressed={Boolean(search.grunder)}
          onToggle={() => setSearch({ grunder: search.grunder ? undefined : true })}
        >
          <Rocket className="size-4" aria-hidden /> Gründere
          <span className="text-xs text-stone-400 tabular-nums">{founders}</span>
        </ToggleChip>
        <ToggleChip
          pressed={Boolean(search.verifisert)}
          onToggle={() => setSearch({ verifisert: search.verifisert ? undefined : true })}
        >
          <Verified claimed className="size-4" /> Verifiserte
          <span className="text-xs text-stone-400 tabular-nums">{claimed}</span>
        </ToggleChip>
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
          <p>Prøv et annet søk, eller fjern filtrene.</p>
          {filtered && (
            <Button variant="secondary" size="sm" className="mt-4" onClick={reset}>
              Nullstill filtre
            </Button>
          )}
        </EmptyState>
      ) : (
        <>
          <FilterSummary onReset={filtered ? reset : undefined}>
            {filtered
              ? `${results.length} av ${members.length} personer`
              : `${members.length} personer`}
          </FilterSummary>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {results.slice(0, shown).map((m) => {
              const reason = reasons.get(m.personId)
              return (
                <li key={m.personId} className="flex flex-col gap-1.5">
                  <PersonCard member={m} />
                  {reason && (
                    <p className="flex gap-1.5 px-1 text-xs leading-snug text-stone-500">
                      <Sparkles className="mt-0.5 size-3 shrink-0 text-brand-500" aria-hidden />
                      <span className="line-clamp-2">{reason}</span>
                    </p>
                  )}
                </li>
              )
            })}
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
