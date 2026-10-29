import type { AdminBoardSeat, BoardOverview } from '@esaf/core'
import type { BoardRole } from '@esaf/db'
import { createFileRoute, Link, notFound, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { AlertTriangle, Landmark, Pencil, Plus, Search } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
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
  addBoardSeat,
  changeBoardSeatRole,
  editBoardSeat,
  endBoardSeat,
  fetchBoardCandidates,
  fetchBoardOverview,
  removeBoardSeat,
} from '#/lib/board.functions.ts'
import { boardRoleNames, boardRoleOrder, singleSeat } from '#/lib/board.ts'
import { kull, plural, yearSpan } from '#/lib/format.ts'

export const Route = createFileRoute('/_konto/admin/styret')({
  beforeLoad: ({ context: { viewer } }) => {
    if (!viewer.permissions.includes('members.manage')) throw notFound()
  },
  loader: () => fetchBoardOverview(),
  head: () => ({ meta: [{ title: 'Styret – Admin – ESAF' }] }),
  component: BoardAdmin,
  errorComponent: ({ error }) => (
    <ErrorText>{error instanceof Error ? error.message : 'Noe gikk galt.'}</ErrorText>
  ),
})

const thisYear = () => new Date().getFullYear()

/** Tomt felt blir null; ellers et heltall. */
const yearValue = (v: string) => (v.trim() ? Number(v) : null)
const digits = (v: string) => v.replace(/\D/g, '').slice(0, 4)

type Open =
  | { kind: 'add' }
  | { kind: 'role'; seat: AdminBoardSeat }
  | { kind: 'end'; seat: AdminBoardSeat }
  | { kind: 'edit'; seat: AdminBoardSeat }
  | null

/**
 * Styret nå og tidligere verv. Admins setter folk inn i styret, bytter roller,
 * avslutter og retter verv her; alt logges.
 */
function BoardAdmin() {
  const board = Route.useLoaderData()
  const [open, setOpen] = useState<Open>(null)
  const hasChair = board.current.some((s) => s.role === 'chair')

  return (
    <>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-stone-500">
          Styret vises for alle medlemmer på{' '}
          <Link to="/styret" className="font-medium text-stone-700 hover:text-brand-600">
            Styret
          </Link>{' '}
          og som merke på profilen. Når noen går ut, avslutt vervet, så står det som tidligere med
          årene. Bytter noen rolle, bruk «Bytt rolle», så historikken står. Alt logges.
        </p>
        <Button variant="brand" size="sm" onClick={() => setOpen({ kind: 'add' })}>
          <Plus className="size-4" aria-hidden /> Legg til i styret
        </Button>
      </div>

      <section aria-labelledby="styret-na" className="mb-8">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="styret-na" className="text-sm font-semibold text-stone-950">
            Styret nå
          </h2>
          <p className="text-sm text-stone-500" aria-live="polite">
            {plural(board.current.length, 'person', 'personer')}
          </p>
        </div>
        {board.current.length > 0 && !hasChair && (
          <p className="mb-3 inline-flex items-center gap-1.5 text-sm text-amber-700">
            <AlertTriangle className="size-3.5" aria-hidden /> Styret har ingen leder registrert.
          </p>
        )}
        {board.current.length === 0 ? (
          <EmptyState icon={Landmark} title="Ingen sitter i styret">
            Legg til styret slik det ble valgt på generalforsamlingen.
          </EmptyState>
        ) : (
          <Card>
            <ul className="divide-y divide-stone-100">
              {board.current.map((s) => (
                <SeatRow key={s.id} seat={s} onOpen={setOpen} />
              ))}
            </ul>
          </Card>
        )}
      </section>

      {board.past.length > 0 && (
        <section aria-labelledby="tidligere-verv">
          <h2 id="tidligere-verv" className="mb-3 text-sm font-semibold text-stone-950">
            Tidligere verv
          </h2>
          <Card>
            <ul className="divide-y divide-stone-100">
              {board.past.map((s) => (
                <SeatRow key={s.id} seat={s} onOpen={setOpen} />
              ))}
            </ul>
          </Card>
        </section>
      )}

      {open?.kind === 'add' && <AddDialog board={board} onClose={() => setOpen(null)} />}
      {open?.kind === 'role' && (
        <RoleDialog board={board} seat={open.seat} onClose={() => setOpen(null)} />
      )}
      {open?.kind === 'end' && <EndDialog seat={open.seat} onClose={() => setOpen(null)} />}
      {open?.kind === 'edit' && (
        <EditDialog board={board} seat={open.seat} onClose={() => setOpen(null)} />
      )}
    </>
  )
}

