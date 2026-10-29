import type { AdminRepresentative, RepresentativeOverviewCohort } from '@esaf/core'
import { createFileRoute, Link, notFound, useNavigate, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { AlertTriangle, Megaphone, Pencil, Plus, Search } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { z } from 'zod'
import { Dialog, DialogActions } from '#/components/Dialog.tsx'
import {
  Avatar,
  Button,
  Card,
  cx,
  EmptyState,
  ErrorText,
  Field,
  Input,
  Select,
  Verified,
} from '#/components/ui.tsx'
import {
  addRepresentative,
  editRepresentative,
  endRepresentative,
  fetchRepresentativeCandidates,
  fetchRepresentativeOverview,
  removeRepresentative,
} from '#/lib/cohort-reps.functions.ts'
import { esPeriod, kull, plural, yearSpan } from '#/lib/format.ts'

export const Route = createFileRoute('/_konto/admin/kullrepresentanter')({
  beforeLoad: ({ context: { viewer } }) => {
    if (!viewer.permissions.includes('members.manage')) throw notFound()
  },
  validateSearch: z.object({
    vis: z.enum(['mangler']).optional().catch(undefined),
  }),
  loader: () => fetchRepresentativeOverview(),
  head: () => ({ meta: [{ title: 'Kullrepresentanter – Admin – ESAF' }] }),
  component: Representatives,
  errorComponent: ({ error }) => (
    <ErrorText>{error instanceof Error ? error.message : 'Noe gikk galt.'}</ErrorText>
  ),
})

const thisYear = () => new Date().getFullYear()

/** Tomt felt blir null; ellers et heltall. */
const yearValue = (v: string) => (v.trim() ? Number(v) : null)

type Open =
  | { kind: 'add'; year: number }
  | { kind: 'edit'; year: number; rep: AdminRepresentative }
  | { kind: 'end'; year: number; rep: AdminRepresentative }
  | null

/**
 * Alle kull med kullrepresentantene sine, og hvilke som mangler. Admins setter,
 * avslutter og retter verv her; alt logges.
 */
function Representatives() {
  const cohorts = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const [open, setOpen] = useState<Open>(null)

  const missing = cohorts.filter((c) => c.current.length === 0)
  const shown = search.vis === 'mangler' ? missing : cohorts

  return (
    <>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-stone-500">
          Kullrepresentantene er dem styret snakker med, og som sender videre til kullet sitt. Et
          kull kan ha flere. Vervene vises på kullsiden og profilen, og tidligere verv blir stående
          med årene. Alt logges.
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-stone-500" aria-live="polite">
          {cohorts.length - missing.length} av {plural(cohorts.length, 'kull', 'kull')} har
          kullrepresentant
          {missing.length > 0 && ` · ${missing.length} mangler`}
        </p>
        <div className="w-48">
          <Select
            value={search.vis ?? ''}
            onChange={(e) =>
              void navigate({
                search: { vis: (e.target.value || undefined) as typeof search.vis },
                replace: true,
              })
            }
            aria-label="Vis"
          >
            <option value="">Alle kull</option>
            <option value="mangler">Mangler representant</option>
          </Select>
        </div>
      </div>

      {shown.length === 0 ? (
        <EmptyState icon={Megaphone} title="Alle kull har kullrepresentant">
          Bra jobbet.
        </EmptyState>
      ) : (
        <Card>
          <ul className="divide-y divide-stone-100">
            {shown.map((c) => (
              <CohortRow key={c.graduationYear} cohort={c} onOpen={setOpen} />
            ))}
          </ul>
        </Card>
      )}

      {open?.kind === 'add' && <AddDialog year={open.year} onClose={() => setOpen(null)} />}
      {open?.kind === 'edit' && (
        <EditDialog year={open.year} rep={open.rep} onClose={() => setOpen(null)} />
      )}
      {open?.kind === 'end' && (
        <EndDialog year={open.year} rep={open.rep} onClose={() => setOpen(null)} />
      )}
    </>
  )
}

function CohortRow({
  cohort: c,
  onOpen,
}: {
  cohort: RepresentativeOverviewCohort
  onOpen: (open: Open) => void
}) {
  const year = c.graduationYear
  return (
    <li id={`es-${year}`} className="scroll-mt-20 px-4 py-4 target:bg-brand-50/50">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-baseline gap-2">
            <Link
              to="/kull/$year"
              params={{ year }}
              className="font-semibold text-stone-950 tabular-nums hover:text-brand-600"
            >
              ES {year}
            </Link>
            <span className="text-xs text-stone-500 tabular-nums">
              {esPeriod(year)} · {plural(c.members, 'aktivt medlem', 'aktive medlemmer')}
            </span>
          </p>
          {c.current.length === 0 && (
            <p className="mt-1 inline-flex items-center gap-1.5 text-sm text-amber-700">
              <AlertTriangle className="size-3.5" aria-hidden /> Mangler kullrepresentant
            </p>
          )}
        </div>
        <Button variant="secondary" size="sm" onClick={() => onOpen({ kind: 'add', year })}>
          <Plus className="size-4" aria-hidden /> Legg til
          <span className="sr-only"> kullrepresentant for ES {year}</span>
        </Button>
      </div>

      {c.current.length > 0 && (
        <ul className="mt-3 space-y-2" aria-label={`Kullrepresentanter for ES ${year}`}>
          {c.current.map((r) => (
            <RepRow key={r.id} rep={r} year={year} onOpen={onOpen} />
          ))}
        </ul>
      )}
      {c.past.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-stone-500 hover:text-stone-800">
            {plural(c.past.length, 'tidligere verv', 'tidligere verv')}
          </summary>
          <ul className="mt-2 space-y-2">
            {c.past.map((r) => (
              <RepRow key={r.id} rep={r} year={year} onOpen={onOpen} />
            ))}
          </ul>
        </details>
      )}
    </li>
  )
}

