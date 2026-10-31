import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { Search, SearchX, Sparkles, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { z } from 'zod'
import { comparePeople, PersonCard } from '#/components/PersonCard.tsx'
import { SearchInput } from '#/components/SearchInput.tsx'
import { Button, cx, EmptyState, PageHeader, Select, Verified } from '#/components/ui.tsx'
import { filterMembers } from '#/lib/member-search.ts'
import { findPeopleByTopic, getMembers } from '#/lib/members.functions.ts'

export const Route = createFileRoute('/_konto/medlemmer/')({
  head: () => ({ meta: [{ title: 'Personer – ESAF' }] }),
  validateSearch: z.object({
    q: z.string().optional().catch(undefined),
    kull: z.coerce.number().int().optional().catch(undefined),
    verifisert: z.boolean().optional().catch(undefined),
  }),
  loader: async () => ({ members: await getMembers() }),
  component: People,
})

type Found = Awaited<ReturnType<typeof findPeopleByTopic>>

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
    const keep = (m: (typeof members)[number]) =>
      (!search.verifisert || m.claimed) &&
      (search.kull === undefined || m.cohorts.some((c) => c.graduationYear === search.kull))
    const local = filterMembers(members, search)
      .filter((m) => !search.verifisert || m.claimed)
      .sort(comparePeople)
    if (!serverHits) return local
    const byId = new Map(members.map((m) => [m.personId, m]))
    const fromServer = serverHits.flatMap((h) => {
      const m = byId.get(h.personId)
      return m && keep(m) ? [m] : []
    })
    const seen = new Set(fromServer.map((m) => m.personId))
    return [...fromServer, ...local.filter((m) => !seen.has(m.personId))]
  }, [members, search, serverHits])
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
          <SearchInput
            query={search.q ?? ''}
            onSearch={(value) => setSearch({ q: value || undefined })}
            placeholder="Navn, eller hva de kan: «space», «oppdrett», «fintech», «maskinlæring»"
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