function SeatRow({ seat: s, onOpen }: { seat: AdminBoardSeat; onOpen: (open: Open) => void }) {
  const inactive = s.status !== 'active'
  const current = s.endYear === null
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <Avatar name={s.fullName} photo={s.photo} size="sm" muted={!s.claimed || inactive} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 text-sm">
          <Link
            to="/medlemmer/$personId"
            params={{ personId: s.personId }}
            className={cx(
              'font-medium hover:text-brand-600',
              current ? 'text-stone-950' : 'text-stone-600',
            )}
          >
            {s.fullName}
          </Link>
          <Verified claimed={s.claimed} />
          <span className="text-stone-700">
            {boardRoleNames[s.role]}
            {s.responsibility && <span className="text-stone-500"> · {s.responsibility}</span>}
          </span>
          <span className="text-xs text-stone-500 tabular-nums">
            {yearSpan(s.startYear, s.endYear)}
          </span>
          {inactive && (
            <span className="rounded-full px-1.5 py-px text-[11px] font-medium text-stone-500 ring-1 ring-stone-300 ring-inset">
              {s.status === 'pending' ? 'Venter' : 'Ikke aktivt medlem'}, vises ikke
            </span>
          )}
        </p>
        {s.note && <p className="truncate text-xs text-stone-500">{s.note}</p>}
      </div>
      <div className="flex gap-1">
        {current && (
          <>
            <Button variant="ghost" size="sm" onClick={() => onOpen({ kind: 'role', seat: s })}>
              Bytt rolle<span className="sr-only"> for {s.fullName}</span>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onOpen({ kind: 'end', seat: s })}>
              Avslutt<span className="sr-only"> vervet til {s.fullName}</span>
            </Button>
          </>
        )}
        <Button variant="ghost" size="sm" onClick={() => onOpen({ kind: 'edit', seat: s })}>
          <Pencil className="size-3.5" aria-hidden /> Rediger
          <span className="sr-only"> vervet til {s.fullName}</span>
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

/**
 * Rollene, med leder og nestleder sperret når noen andre har dem nå. Serveren
 * sjekker det uansett; her er det for å slippe en feilmelding.
 */
function RoleSelect({
  board,
  value,
  onChange,
  except,
  historic,
  autoFocus,
}: {
  board: BoardOverview
  value: BoardRole
  onChange: (role: BoardRole) => void
  /** Vervet som redigeres; det tar ikke plassen fra seg selv. */
  except?: string
  /** Et avsluttet verv; da kan rollen være hva som helst. */
  historic?: boolean
  autoFocus?: boolean
}) {
  const holder = (role: BoardRole) =>
    singleSeat(role) && !historic
      ? board.current.find((s) => s.role === role && s.id !== except)
      : undefined
  return (
    <Select
      value={value}
      onChange={(e) => onChange(e.target.value as BoardRole)}
      data-autofocus={autoFocus || undefined}
    >
      {boardRoleOrder.map((role) => {
        const taken = holder(role)
        return (
          <option key={role} value={role} disabled={!!taken}>
            {boardRoleNames[role]}
            {taken && ` (${taken.fullName})`}
          </option>
        )
      })}
    </Select>
  )
}

type Candidate = Awaited<ReturnType<typeof fetchBoardCandidates>>[number]