function RepRow({
  rep: r,
  year,
  onOpen,
}: {
  rep: AdminRepresentative
  year: number
  onOpen: (open: Open) => void
}) {
  const inactive = r.status !== 'active'
  return (
    <li className="flex flex-wrap items-center gap-3">
      <Avatar name={r.fullName} photo={r.photo} size="sm" muted={!r.claimed || inactive} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 text-sm">
          <Link
            to="/medlemmer/$personId"
            params={{ personId: r.personId }}
            className={cx(
              'font-medium hover:text-brand-600',
              r.endYear === null ? 'text-stone-950' : 'text-stone-600',
            )}
          >
            {r.fullName}
          </Link>
          <Verified claimed={r.claimed} />
          <span className="text-xs text-stone-500 tabular-nums">
            {yearSpan(r.startYear, r.endYear)}
          </span>
          {r.otherCohort && (
            <span className="rounded-full bg-amber-50 px-1.5 py-px text-[11px] font-medium text-amber-800 ring-1 ring-amber-200 ring-inset">
              Annet kull
            </span>
          )}
          {inactive && (
            <span className="rounded-full px-1.5 py-px text-[11px] font-medium text-stone-500 ring-1 ring-stone-300 ring-inset">
              {r.status === 'pending' ? 'Venter' : 'Ikke aktivt medlem'}, vises ikke
            </span>
          )}
        </p>
        {r.note && <p className="truncate text-xs text-stone-500">{r.note}</p>}
      </div>
      <div className="flex gap-1">
        {r.endYear === null && (
          <Button variant="ghost" size="sm" onClick={() => onOpen({ kind: 'end', year, rep: r })}>
            Avslutt<span className="sr-only"> vervet til {r.fullName}</span>
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => onOpen({ kind: 'edit', year, rep: r })}>
          <Pencil className="size-3.5" aria-hidden /> Rediger
          <span className="sr-only"> vervet til {r.fullName}</span>
        </Button>
      </div>
    </li>
  )
}

/** Felles for dialogene: lagre, oppdatere siden og lukke, eller vise feilen. */
function useSave(onClose: () => void) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function save(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await router.invalidate()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke lagre.')
      setBusy(false)
    }
  }
  return { busy, error, save }
}

type Candidate = Awaited<ReturnType<typeof fetchRepresentativeCandidates>>[number]

