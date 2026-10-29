import type { AdminPerson, ImportPersonPreview, PersonDecision } from '@esaf/core'
import { Check, Search, UserPlus } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { kull, plural } from '#/lib/format.ts'
import { findAnyPerson } from '#/lib/people.functions.ts'
import { Avatar, Button, cx, Field, Input, Select, Verified } from '../ui.tsx'

/** Valgene admin har gjort, per person i arket. Personer uten valg får standardvalget. */
export type PersonDecisions = Record<string, PersonDecision>

/** Sikre treff brukes; resten står åpne til admin velger. */
export function personDecision(
  p: ImportPersonPreview,
  decisions: PersonDecisions,
): PersonDecision | null {
  return (
    decisions[p.key] ??
    (p.status === 'matched' ? { kind: 'existing', personId: p.candidates[0]!.personId } : null)
  )
}

/** Personer som verken har et sikkert treff eller et valg. De hoppes over hvis ingen velger. */
export const openPeople = (people: ImportPersonPreview[], decisions: PersonDecisions) =>
  people.filter((p) => personDecision(p, decisions) === null)

const statusText: Record<ImportPersonPreview['status'], string> = {
  matched: 'Funnet',
  ambiguous: 'Flere med samme navn',
  suggested: 'Mulig treff',
  unmatched: 'Ikke funnet',
}

const PAGE = 100

/**
 * Personene i arket, med treffene og valgene: velg blant treffene, søk etter en
 * annen, opprett en ny profil eller hopp over. Ingenting lagres her.
 */
