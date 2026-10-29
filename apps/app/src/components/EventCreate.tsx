import type { EventTypeInfo, HistoryPreview, HistoryRow } from '@esaf/core'
import { Link, useNavigate, useRouter } from '@tanstack/react-router'
import { History, Plus } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { createHistory, newEvent, previewHistory } from '#/lib/events.functions.ts'
import type { HistoryFormValues } from '#/lib/events.functions.ts'
import { eventWhen } from '#/lib/events.ts'
import { plural } from '#/lib/format.ts'
import { Dialog, DialogActions } from './Dialog.tsx'
import { emptyEvent, EventDialog, yearOptions } from './EventForm.tsx'
import {
  Button,
  buttonClass,
  cx,
  ErrorText,
  Field,
  Input,
  Select,
  type ButtonStyle,
} from './ui.tsx'

type TypeOption = Pick<EventTypeInfo, 'id' | 'name' | 'slug'>

/**
 * «Nytt arrangement» og «Legg inn historikk» for admins: på /arrangementer, på
 * siden for hver type (med typen valgt) og under Admin → Arrangementer. Et nytt
 * arrangement åpnes med en gang, så deltakerne kan legges til.
 */
export function EventCreateActions({
  types,
  typeId,
  size = 'md',
}: {
  types: TypeOption[]
  /** Typen som er valgt fra start. Ellers den første (ESAF-helgen). */
  typeId?: string
  size?: ButtonStyle['size']
}) {
  const navigate = useNavigate()
  const [open, setOpen] = useState<'event' | 'history' | null>(null)
  const initialType = typeId ?? types[0]?.id
  if (!initialType) return null
  const type = types.find((t) => t.id === initialType)

  return (
    <>
      <Button variant="secondary" size={size} onClick={() => setOpen('history')}>
        <History className="size-4" aria-hidden /> Legg inn historikk
      </Button>
      <Button variant="brand" size={size} onClick={() => setOpen('event')}>
        <Plus className="size-4" aria-hidden /> Nytt arrangement
      </Button>
      {open === 'event' && (
        <EventDialog
          title={typeId && type ? `Nytt arrangement: ${type.name}` : 'Nytt arrangement'}
          initial={emptyEvent(initialType)}
          types={types}
          submitLabel="Opprett"
          onClose={() => setOpen(null)}
          onSubmit={async (values) => {
            const { id, typeSlug } = await newEvent({ data: values })
            await navigate({
              to: '/arrangementer/$typeSlug/$eventId',
              params: { typeSlug, eventId: id },
              search: { opprettet: true },
            })
          }}
        />
      )}
      {open === 'history' && (
        <EventHistoryDialog
          types={types}
          typeId={initialType}
          fixedType={Boolean(typeId)}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  )
}

const frequencies = [
  { value: 'autumn', label: 'Hver høst', example: 'høst 2018' },
  { value: 'spring', label: 'Hver vår', example: 'vår 2018' },
  { value: 'both', label: 'Vår og høst', example: 'vår 2018 og høst 2018' },
  { value: 'year', label: 'Én gang i året, uten semester', example: '2018' },
] as const

const statusText: Record<HistoryRow['status'], string> = {
  new: 'Lages',
  exists: 'Finnes allerede',
  overlap: 'Et annet i samme periode',
  future: 'Har ikke vært ennå',
}

const rowKey = (r: Pick<HistoryRow, 'year' | 'period'>) => `${r.year}-${r.period}`

/**
 * «Legg inn historikk»: mange gamle arrangementer av én type på én gang. Admin
 * velger årene og hvor ofte, ser hva som lages og hva som finnes, og oppretter.
 * Navn som finnes fra før hoppes over, så samme valg to ganger gir ingen
 * duplikater. Finnes et annet arrangement i samme periode, er raden ikke valgt.
 */
export function EventHistoryDialog({
  types,
  typeId,
  fixedType,
  onClose,
}: {
  types: TypeOption[]
  typeId: string
  /** Åpnet fra siden for typen: typen kan ikke byttes. */
  fixedType?: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const thisYear = new Date().getFullYear()
  const [form, setForm] = useState<HistoryFormValues>({
    typeId,
    fromYear: thisYear - 10,
    toYear: thisYear - 1,
    frequency: 'autumn',
  })
  const [location, setLocation] = useState('')
  const [preview, setPreview] = useState<HistoryPreview | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ created: number; skipped: number; slug: string } | null>(null)
  const type = types.find((t) => t.id === form.typeId)
  const years = yearOptions()

  // Et endret valg gjør forhåndsvisningen utdatert.
  const change = (patch: Partial<HistoryFormValues>) => {
    setForm((f) => ({ ...f, ...patch }))
    setPreview(null)
    setError(null)
  }

  async function showPreview(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await previewHistory({ data: form })
      setPreview(result)
      setChosen(new Set(result.rows.filter((r) => r.status === 'new').map(rowKey)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke lage forhåndsvisningen.')
    } finally {
      setBusy(false)
    }
  }

  async function create() {
    if (!preview) return
    setBusy(true)
    setError(null)
    try {
      const items = preview.rows
        .filter((r) => chosen.has(rowKey(r)))
        .map((r) => ({ year: r.year, period: r.period }))
      const result = await createHistory({
        data: { typeId: preview.type.id, items, location },
      })
      await router.invalidate()
      setDone({
        created: result.created.length,
        skipped: result.skipped.length,
        slug: result.typeSlug,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke lagre.')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <Dialog title="Historikken er lagt inn" onClose={onClose}>
        <p className="text-sm text-stone-700" role="status">
          {done.created > 0
            ? `La inn ${plural(done.created, 'arrangement', 'arrangementer')}.`
            : 'Ingen nye arrangementer.'}
          {done.skipped > 0 &&
            ` ${plural(done.skipped, 'fantes', 'fantes')} allerede og ble hoppet over.`}{' '}
          Åpne et arrangement for å legge til hvem som var der.
        </p>
        <DialogActions>
          <Link
            to="/arrangementer/$typeSlug"
            params={{ typeSlug: done.slug }}
            onClick={onClose}
            className={buttonClass({ variant: 'brand' })}
            data-autofocus
          >
            Se {type?.name ?? 'arrangementene'}
          </Link>
        </DialogActions>
      </Dialog>
    )
  }

  const count = chosen.size
  return (
    <Dialog
      title="Legg inn historikk"
      description={
        <p>
          Legg inn mange tidligere arrangementer på én gang når du bare vet året eller semesteret.
          Datoene kan rettes senere. Navn som finnes fra før, hoppes over.
        </p>
      }
      onClose={onClose}
      busy={busy}
      className="max-w-xl"
    >
      <form onSubmit={showPreview} className="space-y-4">
        {!fixedType && types.length > 1 && (
          <Field label="Type">
            <Select value={form.typeId} onChange={(e) => change({ typeId: e.target.value })}>
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Fra år">
            <Select
              value={form.fromYear}
              onChange={(e) => change({ fromYear: Number(e.target.value) })}
            >
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Til og med år">
            <Select
              value={form.toYear}
              onChange={(e) => change({ toYear: Number(e.target.value) })}
            >
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-stone-800">Hvor ofte</legend>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {frequencies.map((f) => (
              <label
                key={f.value}
                className={cx(
                  'flex cursor-pointer items-start gap-2.5 rounded-xl px-3 py-2.5 text-sm ring-1 transition ring-inset has-focus-visible:ring-2 has-focus-visible:ring-brand-500',
                  form.frequency === f.value
                    ? 'bg-brand-50 ring-brand-300'
                    : 'bg-white ring-stone-200 hover:ring-stone-400',
                )}
              >
                <input
                  type="radio"
                  name="frequency"
                  value={f.value}
                  checked={form.frequency === f.value}
                  onChange={() => change({ frequency: f.value })}
                  className="mt-0.5 accent-brand-600"
                />
                <span>
                  <span className="block font-medium text-stone-900">{f.label}</span>
                  <span className="block text-xs text-stone-500">
                    «{type?.name ?? 'ESAF-helgen'} {f.example}»
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <Field label="Sted" hint="Valgfritt. Gjelder alle; kan rettes på hvert arrangement.">
          <Input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            maxLength={120}
            placeholder="Trondheim"
          />
        </Field>

        {!preview && (
          <>
            {error && <ErrorText>{error}</ErrorText>}
            <DialogActions>
              <Button variant="secondary" onClick={onClose} disabled={busy}>
                Avbryt
              </Button>
              <Button type="submit" variant="brand" disabled={busy}>
                {busy ? 'Ser etter …' : 'Forhåndsvis'}
              </Button>
            </DialogActions>
          </>
        )}
      </form>

      {preview && (
        <div className="mt-5 space-y-3">
          <p className="text-sm text-stone-600">
            {plural(count, 'arrangement', 'arrangementer')} lages
            {summary(preview.rows)}
          </p>
          <ul className="max-h-80 divide-y divide-stone-100 overflow-y-auto rounded-xl ring-1 ring-stone-200 ring-inset">
            {preview.rows.map((r) => {
              const key = rowKey(r)
              const selectable = r.status === 'new' || r.status === 'overlap'
              return (
                <li key={key} className="flex items-start gap-3 px-3 py-2.5 text-sm">
                  <input
                    type="checkbox"
                    aria-label={`Lag ${r.name}`}
                    checked={chosen.has(key)}
                    disabled={!selectable || busy}
                    onChange={(e) =>
                      setChosen((set) => {
                        const next = new Set(set)
                        if (e.target.checked) next.add(key)
                        else next.delete(key)
                        return next
                      })
                    }
                    className="mt-0.5 accent-brand-600"
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cx(
                        'block font-medium',
                        selectable ? 'text-stone-900' : 'text-stone-500',
                      )}
                    >
                      {r.name}
                    </span>
                    {r.existing && (
                      <span className="block text-xs text-stone-500">
                        {r.status === 'exists' ? 'Står der: ' : 'Finnes: '}
                        <Link
                          to="/arrangementer/$typeSlug/$eventId"
                          params={{ typeSlug: preview.type.slug, eventId: r.existing.id }}
                          target="_blank"
                          className="font-medium text-stone-700 hover:text-brand-600"
                        >
                          {r.existing.name}
                        </Link>{' '}
                        ({eventWhen(r.existing)})
                      </span>
                    )}
                  </span>
                  <span
                    className={cx(
                      'shrink-0 text-xs font-medium',
                      r.status === 'new'
                        ? 'text-emerald-700'
                        : r.status === 'overlap'
                          ? 'text-amber-700'
                          : 'text-stone-500',
                    )}
                  >
                    {statusText[r.status]}
                  </span>
                </li>
              )
            })}
          </ul>
          {preview.rows.some((r) => r.status === 'overlap') && (
            <p className="text-xs text-stone-500">
              Der et annet arrangement finnes i samme periode, er raden ikke valgt. Kryss av hvis
              det var to.
            </p>
          )}
          {error && <ErrorText>{error}</ErrorText>}
          <DialogActions>
            <Button variant="secondary" onClick={() => setPreview(null)} disabled={busy}>
              Endre valgene
            </Button>
            <Button variant="brand" onClick={create} disabled={busy || count === 0}>
              {busy
                ? 'Lagrer …'
                : count === 0
                  ? 'Ingenting å lage'
                  : `Opprett ${plural(count, 'arrangement', 'arrangementer')}`}
            </Button>
          </DialogActions>
        </div>
      )}
    </Dialog>
  )
}

/** «, 2 finnes allerede, 1 i samme periode som et annet» */
function summary(rows: HistoryRow[]) {
  const n = (s: HistoryRow['status']) => rows.filter((r) => r.status === s).length
  const parts = [
    n('exists') > 0 && `${n('exists')} finnes allerede`,
    n('overlap') > 0 && `${n('overlap')} i samme periode som et annet`,
    n('future') > 0 && `${n('future')} har ikke vært ennå`,
  ].filter(Boolean)
  return parts.length ? `. ${parts.join(', ')}.` : '.'
}
