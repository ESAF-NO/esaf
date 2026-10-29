import type { AdminPerson, MatchLine } from '@esaf/core'
import { useRouter } from '@tanstack/react-router'
import { Check, ClipboardList, Search, UserPlus, Users } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { kull, plural } from '#/lib/format.ts'
import { findAnyPerson } from '#/lib/people.functions.ts'
import { addAttendees, addCohortAttendees, matchAttendees } from '#/lib/weekends.functions.ts'
import { Avatar, Button, Card, cx, ErrorText, Input, Select, Textarea, Verified } from './ui.tsx'

/**
 * Adminverktøyene for oppmøte på en helg: legge til én person, et helt kull,
 * eller en innlimt liste med navn og e-post. Lista matches på serveren og vises
 * linje for linje før noe lagres, så uklare treff kan velges for hånd.
 */
export function WeekendAttendanceAdmin({
  weekendId,
  cohortYears,
}: {
  weekendId: string
  cohortYears: number[]
}) {
  const [mode, setMode] = useState<'person' | 'kull' | 'liste'>('liste')
  const [message, setMessage] = useState<string | null>(null)
  const tabs = [
    { key: 'liste', label: 'Lim inn liste', icon: ClipboardList },
    { key: 'person', label: 'Én person', icon: UserPlus },
    { key: 'kull', label: 'Hele kullet', icon: Users },
  ] as const

  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-stone-950">Legg til deltakere</h2>
      <p className="mt-0.5 text-xs text-stone-500">Bare for admins. Alt logges.</p>
      <div role="tablist" aria-label="Legg til" className="mt-3 flex flex-wrap gap-1">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={mode === t.key}
            onClick={() => {
              setMode(t.key)
              setMessage(null)
            }}
            className={cx(
              'inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium transition',
              mode === t.key
                ? 'bg-stone-900 text-white'
                : 'text-stone-600 hover:bg-stone-100 hover:text-stone-900',
            )}
          >
            <t.icon className="size-4" aria-hidden /> {t.label}
          </button>
        ))}
      </div>
      <div className="mt-4" role="tabpanel">
        {mode === 'liste' && <ImportList weekendId={weekendId} onDone={setMessage} />}
        {mode === 'person' && <AddPerson weekendId={weekendId} onDone={setMessage} />}
        {mode === 'kull' && (
          <AddCohort weekendId={weekendId} years={cohortYears} onDone={setMessage} />
        )}
      </div>
      <p role="status" className="mt-3 text-sm text-emerald-700 empty:hidden">
        {message}
      </p>
    </Card>
  )
}

const added = (n: number) =>
  n ? `La til ${plural(n, 'deltaker', 'deltakere')}.` : 'Alle var allerede registrert.'

