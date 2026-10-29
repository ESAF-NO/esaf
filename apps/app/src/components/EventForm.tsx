import type { EventTypeInfo } from '@esaf/core'
import type { EventDatePrecision } from '@esaf/db'
import { useState, type FormEvent, type ReactNode } from 'react'
import type { EventFormValues, EventTypeFormValues } from '#/lib/events.functions.ts'
import { periodStart, precisionLabels, seasonOf, suggestEventName } from '#/lib/events.ts'
import { Dialog, DialogActions } from './Dialog.tsx'
import { Button, cx, ErrorText, Field, Input, Select, Textarea } from './ui.tsx'

export const emptyEvent = (typeId: string): EventFormValues => ({
  typeId,
  name: '',
  startDate: '',
  endDate: null,
  datePrecision: 'day',
  location: '',
  description: '',
})

/** Et skjema i en dialog som viser feilen fra serveren og holder seg åpent til det er lagret. */
function FormDialog<T>({
  title,
  initial,
  submitLabel,
  onSubmit,
  onClose,
  children,
}: {
  title: string
  initial: T
  submitLabel: string
  onSubmit: (values: T) => Promise<void>
  onClose: () => void
  children: (values: T, set: (patch: Partial<T>) => void) => ReactNode
}) {
  const [values, setValues] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<T>) => setValues((v) => ({ ...v, ...patch }))

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await onSubmit(values)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke lagre.')
      setBusy(false)
    }
  }

  return (
    <Dialog title={title} onClose={onClose} busy={busy}>
      <form onSubmit={submit} className="space-y-4">
        {children(values, set)}
        {error && <ErrorText>{error}</ErrorText>}
        <DialogActions>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Avbryt
          </Button>
          <Button type="submit" variant="brand" disabled={busy}>
            {busy ? 'Lagrer …' : submitLabel}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

/**
 * Skjemaet for et arrangement: «Nytt arrangement» og «Rediger». Datoen kan være
 * kjent på dagen, eller bare semesteret eller året, for gamle arrangementer.
 * Navnet foreslås fra typen og datoen («ESAF-helgen høst 2018») til admin
 * skriver et selv. Valideringen skjer i @esaf/core; feilen vises her.
 */
export function EventDialog({
  title,
  initial,
  types,
  submitLabel,
  onSubmit,
  onClose,
}: {
  title: string
  initial: EventFormValues
  /** Typene arrangementet kan høre til. Med bare én vises ikke valget. */
  types: Pick<EventTypeInfo, 'id' | 'name'>[]
  submitLabel: string
  onSubmit: (values: EventFormValues) => Promise<void>
  onClose: () => void
}) {
  // Navnet følger typen og datoen til admin har skrevet noe selv.
  const [nameTouched, setNameTouched] = useState(initial.name.trim() !== '')
  const typeName = (id: string) => types.find((t) => t.id === id)?.name
  return (
    <FormDialog
      title={title}
      initial={initial}
      submitLabel={submitLabel}
      onSubmit={onSubmit}
      onClose={onClose}
    >
      {(values, set) => {
        const update = (patch: Partial<EventFormValues>) => {
          const next = { ...values, ...patch }
          const suggested = suggestEventName(
            typeName(next.typeId),
            next.startDate,
            next.datePrecision,
          )
          set(nameTouched || !suggested ? patch : { ...patch, name: suggested })
        }
        return (
          <>
            {types.length > 1 && (
              <Field label="Type">
                <Select value={values.typeId} onChange={(e) => update({ typeId: e.target.value })}>
                  {types.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <EventDateFields value={values} onChange={update} />
            <Field
              label="Navn"
              hint={
                nameTouched ? undefined : 'Foreslått fra typen og datoen. Skriv over om du vil.'
              }
            >
              <Input
                required
                value={values.name}
                onChange={(e) => {
                  setNameTouched(e.target.value.trim() !== '')
                  set({ name: e.target.value })
                }}
                maxLength={120}
                placeholder={`${typeName(values.typeId) ?? 'ESAF-helgen'} høst 2018`}
              />
            </Field>
            <Field label="Sted" hint="Valgfritt">
              <Input
                value={values.location}
                onChange={(e) => set({ location: e.target.value })}
                maxLength={120}
                placeholder="Trondheim"
              />
            </Field>
            <Field
              label="Om arrangementet"
              hint="Valgfritt. Program, tema eller hvem som arrangerte."
            >
              <Textarea
                value={values.description}
                onChange={(e) => set({ description: e.target.value })}
                maxLength={2000}
              />
            </Field>
          </>
        )
      }}
    </FormDialog>
  )
}

type DateValues = Pick<EventFormValues, 'startDate' | 'endDate' | 'datePrecision'>

/** Årene i valgene, nyeste først: to år fram og tilbake til 1990. */
export function yearOptions(now = new Date()) {
  const last = now.getFullYear() + 2
  return Array.from({ length: last - 1990 + 1 }, (_, i) => last - i)
}

/**
 * Når arrangementet var: en dato (fra–til), et semester eller bare et år.
 * Brukes i skjemaet for arrangementer og når importen lager et nytt.
 */
export function EventDateFields({
  value,
  onChange,
  compact,
}: {
  value: DateValues
  onChange: (patch: Partial<DateValues>) => void
  /** Lavere felt, til importen. */
  compact?: boolean
}) {
  const h = compact ? 'h-9' : undefined
  const known = /^\d{4}-\d{2}-\d{2}$/.test(value.startDate)
  const year = known ? Number(value.startDate.slice(0, 4)) : new Date().getFullYear()
  const season = known ? seasonOf(value.startDate) : 'autumn'

  function choose(precision: EventDatePrecision) {
    if (precision === value.datePrecision) return
    if (precision === 'day') {
      // En dato fra et semester eller år er ikke ekte; admin skriver inn den riktige.
      return onChange({ datePrecision: 'day', startDate: '', endDate: null })
    }
    onChange({
      datePrecision: precision,
      startDate: periodStart(year, precision === 'year' ? 'year' : season),
      endDate: null,
    })
  }

  return (
    <div className="space-y-3">
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-stone-800">Når</legend>
        <div className="inline-flex rounded-lg bg-stone-100 p-0.5">
          {(['day', 'semester', 'year'] as const).map((p) => (
            <label
              key={p}
              className={cx(
                'cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium transition has-focus-visible:ring-2 has-focus-visible:ring-brand-500',
                value.datePrecision === p
                  ? 'bg-white text-stone-950 shadow-sm'
                  : 'text-stone-600 hover:text-stone-900',
              )}
            >
              <input
                type="radio"
                name="datePrecision"
                value={p}
                checked={value.datePrecision === p}
                onChange={() => choose(p)}
                className="sr-only"
              />
              {precisionLabels[p]}
            </label>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-stone-500">
          {value.datePrecision === 'day'
            ? 'Vet du ikke datoen? Velg semester eller bare år.'
            : value.datePrecision === 'semester'
              ? 'Vises som «Høst 2018». Du kan legge inn datoen senere.'
              : 'Vises som «2015». Du kan legge inn datoen senere.'}
        </p>
      </fieldset>
      {value.datePrecision === 'day' ? (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Fra">
            <Input
              type="date"
              required
              min="1990-01-01"
              max="2100-12-31"
              value={value.startDate}
              onChange={(e) => onChange({ startDate: e.target.value })}
              className={h}
            />
          </Field>
          <Field label="Til" hint="Valgfritt">
            <Input
              type="date"
              value={value.endDate ?? ''}
              min={value.startDate || undefined}
              onChange={(e) => onChange({ endDate: e.target.value || null })}
              className={h}
            />
          </Field>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {value.datePrecision === 'semester' && (
            <Field label="Semester">
              <Select
                value={season}
                onChange={(e) =>
                  onChange({ startDate: periodStart(year, e.target.value as 'spring' | 'autumn') })
                }
                className={h}
              >
                <option value="spring">Vår</option>
                <option value="autumn">Høst</option>
              </Select>
            </Field>
          )}
          <Field label="År">
            <Select
              value={year}
              onChange={(e) =>
                onChange({
                  startDate: periodStart(
                    Number(e.target.value),
                    value.datePrecision === 'year' ? 'year' : season,
                  ),
                })
              }
              className={h}
            >
              {yearOptions().map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
    </div>
  )
}

export const emptyEventType: EventTypeFormValues = {
  name: '',
  plural: '',
  description: '',
  sortOrder: 100,
}

/** Skjemaet for en arrangementstype. Adressen lages fra navnet og endres ikke etterpå. */
export function EventTypeDialog({
  title,
  initial,
  slug,
  submitLabel,
  onSubmit,
  onClose,
}: {
  title: string
  initial: EventTypeFormValues
  /** Adressen til en type som finnes. */
  slug?: string
  submitLabel: string
  onSubmit: (values: EventTypeFormValues) => Promise<void>
  onClose: () => void
}) {
  return (
    <FormDialog
      title={title}
      initial={initial}
      submitLabel={submitLabel}
      onSubmit={onSubmit}
      onClose={onClose}
    >
      {(values, set) => (
        <>
          <Field
            label="Navn"
            hint={
              slug
                ? `Adressen er /arrangementer/${slug} og endres ikke, så lenker fortsetter å virke.`
                : 'Adressen lages fra navnet og endres ikke etterpå.'
            }
          >
            <Input
              data-autofocus
              required
              value={values.name}
              onChange={(e) => set({ name: e.target.value })}
              maxLength={60}
              placeholder="Fagkveld"
            />
          </Field>
          <Field label="Flertall" hint="Valgfritt. Brukes i overskrifter, f.eks. «Fagkvelder».">
            <Input
              value={values.plural}
              onChange={(e) => set({ plural: e.target.value })}
              maxLength={60}
              placeholder="Fagkvelder"
            />
          </Field>
          <Field label="Beskrivelse" hint="Valgfritt. Vises øverst på siden for typen.">
            <Textarea
              value={values.description}
              onChange={(e) => set({ description: e.target.value })}
              maxLength={500}
            />
          </Field>
          <Field label="Rekkefølge" hint="Lavest står først. ESAF-helgen har 0.">
            <Input
              type="number"
              min={0}
              max={1000}
              required
              value={values.sortOrder}
              onChange={(e) => set({ sortOrder: Number(e.target.value) })}
              className="w-28"
            />
          </Field>
        </>
      )}
    </FormDialog>
  )
}
