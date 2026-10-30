import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { LoaderCircle, MessageCircleQuestion, Search, SearchX, Sparkles, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { z } from 'zod'
import { comparePeople, PersonCard } from '#/components/PersonCard.tsx'
import {
  Button,
  cx,
  EmptyState,
  ErrorText,
  Input,
  PageHeader,
  Select,
  Verified,
} from '#/components/ui.tsx'
import { filterMembers } from '#/lib/member-search.ts'
import {
  askEsaf,
  findPeopleByTopic,
  getMembers,
  getSearchFeatures,
} from '#/lib/members.functions.ts'

export const Route = createFileRoute('/_konto/medlemmer/')({
  head: () => ({ meta: [{ title: 'Personer – ESAF' }] }),
  validateSearch: z.object({
    q: z.string().optional().catch(undefined),
    kull: z.coerce.number().int().optional().catch(undefined),
    verifisert: z.boolean().optional().catch(undefined),
  }),
  loader: async () => {
    const [members, features] = await Promise.all([getMembers(), getSearchFeatures()])
    return { members, features }
  },
  component: People,
})

type Found = Awaited<ReturnType<typeof findPeopleByTopic>>
type Asked = Awaited<ReturnType<typeof askEsaf>>

const PAGE = 48

function People() {
  const { members, features } = Route.useLoaderData()
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
  // Mens det går, vises ordtreffene fra lista med en gang. Med Claude slått på
  // kommer et søk til når man har sluttet å skrive: tolket (emner, by, kull),
  // og det erstatter treffene når det kommer.
  const find = useServerFn(findPeopleByTopic)
  const query = search.q?.trim() ?? ''
  const [ranked, setRanked] = useState<{ q: string; smart: boolean; found: Found } | null>(null)
  useEffect(() => {
    if (query.length < 2) return
    let cancelled = false
    const run = (smart: boolean) =>
      find({ data: { q: query, smart } })
        .then((found) => {
          if (cancelled) return
          // Et raskt svar skal ikke overskrive et tolket svar på samme søk.
          setRanked((prev) =>
            !smart && prev?.q === query && prev.smart ? prev : { q: query, smart, found },
          )
        })
        .catch(() => {})
    const fast = setTimeout(() => void run(false), 250)
    const smart = features.ai && query.length >= 3 ? setTimeout(() => void run(true), 900) : null
    return () => {
      cancelled = true
      clearTimeout(fast)
      if (smart) clearTimeout(smart)
    }
  }, [query, find, features.ai])
  const current = ranked?.q === query && query.length >= 2 ? ranked.found : null
  const serverHits = current?.hits ?? null
  const interpreted = current?.interpreted ?? null

  // Spør ESAF: Claude leser kandidatene og svarer med dem som passer, og hvorfor.
  const ask = useServerFn(askEsaf)
  const [asking, setAsking] = useState<string | null>(null)
  const [answer, setAnswer] = useState<Asked | null>(null)
  const [askError, setAskError] = useState<string | null>(null)
  async function askQuestion() {
    if (query.length < 3 || asking) return
    setAsking(query)
    setAskError(null)
    try {
      setAnswer(await ask({ data: { question: query } }))
    } catch (e) {
      setAnswer(null)
      setAskError(e instanceof Error ? e.message : 'Fikk ikke svar akkurat nå.')
    } finally {
      setAsking(null)
    }
  }
  const byId = useMemo(() => new Map(members.map((m) => [m.personId, m])), [members])
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
          <Input
            type="search"
            value={search.q ?? ''}
            onChange={(e) => setSearch({ q: e.target.value || undefined })}
            onKeyDown={(e) => {
              // ⌘/Ctrl+Enter: spør ESAF i stedet for å søke.
              if (features.ai && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void askQuestion()
            }}
            placeholder={
              features.ai
                ? 'Navn, hva de kan, eller et spørsmål: «hvem kan hjelpe meg å selge til sykehus?»'
                : 'Navn, eller hva de kan: «space», «oppdrett», «fintech», «maskinlæring»'
            }
            aria-label="Søk etter personer"
            className="pl-9"
          />
        </div>
        {features.ai && (
          <Button
            variant="secondary"
            onClick={() => void askQuestion()}
            disabled={query.length < 3 || asking !== null}
            title="Claude leser profilene som passer og forklarer hvorfor (⌘ Enter)"
          >
            {asking ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
            ) : (
              <MessageCircleQuestion className="size-4" aria-hidden />
            )}
            Spør ESAF
          </Button>
        )}
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

      {(asking || answer || askError) && (
        <section
          aria-label="Svar fra Spør ESAF"
          aria-busy={asking !== null}
          className="mb-8 rounded-2xl bg-brand-50/60 p-4 ring-1 ring-brand-100 sm:p-5"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-brand-700 uppercase">
                <Sparkles className="size-3.5" aria-hidden /> Spør ESAF
              </p>
              <p className="mt-1 font-medium text-stone-900">
                {asking ?? answer?.question ?? query}
              </p>
            </div>
            {!asking && (
              <button
                type="button"
                onClick={() => {
                  setAnswer(null)
                  setAskError(null)
                }}
                className="rounded-full p-1 text-stone-500 hover:bg-white hover:text-stone-800"
                aria-label="Lukk svaret"
              >
                <X className="size-4" aria-hidden />
              </button>
            )}
          </div>
          {asking ? (
            <p className="mt-3 flex items-center gap-2 text-sm text-stone-600" aria-live="polite">
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
              Claude leser profilene som kan passe …
            </p>
          ) : askError ? (
            <div className="mt-3">
              <ErrorText>{askError}</ErrorText>
            </div>
          ) : answer ? (
            <>
              <p className="mt-2 text-sm text-stone-700" aria-live="polite">
                {answer.summary ||
                  (answer.hits.length
                    ? ''
                    : 'Fant ingen som passer godt. Prøv å si det på en annen måte.')}
              </p>
              {answer.filters && (
                <p className="mt-1 text-xs text-stone-500">Avgrenset til {answer.filters}</p>
              )}
              {answer.hits.length > 0 && (
                <ul className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {answer.hits.flatMap((h) => {
                    const m = byId.get(h.personId)
                    if (!m) return []
                    return [
                      <li key={h.personId} className="flex flex-col gap-1.5">
                        <PersonCard member={m} />
                        <p className="flex gap-1.5 px-1 text-xs leading-snug text-stone-600">
                          <Sparkles
                            className={cx(
                              'mt-0.5 size-3 shrink-0',
                              h.strong ? 'text-brand-500' : 'text-stone-400',
                            )}
                            aria-hidden
                          />
                          <span>{h.why}</span>
                        </p>
                      </li>,
                    ]
                  })}
                </ul>
              )}
              <p className="mt-4 text-xs text-stone-500">
                Svaret er skrevet av Claude fra det som står på profilene, og kan ta feil.
              </p>
            </>
          ) : null}
        </section>
      )}

      {results.length === 0 ? (
        <EmptyState icon={SearchX} title="Ingen treff">
          Prøv et annet søk, eller fjern filtrene.
        </EmptyState>
      ) : (
        <>
          <p className="mb-3 text-sm text-stone-500" aria-live="polite">
            {results.length === members.length ? 'Alle' : `${results.length} treff`}
            {interpreted && (
              <span className="ml-2 inline-flex items-center gap-1 text-stone-400">
                <Sparkles className="size-3 text-brand-500" aria-hidden />
                Tolket som{' '}
                {[interpreted.topics.join(', '), interpreted.filters].filter(Boolean).join(' · ')}
              </span>
            )}
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