/** Søk blant alle personer ESAF kjenner. Velg ett treff. */
function PersonSearch({
  onPick,
  placeholder = 'Søk på navn',
  autoFocus,
}: {
  onPick: (p: AdminPerson) => void
  placeholder?: string
  autoFocus?: boolean
}) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<AdminPerson[]>([])
  const term = query.trim()

  useEffect(() => {
    if (term.length < 2) return
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const found = await findAnyPerson({ data: { q: term } })
        if (!cancelled) setHits(found)
      } catch {
        if (!cancelled) setHits([])
      }
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [term])

  return (
    <div>
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400"
          aria-hidden
        />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          autoFocus={autoFocus}
          className="h-9 pl-9"
        />
      </div>
      {term.length >= 2 && (
        <ul className="mt-1 max-h-56 divide-y divide-stone-100 overflow-y-auto rounded-xl bg-white ring-1 ring-stone-200 ring-inset">
          {hits.length === 0 && <li className="px-3 py-2 text-sm text-stone-500">Ingen treff.</li>}
          {hits.map((p) => (
            <li key={p.personId}>
              <button
                type="button"
                onClick={() => {
                  onPick(p)
                  setQuery('')
                  setHits([])
                }}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-stone-50"
              >
                <Avatar name={p.fullName} photo={p.photo} size="xs" muted={!p.claimed} />
                <span className="min-w-0 flex-1 truncate font-medium text-stone-900">
                  {p.fullName}
                </span>
                <span className="shrink-0 text-xs text-stone-500 tabular-nums">
                  {kull(p.cohortYears) ?? 'Uten kull'}
                  {p.status !== 'active' && ' · ikke aktiv'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function useAdd(onDone: (message: string) => void) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function run(fn: () => Promise<{ added: number }>) {
    setBusy(true)
    setError(null)
    try {
      const result = await fn()
      await router.invalidate()
      onDone(added(result.added))
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke lagre.')
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

function AddPerson({ weekendId, onDone }: { weekendId: string; onDone: (m: string) => void }) {
  const { busy, error, run } = useAdd(onDone)
  return (
    <div className="space-y-3">
      <PersonSearch
        autoFocus
        onPick={(p) =>
          !busy &&
          void run(() =>
            addAttendees({ data: { weekendId, personIds: [p.personId], source: 'admin' } }),
          )
        }
      />
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  )
}

function AddCohort({
  weekendId,
  years,
  onDone,
}: {
  weekendId: string
  years: number[]
  onDone: (m: string) => void
}) {
  const { busy, error, run } = useAdd(onDone)
  const [year, setYear] = useState(years[0] ? String(years[0]) : '')
  function submit(e: FormEvent) {
    e.preventDefault()
    if (!year) return
    if (!confirm(`Legge til alle aktive medlemmer fra ES ${year} som deltakere?`)) return
    void run(() => addCohortAttendees({ data: { weekendId, graduationYear: Number(year) } }))
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-sm text-stone-600">
        Legger til alle aktive medlemmer som gikk i kullet som studenter. Fjern dem som ikke var der
        etterpå.
      </p>
      <div className="flex gap-2">
        <Select
          value={year}
          onChange={(e) => setYear(e.target.value)}
          aria-label="Kull"
          className="w-36"
        >
          {years.map((y) => (
            <option key={y} value={y}>
              ES {y}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="secondary" disabled={busy || !year}>
          {busy ? 'Legger til …' : 'Legg til kullet'}
        </Button>
      </div>
      {error && <ErrorText>{error}</ErrorText>}
    </form>
  )
}

type Pick = { personId: string; fullName: string } | null

/** Ett sikkert treff som allerede står på helgen. Trenger ikke avklares. */
const registered = (l: MatchLine) => l.status === 'matched' && l.candidates[0]?.attending === true

const statusText: Record<MatchLine['status'], string> = {
  matched: 'Funnet',
  ambiguous: 'Flere med samme navn',
  suggested: 'Mulig treff',
  unmatched: 'Ikke funnet',
  duplicate: 'Står over',
}

function ImportList({ weekendId, onDone }: { weekendId: string; onDone: (m: string) => void }) {
  const { busy, error, run } = useAdd(onDone)
  const [text, setText] = useState('')
  const [lines, setLines] = useState<MatchLine[] | null>(null)
  const [picks, setPicks] = useState<Pick[]>([])
  const [matching, setMatching] = useState(false)
  const [matchError, setMatchError] = useState<string | null>(null)

  async function preview(e: FormEvent) {
    e.preventDefault()
    setMatching(true)
    setMatchError(null)
    try {
      const result = await matchAttendees({ data: { weekendId, text } })
      setLines(result)
      // Sikre treff er valgt; resten må avklares. De som allerede er registrert, hoppes over.
      setPicks(
        result.map((l) => {
          const c = l.candidates[0]
          return l.status === 'matched' && c && !c.attending
            ? { personId: c.personId, fullName: c.fullName }
            : null
        }),
      )
    } catch (err) {
      setMatchError(err instanceof Error ? err.message : 'Kunne ikke lese lista.')
    } finally {
      setMatching(false)
    }
  }

  const chosen = [...new Set(picks.filter((p) => p !== null).map((p) => p.personId))]
  const open =
    lines?.filter((l, i) => !picks[i] && l.status !== 'duplicate' && !registered(l)).length ?? 0
  const setPick = (i: number, pick: Pick) =>
    setPicks((list) => list.map((p, j) => (j === i ? pick : p)))

  if (!lines) {
    return (
      <form onSubmit={preview} className="space-y-3">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'Kari Nordmann\nola@example.com\nNordmann, Per 2019'}
          aria-label="Liste med navn eller e-post"
          className="min-h-40 font-mono text-[13px]"
        />
        <p className="text-xs text-stone-500">
          Én person per linje: navn, e-post eller begge. Et årstall skiller mellom folk med samme
          navn. Ingenting lagres før du har sett over treffene.
        </p>
        {matchError && <ErrorText>{matchError}</ErrorText>}
        <Button type="submit" variant="secondary" disabled={matching || !text.trim()}>
          {matching ? 'Leser …' : 'Finn personene'}
        </Button>
      </form>
    )
  }

  const done = lines.filter(registered).length
  return (
    <div className="space-y-3">
      <p className="text-sm text-stone-600">
        {plural(lines.length, 'linje', 'linjer')} · {chosen.length} valgt
        {done > 0 && ` · ${done} allerede registrert`}
        {open > 0 && ` · ${open} må avklares eller hoppes over`}
      </p>
      <ol className="max-h-[28rem] divide-y divide-stone-100 overflow-y-auto rounded-xl ring-1 ring-stone-200 ring-inset">
        {lines.map((l, i) => (
          <MatchRow key={i} line={l} pick={picks[i] ?? null} onPick={(p) => setPick(i, p)} />
        ))}
      </ol>
      {error && <ErrorText>{error}</ErrorText>}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="brand"
          disabled={busy || chosen.length === 0}
          onClick={async () => {
            const ok = await run(() =>
              addAttendees({ data: { weekendId, personIds: chosen, source: 'import' } }),
            )
            if (ok) {
              setLines(null)
              setText('')
            }
          }}
        >
          {busy ? 'Legger til …' : `Legg til ${plural(chosen.length, 'person', 'personer')}`}
        </Button>
        <Button variant="secondary" onClick={() => setLines(null)} disabled={busy}>
          Endre lista
        </Button>
      </div>
    </div>
  )
}

function MatchRow({
  line: l,
  pick,
  onPick,
}: {
  line: MatchLine
  pick: Pick
  onPick: (p: Pick) => void
}) {
  const [searching, setSearching] = useState(false)
  const already = registered(l)
  const tone =
    l.status === 'duplicate' || already
      ? 'text-stone-500'
      : l.status === 'matched'
        ? 'text-emerald-700'
        : 'text-amber-700'
  return (
    <li className="px-3 py-2.5 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="min-w-0 truncate font-mono text-[13px] text-stone-700">{l.line}</span>
        <span className={cx('shrink-0 text-xs font-medium', tone)}>
          {already ? 'Allerede registrert' : statusText[l.status]}
          {l.by === 'email' && l.status === 'matched' && !already && ' på e-post'}
        </span>
      </div>
      {l.status === 'duplicate' ? (
        <p className="mt-0.5 text-xs text-stone-500">Samme person som en linje over.</p>
      ) : (
        <div className="mt-1.5 space-y-1.5">
          {l.candidates.length > 0 && (
            <ul className="space-y-1">
              {l.candidates.map((c) => {
                const active = pick?.personId === c.personId
                return (
                  <li key={c.personId}>
                    <button
                      type="button"
                      aria-pressed={active}
                      disabled={c.attending}
                      onClick={() => onPick(active ? null : c)}
                      className={cx(
                        'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs ring-1 transition ring-inset disabled:opacity-60',
                        active
                          ? 'bg-brand-50 text-brand-900 ring-brand-300'
                          : 'bg-white text-stone-700 ring-stone-200 hover:ring-stone-400',
                      )}
                    >
                      <span
                        aria-hidden
                        className={cx(
                          'grid size-4 shrink-0 place-items-center rounded-full ring-1 ring-inset',
                          active ? 'bg-brand-600 text-white ring-brand-600' : 'ring-stone-300',
                        )}
                      >
                        {active && <Check className="size-3" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1 font-medium">
                          <span className="truncate">{c.fullName}</span>
                          <Verified claimed={c.claimed} className="size-3.5" />
                        </span>
                        <span className="block text-stone-500">
                          {kull(c.cohortYears) ?? 'Uten kull'}
                          {c.status !== 'active' && ', ikke aktivt medlem'}
                          {c.attending && ', allerede registrert'}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          {pick && !l.candidates.some((c) => c.personId === pick.personId) && (
            <p className="flex items-center gap-2 text-xs">
              <span className="inline-flex items-center gap-1 rounded-full bg-brand-600 px-2.5 py-1 font-medium text-white">
                <Check className="size-3" aria-hidden /> {pick.fullName}
              </span>
              <button
                type="button"
                onClick={() => onPick(null)}
                className="text-stone-500 hover:text-stone-900"
              >
                Fjern
              </button>
            </p>
          )}
          {l.status !== 'matched' &&
            (searching ? (
              <PersonSearch
                autoFocus
                placeholder="Søk etter riktig person"
                onPick={(p) => {
                  onPick({ personId: p.personId, fullName: p.fullName })
                  setSearching(false)
                }}
              />
            ) : (
              <button
                type="button"
                onClick={() => setSearching(true)}
                className="text-xs font-medium text-stone-500 hover:text-stone-900"
              >
                Søk etter en annen
              </button>
            ))}
        </div>
      )}
    </li>
  )
}