export function PeopleResolver({
  people,
  decisions,
  onChange,
  canCreate,
  countLabel,
}: {
  people: ImportPersonPreview[]
  decisions: PersonDecisions
  onChange: (key: string, decision: PersonDecision | undefined) => void
  canCreate: boolean
  /** «3 deltakelser», «2 verv». */
  countLabel: (n: number) => string
}) {
  const [filter, setFilter] = useState<'alle' | 'avklar'>('alle')
  const [shown, setShown] = useState(PAGE)
  // Navn på personer valgt i søket, som ikke står blant treffene.
  const [names, setNames] = useState<Record<string, string>>({})
  const open = openPeople(people, decisions)
  const list = filter === 'avklar' ? open : people
  const firstOf = new Map(people.map((p) => [p.key, p.fullName || p.emails[0] || 'en person']))

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-stone-600" aria-live="polite">
          {plural(people.length, 'person', 'personer')} i arket
          {open.length > 0 && ` · ${open.length} må avklares eller hoppes over`}
        </p>
        <div role="tablist" aria-label="Vis" className="flex gap-1">
          {(
            [
              ['alle', 'Alle'],
              ['avklar', `Må avklares (${open.length})`],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={filter === key}
              onClick={() => {
                setFilter(key)
                setShown(PAGE)
              }}
              className={cx(
                'inline-flex h-8 items-center rounded-lg px-2.5 text-sm font-medium transition',
                filter === key
                  ? 'bg-stone-900 text-white'
                  : 'text-stone-600 hover:bg-stone-100 hover:text-stone-900',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {list.length === 0 ? (
        <p className="rounded-xl px-3 py-6 text-center text-sm text-stone-500 ring-1 ring-stone-200 ring-inset">
          {filter === 'avklar' ? 'Alle er avklart.' : 'Ingen personer i arket.'}
        </p>
      ) : (
        <ol className="divide-y divide-stone-100 rounded-xl ring-1 ring-stone-200 ring-inset">
          {list.slice(0, shown).map((p) => (
            <PersonRow
              key={p.key}
              person={p}
              decision={personDecision(p, decisions)}
              explicit={p.key in decisions}
              sameAs={p.sameAs ? (firstOf.get(p.sameAs) ?? null) : null}
              pickedName={(id) => names[id]}
              onPick={(decision, name) => {
                if (decision?.kind === 'existing' && name)
                  setNames((n) => ({ ...n, [decision.personId]: name }))
                onChange(p.key, decision)
              }}
              canCreate={canCreate}
              countLabel={countLabel}
            />
          ))}
        </ol>
      )}
      {list.length > shown && (
        <Button variant="secondary" size="sm" onClick={() => setShown((n) => n + PAGE)}>
          Vis flere ({list.length - shown} til)
        </Button>
      )}
    </div>
  )
}

function PersonRow({
  person: p,
  decision,
  explicit,
  sameAs,
  pickedName,
  onPick,
  canCreate,
  countLabel,
}: {
  person: ImportPersonPreview
  decision: PersonDecision | null
  explicit: boolean
  sameAs: string | null
  pickedName: (personId: string) => string | undefined
  onPick: (decision: PersonDecision | undefined, name?: string) => void
  canCreate: boolean
  countLabel: (n: number) => string
}) {
  const [mode, setMode] = useState<'search' | 'create' | null>(null)
  const label = p.fullName || p.emails[0] || 'Uten navn'
  const lines =
    p.lines.length > 3
      ? `${p.lines.slice(0, 3).join(', ')} og ${p.lines.length - 3} til`
      : p.lines.join(', ')
  const tone =
    decision?.kind === 'skip' ? 'text-stone-500' : decision ? 'text-emerald-700' : 'text-amber-700'
  const status = sameAs
    ? `Samme person som ${sameAs}`
    : decision?.kind === 'skip'
      ? 'Hoppes over'
      : decision?.kind === 'create'
        ? 'Ny profil'
        : `${statusText[p.status]}${p.status === 'matched' && p.by === 'email' ? ' på e-post' : ''}`
  const chosenId = decision?.kind === 'existing' ? decision.personId : null

  return (
    <li className="px-3 py-2.5 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="min-w-0">
          <span className="font-medium text-stone-900">{label}</span>
          <span className="ml-2 text-xs text-stone-500">
            {[
              p.fullName && p.emails.join(', '),
              p.year && `ES ${p.year}`,
              lines,
              countLabel(p.count),
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
        <span className={cx('shrink-0 text-xs font-medium', tone)}>{status}</span>
      </div>

      <div className="mt-1.5 space-y-1.5">
        {p.candidates.length > 0 && decision?.kind !== 'create' && (
          <ul className="space-y-1">
            {p.candidates.map((c) => {
              const active = chosenId === c.personId
              return (
                <li key={c.personId}>
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() =>
                      onPick(
                        active
                          ? p.status === 'matched'
                            ? { kind: 'skip' }
                            : undefined
                          : { kind: 'existing', personId: c.personId },
                      )
                    }
                    className={cx(
                      'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs ring-1 transition ring-inset',
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
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {chosenId && !p.candidates.some((c) => c.personId === chosenId) && (
          <p className="flex items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1 rounded-full bg-brand-600 px-2.5 py-1 font-medium text-white">
              <Check className="size-3" aria-hidden /> {pickedName(chosenId) ?? 'Valgt person'}
            </span>
            <button
              type="button"
              onClick={() => onPick(undefined)}
              className="text-stone-500 hover:text-stone-900"
            >
              Fjern
            </button>
          </p>
        )}

        {decision?.kind === 'create' && mode !== 'create' && (
          <p className="flex flex-wrap items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1 rounded-full bg-brand-600 px-2.5 py-1 font-medium text-white">
              <UserPlus className="size-3" aria-hidden /> Ny profil: {decision.fullName}
              {decision.graduationYear !== null && `, ES ${decision.graduationYear}`}
              {decision.status === 'pending' && ', venter'}
            </span>
            <button
              type="button"
              onClick={() => setMode('create')}
              className="text-stone-500 hover:text-stone-900"
            >
              Endre
            </button>
            <button
              type="button"
              onClick={() => onPick(undefined)}
              className="text-stone-500 hover:text-stone-900"
            >
              Angre
            </button>
          </p>
        )}

        {mode === 'search' && (
          <PersonSearch
            initial={p.fullName}
            onPick={(found) => {
              onPick({ kind: 'existing', personId: found.personId }, found.fullName)
              setMode(null)
            }}
            onCancel={() => setMode(null)}
          />
        )}
        {mode === 'create' && (
          <CreateForm
            person={p}
            initial={decision?.kind === 'create' ? decision : null}
            onSave={(d) => {
              onPick(d)
              setMode(null)
            }}
            onCancel={() => setMode(null)}
          />
        )}

        {mode === null && (
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <button
              type="button"
              onClick={() => setMode('search')}
              className="text-xs font-medium text-stone-500 hover:text-stone-900"
            >
              Søk etter en annen
            </button>
            {canCreate && decision?.kind !== 'create' && (
              <button
                type="button"
                onClick={() => setMode('create')}
                className="text-xs font-medium text-stone-500 hover:text-stone-900"
              >
                Opprett ny profil
              </button>
            )}
            {decision?.kind === 'skip' ? (
              explicit && (
                <button
                  type="button"
                  onClick={() => onPick(undefined)}
                  className="text-xs font-medium text-stone-500 hover:text-stone-900"
                >
                  Ikke hopp over
                </button>
              )
            ) : (
              <button
                type="button"
                onClick={() => onPick({ kind: 'skip' })}
                className="text-xs font-medium text-stone-500 hover:text-stone-900"
              >
                Hopp over
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  )
}

/** Søk blant alle personer ESAF kjenner. Velg ett treff. */
function PersonSearch({
  initial,
  onPick,
  onCancel,
}: {
  initial: string
  onPick: (p: AdminPerson) => void
  onCancel: () => void
}) {
  const [query, setQuery] = useState(initial.split(' ').at(-1) ?? '')
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
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400"
            aria-hidden
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Søk etter riktig person"
            aria-label="Søk etter riktig person"
            autoFocus
            className="h-9 pl-9"
          />
        </div>
        <Button variant="ghost" size="sm" onClick={onCancel} className="h-9">
          Avbryt
        </Button>
      </div>
      {term.length >= 2 && (
        <ul className="mt-1 max-h-56 divide-y divide-stone-100 overflow-y-auto rounded-xl bg-white ring-1 ring-stone-200 ring-inset">
          {hits.length === 0 && <li className="px-3 py-2 text-sm text-stone-500">Ingen treff.</li>}
          {hits.map((h) => (
            <li key={h.personId}>
              <button
                type="button"
                onClick={() => onPick(h)}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-stone-50"
              >
                <Avatar name={h.fullName} photo={h.photo} size="xs" muted={!h.claimed} />
                <span className="min-w-0 flex-1 truncate font-medium text-stone-900">
                  {h.fullName}
                </span>
                <span className="shrink-0 text-xs text-stone-500 tabular-nums">
                  {kull(h.cohortYears) ?? 'Uten kull'}
                  {h.status !== 'active' && ' · ikke aktiv'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Ny profil fra raden i arket, som «Ny profil» under Admin → Profiler. Lagres først med importen. */
function CreateForm({
  person: p,
  initial,
  onSave,
  onCancel,
}: {
  person: ImportPersonPreview
  initial: Extract<PersonDecision, { kind: 'create' }> | null
  onSave: (d: Extract<PersonDecision, { kind: 'create' }>) => void
  onCancel: () => void
}) {
  const [fullName, setFullName] = useState(initial?.fullName ?? p.fullName)
  const [emails, setEmails] = useState((initial?.emails ?? p.emails).join(', '))
  const [year, setYear] = useState(String(initial?.graduationYear ?? p.year ?? ''))
  const [status, setStatus] = useState<'active' | 'pending'>(initial?.status ?? 'active')
  const [error, setError] = useState<string | null>(null)

  function submit(e: FormEvent) {
    e.preventDefault()
    const list = emails
      .split(/[\s,;]+/)
      .map((x) => x.trim())
      .filter(Boolean)
    if (fullName.trim().length < 2) return setError('Navnet må ha minst 2 tegn.')
    if (list.some((x) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)))
      return setError('Sjekk e-postadressene.')
    if (year && !/^(19|20)\d{2}$/.test(year)) return setError('Kullet er et årstall, f.eks. 2019.')
    onSave({
      kind: 'create',
      fullName: fullName.trim(),
      emails: list,
      graduationYear: year ? Number(year) : null,
      status,
    })
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-xl bg-stone-50 p-3 ring-1 ring-stone-200 ring-inset"
      aria-label={`Ny profil for ${p.fullName || p.emails[0]}`}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Navn">
          <Input
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            maxLength={120}
            autoFocus
            className="h-9"
          />
        </Field>
        <Field label="E-post" hint="Valgfritt. Flere skilles med komma.">
          <Input value={emails} onChange={(e) => setEmails(e.target.value)} className="h-9" />
        </Field>
        <Field label="Kull" hint="Uteksamineringsåret, valgfritt">
          <Input
            value={year}
            onChange={(e) => setYear(e.target.value)}
            inputMode="numeric"
            placeholder="2019"
            className="h-9"
          />
        </Field>
        <Field label="Status">
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value as 'active' | 'pending')}
            className="h-9"
          >
            <option value="active">Aktiv, vises i katalogen</option>
            <option value="pending">Venter</option>
          </Select>
        </Field>
      </div>
      {error && <p className="text-xs text-red-700">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" variant="secondary" size="sm">
          <UserPlus className="size-4" aria-hidden /> Bruk ny profil
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Avbryt
        </Button>
      </div>
    </form>
  )
}
