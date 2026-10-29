import { useState, type FormEvent, type ReactNode } from 'react'
import { TagInput } from './TagInput.tsx'
import { Button, Card, cx, ErrorText, Field, Input, Textarea } from './ui.tsx'
import { statusLabels, statusOrder, type CompanyStatus } from '#/lib/companies.ts'
import type { CompanyFormValues } from '#/lib/companies.functions.ts'
import { industrySuggestions } from '#/lib/industries.ts'

const thisYear = new Date().getFullYear()

export function Section({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    <Card className="grid gap-6 p-5 sm:p-6 md:grid-cols-[200px_minmax(0,1fr)]">
      <div>
        <h2 className="text-sm font-semibold text-stone-950">{title}</h2>
        {description && (
          <p className="mt-1 text-xs leading-relaxed text-stone-500">{description}</p>
        )}
      </div>
      <div className="min-w-0 space-y-4">{children}</div>
    </Card>
  )
}

/**
 * Skjemaet for selskapsinfo, brukt både til å redigere og til å foreslå endringer.
 * `extra` står til slutt (f.eks. en kommentar til forslaget), og `cancel` ved knappen.
 */
export function CompanyForm({
  initial,
  onSubmit,
  submitLabel,
  savingLabel = 'Lagrer …',
  cancel,
  extra,
}: {
  initial: CompanyFormValues
  /** Får verdiene og skjemadataene (for felt i `extra`). Kast en feil for å vise den. */
  onSubmit: (values: CompanyFormValues, form: FormData) => Promise<void>
  submitLabel: string
  savingLabel?: string
  cancel: ReactNode
  extra?: ReactNode
}) {
  const [industries, setIndustries] = useState(initial.industries)
  const [status, setStatus] = useState<CompanyStatus>(initial.status)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const text = (name: string) => String(form.get(name) ?? '')
    const founded = text('foundedYear').trim()
    setSaving(true)
    setError(null)
    try {
      if (founded && (Number(founded) < 1800 || Number(founded) > thisYear + 1)) {
        throw new Error(`«${founded}» er ikke et gyldig årstall.`)
      }
      await onSubmit(
        {
          name: text('name'),
          tagline: text('tagline'),
          description: text('description'),
          website: text('website'),
          foundedYear: founded ? Number(founded) : null,
          location: text('location'),
          industries,
          status,
        },
        form,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke lagre.')
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Section title="Om selskapet" description="Det andre ser først på selskapssiden.">
        <Field
          label="Navn"
          hint="Et nytt navn gir ny adresse til siden. Gamle lenker sendes videre."
        >
          <Input name="name" defaultValue={initial.name} required maxLength={120} />
        </Field>
        <Field label="Kort beskrivelse" hint="Én linje om hva selskapet gjør.">
          <Input
            name="tagline"
            defaultValue={initial.tagline}
            maxLength={140}
            placeholder="Sanntids vannkvalitet for oppdrettere"
          />
        </Field>
        <Field label="Om selskapet">
          <Textarea
            name="description"
            defaultValue={initial.description}
            rows={6}
            maxLength={3000}
            placeholder="Hva lager dere, for hvem, og hvor langt har dere kommet?"
          />
        </Field>
      </Section>

      <Section title="Fakta">
        <Field label="Nettside">
          <Input
            name="website"
            defaultValue={initial.website}
            inputMode="url"
            maxLength={300}
            placeholder="syrlig.no"
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-[8rem_minmax(0,1fr)]">
          <Field label="Grunnlagt">
            <Input
              name="foundedYear"
              defaultValue={initial.foundedYear ?? ''}
              inputMode="numeric"
              pattern="[0-9]{4}"
              maxLength={4}
              placeholder={String(thisYear)}
            />
          </Field>
          <Field label="Sted">
            <Input
              name="location"
              defaultValue={initial.location}
              maxLength={80}
              placeholder="Trondheim"
            />
          </Field>
        </div>
        <fieldset>
          <legend className="text-sm font-medium text-stone-800">Status</legend>
          <div className="mt-1.5 inline-flex flex-wrap rounded-xl bg-stone-200/60 p-1">
            {statusOrder.map((s) => (
              <label
                key={s}
                className={cx(
                  'inline-flex h-8 cursor-pointer items-center rounded-lg px-3 text-sm font-medium transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-500',
                  status === s
                    ? 'bg-white text-stone-950 shadow-card'
                    : 'text-stone-600 hover:text-stone-900',
                )}
              >
                <input
                  type="radio"
                  name="status"
                  value={s}
                  checked={status === s}
                  onChange={() => setStatus(s)}
                  className="sr-only"
                />
                {statusLabels[s]}
              </label>
            ))}
          </div>
        </fieldset>
      </Section>

      <Section title="Bransjer" description="Gjør selskapet lett å finne i oversikten.">
        <TagInput
          label="Bransjer"
          value={industries}
          onChange={setIndustries}
          suggestions={industrySuggestions}
          placeholder="Skriv en bransje og trykk Enter"
        />
      </Section>

      {extra}

      {error && <ErrorText>{error}</ErrorText>}
      <div className="sticky bottom-0 -mx-4 flex justify-end gap-2 border-t border-stone-200 bg-stone-50/90 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-2xl sm:border sm:px-4">
        {cancel}
        <Button type="submit" variant="brand" disabled={saving}>
          {saving ? savingLabel : submitLabel}
        </Button>
      </div>
    </form>
  )
}

/** Verdiene til skjemaet fra et selskap, med tomme felt som tom tekst. */
export function companyFormValues(c: {
  name: string
  tagline: string | null
  description: string | null
  website: string | null
  foundedYear: number | null
  location: string | null
  industries: string[]
  status: CompanyStatus
}): CompanyFormValues {
  return {
    name: c.name,
    tagline: c.tagline ?? '',
    description: c.description ?? '',
    website: c.website ?? '',
    foundedYear: c.foundedYear,
    location: c.location ?? '',
    industries: c.industries,
    status: c.status,
  }
}