function AddDialog({ year, onClose }: { year: number; onClose: () => void }) {
  const findCandidates = useServerFn(fetchRepresentativeCandidates)
  const { busy, error, save } = useSave(onClose)
  const [query, setQuery] = useState('')
  const [candidates, setCandidates] = useState<Candidate[] | null>(null)
  const [chosen, setChosen] = useState<Candidate | null>(null)
  const [startYear, setStartYear] = useState(String(thisYear()))
  const [note, setNote] = useState('')
  const [confirmOther, setConfirmOther] = useState(false)

  // Uten søk: alle i kullet. Med søk: alle personer med navnet.
  useEffect(() => {
    let cancelled = false
    const q = query.trim()
    const timer = setTimeout(
      () => {
        findCandidates({ data: { graduationYear: year, query: q || undefined } })
          .then((list) => !cancelled && setCandidates(list))
          .catch(() => !cancelled && setCandidates([]))
      },
      q ? 200 : 0,
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, year, findCandidates])

  const other = chosen !== null && !chosen.inCohort

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!chosen) return
    void save(() =>
      addRepresentative({
        data: {
          graduationYear: year,
          personId: chosen.personId,
          startYear: yearValue(startYear),
          note,
          otherCohort: confirmOther,
        },
      }),
    )
  }

  return (
    <Dialog title={`Ny kullrepresentant for ES ${year}`} onClose={onClose} busy={busy}>
      <form onSubmit={submit} className="space-y-4">
        {chosen ? (
          <div className="flex items-center gap-3 rounded-xl bg-stone-50 p-3 ring-1 ring-stone-200 ring-inset">
            <Avatar name={chosen.fullName} photo={chosen.photo} size="sm" muted={!chosen.claimed} />
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-medium text-stone-950">{chosen.fullName}</p>
              <p className="text-xs text-stone-500">{kull(chosen.cohortYears) ?? 'Uten kull'}</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setChosen(null)
                setConfirmOther(false)
              }}
            >
              Bytt
            </Button>
          </div>
        ) : (
          <div>
            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400"
                aria-hidden
              />
              <Input
                data-autofocus
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Søk, eller velg fra ES ${year}`}
                aria-label="Søk etter person"
                className="pl-9"
              />
            </div>
            <ul
              className="mt-2 max-h-64 divide-y divide-stone-100 overflow-y-auto rounded-xl ring-1 ring-stone-200 ring-inset"
              aria-label="Personer"
            >
              {candidates === null ? (
                <li className="px-3 py-3 text-sm text-stone-500">Henter …</li>
              ) : candidates.length === 0 ? (
                <li className="px-3 py-3 text-sm text-stone-500">
                  {query.trim() ? 'Ingen treff.' : `Ingen i ES ${year}. Søk etter navn.`}
                </li>
              ) : (
                candidates.map((c) => (
                  <li key={c.personId}>
                    <button
                      type="button"
                      onClick={() => setChosen(c)}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-stone-50"
                    >
                      <Avatar name={c.fullName} photo={c.photo} size="xs" muted={!c.claimed} />
                      <span className="min-w-0 flex-1 truncate font-medium text-stone-900">
                        {c.fullName}
                      </span>
                      <span
                        className={cx(
                          'shrink-0 text-xs tabular-nums',
                          c.inCohort ? 'text-stone-500' : 'text-amber-700',
                        )}
                      >
                        {kull(c.cohortYears) ?? 'Uten kull'}
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        )}

        {other && (
          <div className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset">
            <p className="flex gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              {chosen.fullName} går ikke i ES {year}. Kullrepresentanten er vanligvis fra kullet
              selv.
            </p>
            <label className="mt-2 flex items-center gap-2 pl-6">
              <input
                type="checkbox"
                checked={confirmOther}
                onChange={(e) => setConfirmOther(e.target.checked)}
                className="size-4 rounded border-stone-300 accent-amber-600"
              />
              Det er riktig likevel
            </label>
          </div>
        )}

        <div className="grid grid-cols-[8rem_1fr] gap-3">
          <Field label="Fra år">
            <Input
              inputMode="numeric"
              value={startYear}
              onChange={(e) => setStartYear(e.target.value.replace(/\D/g, '').slice(0, 4))}
            />
          </Field>
          <Field label="Notat" hint="Bare for admins.">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={300}
              placeholder="F.eks. valgt på kullsamlingen"
            />
          </Field>
        </div>

        {error && <ErrorText>{error}</ErrorText>}
        <DialogActions>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Avbryt
          </Button>
          <Button
            type="submit"
            variant="brand"
            disabled={busy || !chosen || (other && !confirmOther)}
          >
            {busy ? 'Lagrer …' : 'Legg til'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

function EndDialog({
  year,
  rep,
  onClose,
}: {
  year: number
  rep: AdminRepresentative
  onClose: () => void
}) {
  const { busy, error, save } = useSave(onClose)
  const [endYear, setEndYear] = useState(String(thisYear()))
  return (
    <Dialog
      title="Avslutt vervet"
      description={
        <p>
          {rep.fullName} er ikke lenger kullrepresentant for ES {year}. Vervet blir stående som
          tidligere, med årene.
        </p>
      }
      onClose={onClose}
      busy={busy}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void save(() => endRepresentative({ data: { id: rep.id, endYear: Number(endYear) } }))
        }}
      >
        <Field label="Til og med år">
          <Input
            data-autofocus
            inputMode="numeric"
            value={endYear}
            onChange={(e) => setEndYear(e.target.value.replace(/\D/g, '').slice(0, 4))}
            className="w-32"
          />
        </Field>
        {error && (
          <div className="mt-4">
            <ErrorText>{error}</ErrorText>
          </div>
        )}
        <DialogActions>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Avbryt
          </Button>
          <Button type="submit" variant="brand" disabled={busy || endYear.length !== 4}>
            {busy ? 'Lagrer …' : 'Avslutt vervet'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

function EditDialog({
  year,
  rep,
  onClose,
}: {
  year: number
  rep: AdminRepresentative
  onClose: () => void
}) {
  const { busy, error, save } = useSave(onClose)
  const [startYear, setStartYear] = useState(rep.startYear ? String(rep.startYear) : '')
  const [endYear, setEndYear] = useState(rep.endYear ? String(rep.endYear) : '')
  const [note, setNote] = useState(rep.note ?? '')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 4)
  const valid = useMemo(
    () => [startYear, endYear].every((v) => v === '' || v.length === 4),
    [startYear, endYear],
  )

  return (
    <Dialog
      title={`${rep.fullName}, ES ${year}`}
      description={<p>Rett årene eller notatet. Uten sluttår er vervet nåværende.</p>}
      onClose={onClose}
      busy={busy}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void save(() =>
            editRepresentative({
              data: {
                id: rep.id,
                startYear: yearValue(startYear),
                endYear: yearValue(endYear),
                note,
              },
            }),
          )
        }}
        className="space-y-4"
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Fra år">
            <Input
              data-autofocus
              inputMode="numeric"
              value={startYear}
              onChange={(e) => setStartYear(digits(e.target.value))}
              placeholder="Ukjent"
            />
          </Field>
          <Field label="Til og med år">
            <Input
              inputMode="numeric"
              value={endYear}
              onChange={(e) => setEndYear(digits(e.target.value))}
              placeholder="Nå"
            />
          </Field>
        </div>
        <Field label="Notat" hint="Bare for admins.">
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
        </Field>

        {error && <ErrorText>{error}</ErrorText>}
        <DialogActions>
          {confirmDelete ? (
            <Button
              variant="destructive"
              onClick={() => void save(() => removeRepresentative({ data: { id: rep.id } }))}
              disabled={busy}
              className="sm:mr-auto"
            >
              Ja, slett vervet
            </Button>
          ) : (
            <Button
              variant="danger"
              onClick={() => setConfirmDelete(true)}
              disabled={busy}
              className="sm:mr-auto"
            >
              Slett
            </Button>
          )}
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Avbryt
          </Button>
          <Button type="submit" variant="brand" disabled={busy || !valid}>
            {busy ? 'Lagrer …' : 'Lagre'}
          </Button>
        </DialogActions>
        {confirmDelete && (
          <p className="text-xs text-stone-500">
            Slett bare verv som ble lagt inn ved en feil. Et verv som er over, bør avsluttes, så
            historikken står.
          </p>
        )}
      </form>
    </Dialog>
  )
}
