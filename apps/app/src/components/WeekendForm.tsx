import { useState, type FormEvent } from 'react'
import type { WeekendFormValues } from '#/lib/weekends.functions.ts'
import { Dialog, DialogActions } from './Dialog.tsx'
import { Button, ErrorText, Field, Input, Textarea } from './ui.tsx'

export const emptyWeekend: WeekendFormValues = {
  name: '',
  startDate: '',
  endDate: null,
  location: '',
  description: '',
}

/**
 * Skjemaet for en ESAF-helg, i en dialog: ny helg på oversikten og «Rediger» på
 * siden til helgen. Valideringen skjer i @esaf/core; feilen vises her.
 */
export function WeekendDialog({
  title,
  initial,
  submitLabel,
  onSubmit,
  onClose,
}: {
  title: string
  initial: WeekendFormValues
  submitLabel: string
  onSubmit: (values: WeekendFormValues) => Promise<void>
  onClose: () => void
}) {
  const [values, setValues] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<WeekendFormValues>) => setValues((v) => ({ ...v, ...patch }))

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
        <Field label="Om helgen" hint="Valgfritt. Program, tema eller hvem som arrangerte.">
          <Textarea
            value={values.description}
            onChange={(e) => set({ description: e.target.value })}
            maxLength={2000}
          />
        </Field>
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
