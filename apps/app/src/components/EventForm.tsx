import type { EventTypeInfo } from '@esaf/core'
import { useState, type FormEvent, type ReactNode } from 'react'
import type { EventFormValues, EventTypeFormValues } from '#/lib/events.functions.ts'
import { Dialog, DialogActions } from './Dialog.tsx'
import { Button, ErrorText, Field, Input, Select, Textarea } from './ui.tsx'

export const emptyEvent = (typeId: string): EventFormValues => ({
  typeId,
  name: '',
  startDate: '',
  endDate: null,
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
 * Skjemaet for et arrangement: nytt arrangement på oversikten for typen og
 * «Rediger» på siden til arrangementet. Valideringen skjer i @esaf/core; feilen
 * vises her.
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
          {types.length > 1 && (
            <Field label="Type">
              <Select value={values.typeId} onChange={(e) => set({ typeId: e.target.value })}>
                {types.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Navn">
            <Input
              data-autofocus
              required
              value={values.name}
              onChange={(e) => set({ name: e.target.value })}
              maxLength={120}
              placeholder="ESAF-helgen høst 2026"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Fra">
              <Input
                type="date"
                required
                value={values.startDate}
                onChange={(e) => set({ startDate: e.target.value })}
              />
            </Field>
            <Field label="Til" hint="Valgfritt">
              <Input
                type="date"
                value={values.endDate ?? ''}
                min={values.startDate || undefined}
                onChange={(e) => set({ endDate: e.target.value || null })}
              />
            </Field>
          </div>
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
      )}
    </FormDialog>
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