function AddDialog({ board, onClose }: { board: BoardOverview; onClose: () => void }) {
  const findCandidates = useServerFn(fetchBoardCandidates)
  const { busy, error, save } = useSave(onClose)
  const [query, setQuery] = useState('')
  // Treffene hører til søket de ble hentet for; til nye treff kommer, vises «Henter …».
  const [found, setFound] = useState<{ query: string; list: Candidate[] } | null>(null)
  const q = query.trim()
  const candidates = found?.query === q ? found.list : null
  const [chosen, setChosen] = useState<Candidate | null>(null)
  const [role, setRole] = useState<BoardRole>('member')
  const [responsibility, setResponsibility] = useState('')
  const [startYear, setStartYear] = useState(String(thisYear()))
  const [note, setNote] = useState('')

  useEffect(() => {
    if (q.length < 2) return
    let cancelled = false
    const timer = setTimeout(() => {
      findCandidates({ data: { query: q } })
        .then((list) => !cancelled && setFound({ query: q, list }))
        .catch(() => !cancelled && setFound({ query: q, list: [] }))
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [q, findCandidates])

  const inactive = chosen !== null && chosen.status !== 'active'

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!chosen) return
    void save(() =>
      addBoardSeat({
        data: {
          personId: chosen.personId,
          role,
          responsibility,
          startYear: yearValue(startYear),
          note,
        },
      }),
    )
  }

  return (
    <Dialog title="Legg til i styret" onClose={onClose} busy={busy}>
      <form onSubmit={submit} className="space-y-4">
        {chosen ? (
          <div className="flex items-center gap-3 rounded-xl bg-stone-50 p-3 ring-1 ring-stone-200 ring-inset">
            <Avatar name={chosen.fullName} photo={chosen.photo} size="sm" muted={!chosen.claimed} />
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-medium text-stone-950">{chosen.fullName}</p>
              <p className="text-xs text-stone-500">{kull(chosen.cohortYears) ?? 'Uten kull'}</p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setChosen(null)}>
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
                placeholder="Søk etter navn"
                aria-label="Søk etter person"
                className="pl-9"
              />
            </div>
            {q.length >= 2 && (
              <ul
                className="mt-2 max-h-64 divide-y divide-stone-100 overflow-y-auto rounded-xl ring-1 ring-stone-200 ring-inset"
                aria-label="Personer"
              >
                {candidates === null ? (
                  <li className="px-3 py-3 text-sm text-stone-500">Henter …</li>
                ) : candidates.length === 0 ? (
                  <li className="px-3 py-3 text-sm text-stone-500">Ingen treff.</li>
                ) : (
                  candidates.map((c) => (
                    <li key={c.personId}>
                      <button
                        type="button"
                        onClick={() => setChosen(c)}
                        disabled={c.onBoard}
                        className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
                      >
                        <Avatar name={c.fullName} photo={c.photo} size="xs" muted={!c.claimed} />
                        <span className="min-w-0 flex-1 truncate font-medium text-stone-900">
                          {c.fullName}
                        </span>
                        <span className="shrink-0 text-xs text-stone-500 tabular-nums">
                          {c.onBoard ? 'Sitter i styret' : (kull(c.cohortYears) ?? 'Uten kull')}
                        </span>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            )}
          </div>
        )}

        {inactive && (
          <p className="flex gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {chosen.fullName} er ikke aktivt medlem, og vises ikke for medlemmer før medlemskapet er
            godkjent.
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Rolle">
            <RoleSelect board={board} value={role} onChange={setRole} />
          </Field>
          <Field label="Ansvarsområde" hint="Valgfritt. Vises for medlemmer.">
            <Input
              value={responsibility}
              onChange={(e) => setResponsibility(e.target.value)}
              maxLength={80}
              placeholder="F.eks. økonomi"
            />
          </Field>
        </div>
        <div className="grid grid-cols-[8rem_1fr] gap-3">
          <Field label="Fra år">
            <Input
              inputMode="numeric"
              value={startYear}
              onChange={(e) => setStartYear(digits(e.target.value))}
            />
          </Field>
          <Field label="Notat" hint="Bare for admins.">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={300}
              placeholder="F.eks. valgt for to år"
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
            disabled={busy || !chosen || (startYear !== '' && startYear.length !== 4)}
          >
            {busy ? 'Lagrer …' : 'Legg til'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

function RoleDialog({
  board,
  seat,
  onClose,
}: {
  board: BoardOverview
  seat: AdminBoardSeat
  onClose: () => void
}) {
  const { busy, error, save } = useSave(onClose)
  const [role, setRole] = useState<BoardRole>(seat.role)
  const [responsibility, setResponsibility] = useState(seat.responsibility ?? '')
  const [year, setYear] = useState(String(thisYear()))
  const unchanged = role === seat.role && responsibility.trim() === (seat.responsibility ?? '')

  return (
    <Dialog
      title={`Bytt rolle for ${seat.fullName}`}
      description={
        <p>
          Vervet som {boardRoleNames[seat.role].toLocaleLowerCase('nb')} avsluttes, og det nye
          starter samme år. Begge står i historikken.
        </p>
      }
      onClose={onClose}
      busy={busy}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void save(() =>
            changeBoardSeatRole({
              data: { id: seat.id, role, responsibility, year: Number(year) },
            }),
          )
        }}
        className="space-y-4"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Ny rolle">
            <RoleSelect board={board} value={role} onChange={setRole} except={seat.id} autoFocus />
          </Field>
          <Field label="Ansvarsområde" hint="Valgfritt.">
            <Input
              value={responsibility}
              onChange={(e) => setResponsibility(e.target.value)}
              maxLength={80}
            />
          </Field>
        </div>
        <Field label="Fra år">
          <Input
            inputMode="numeric"
            value={year}
            onChange={(e) => setYear(digits(e.target.value))}
            className="w-32"
          />
        </Field>
        {error && <ErrorText>{error}</ErrorText>}
        <DialogActions>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Avbryt
          </Button>
          <Button type="submit" variant="brand" disabled={busy || unchanged || year.length !== 4}>
            {busy ? 'Lagrer …' : 'Bytt rolle'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

function EndDialog({ seat, onClose }: { seat: AdminBoardSeat; onClose: () => void }) {
  const { busy, error, save } = useSave(onClose)
  const [endYear, setEndYear] = useState(String(thisYear()))
  return (
    <Dialog
      title="Avslutt vervet"
      description={
        <p>{seat.fullName} går ut av styret. Vervet blir stående som tidligere, med årene.</p>
      }
      onClose={onClose}
      busy={busy}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void save(() => endBoardSeat({ data: { id: seat.id, endYear: Number(endYear) } }))
        }}
      >
        <Field label="Til og med år">
          <Input
            data-autofocus
            inputMode="numeric"
            value={endYear}
            onChange={(e) => setEndYear(digits(e.target.value))}
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
  board,
  seat,
  onClose,
}: {
  board: BoardOverview
  seat: AdminBoardSeat
  onClose: () => void
}) {
  const { busy, error, save } = useSave(onClose)
  const [role, setRole] = useState<BoardRole>(seat.role)
  const [responsibility, setResponsibility] = useState(seat.responsibility ?? '')
  const [startYear, setStartYear] = useState(seat.startYear ? String(seat.startYear) : '')
  const [endYear, setEndYear] = useState(seat.endYear ? String(seat.endYear) : '')
  const [note, setNote] = useState(seat.note ?? '')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const valid = [startYear, endYear].every((v) => v === '' || v.length === 4)

  return (
    <Dialog
      title={`${seat.fullName}, ${boardRoleNames[seat.role].toLocaleLowerCase('nb')}`}
      description={
        <p>
          Rett feil i vervet. Uten sluttår sitter personen i styret nå. Har personen byttet rolle,
          bruk heller «Bytt rolle».
        </p>
      }
      onClose={onClose}
      busy={busy}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void save(() =>
            editBoardSeat({
              data: {
                id: seat.id,
                role,
                responsibility,
                startYear: yearValue(startYear),
                endYear: yearValue(endYear),
                note,
              },
            }),
          )
        }}
        className="space-y-4"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Rolle">
            <RoleSelect
              board={board}
              value={role}
              onChange={setRole}
              except={seat.id}
              historic={endYear !== ''}
              autoFocus
            />
          </Field>
          <Field label="Ansvarsområde">
            <Input
              value={responsibility}
              onChange={(e) => setResponsibility(e.target.value)}
              maxLength={80}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Fra år">
            <Input
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
              onClick={() => void save(() => removeBoardSeat({ data: { id: seat.id } }))}
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
