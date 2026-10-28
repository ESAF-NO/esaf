import { useState, type FormEvent, type ReactNode } from 'react'
import { channelOrder, channels, type ChannelKey } from '#/lib/channels.ts'
import { MarkdownEditor } from './MarkdownEditor.tsx'
import { Button, Card, cx, ErrorText, Field, Input } from './ui.tsx'

export type PostFormValues = { channel: ChannelKey; title: string; body: string; url: string }

/** Kanaler der en lenke er vanlig: lanseringer, stillinger og påmeldinger. */
const linkChannels: ChannelKey[] = ['lansering', 'jobb', 'arrangement']

/** Skjemaet for nye innlegg og for å redigere et innlegg. Valideringen skjer i @esaf/core. */
export function PostForm({
  initial,
  submitLabel,
  savingLabel,
  onSubmit,
  cancel,
  autoFocus = false,
}: {
  initial: PostFormValues
  submitLabel: string
  savingLabel: string
  /** Kaster en feil med en melding til brukeren hvis noe er galt. */
  onSubmit: (values: PostFormValues) => Promise<void>
  /** Lenken tilbake, ved siden av lagreknappen. */
  cancel: ReactNode
  autoFocus?: boolean
}) {
  const [values, setValues] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const set = (patch: Partial<PostFormValues>) => setValues((v) => ({ ...v, ...patch }))
  const c = channels[values.channel]
  // Har innlegget allerede en lenke, vises feltet uansett kanal, så den kan endres eller fjernes.
  const wantsUrl = linkChannels.includes(values.channel) || initial.url !== ''

  async function submit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await onSubmit({ ...values, url: wantsUrl ? values.url : '' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke lagre innlegget.')
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-stone-800">Hva slags innlegg?</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {channelOrder.map((key) => {
            const option = channels[key]
            const selected = key === values.channel
            return (
              <label
                key={key}
                className={cx(
                  'flex cursor-pointer items-center gap-3 rounded-xl bg-white p-3 shadow-card ring-1 transition has-focus-visible:ring-2 has-focus-visible:ring-brand-500',
                  selected ? 'ring-2 ring-stone-900' : 'ring-stone-200 hover:ring-stone-300',
                )}
              >
                <input
                  type="radio"
                  name="channel"
                  value={key}
                  checked={selected}
                  onChange={() => set({ channel: key })}
                  className="sr-only"
                />
                <span
                  className={cx(
                    'grid size-8 shrink-0 place-items-center rounded-lg ring-1 ring-inset',
                    option.tone,
                  )}
                >
                  <option.icon className="size-4" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-stone-900">{option.label}</span>
                  <span className="block truncate text-xs text-stone-500">{option.hint}</span>
                </span>
              </label>
            )
          })}
        </div>
      </fieldset>

      <Card className="space-y-5 p-5">
        <Field label="Tittel">
          <Input
            name="title"
            value={values.title}
            onChange={(e) => set({ title: e.target.value })}
            required
            minLength={3}
            maxLength={200}
            placeholder={c.placeholder}
            autoFocus={autoFocus}
          />
        </Field>
        <MarkdownEditor
          id="innlegg-tekst"
          name="body"
          label="Detaljer"
          value={values.body}
          onChange={(body) => set({ body })}
          maxLength={10000}
          placeholder="Gi nok kontekst til at folk kan hjelpe. Hold det kort og konkret."
          className="min-h-44"
        />
        {wantsUrl && (
          <Field
            label="Lenke"
            hint="Valgfritt. For eksempel nettside, stillingsannonse eller påmelding."
          >
            <Input
              name="url"
              type="url"
              value={values.url}
              onChange={(e) => set({ url: e.target.value })}
              placeholder="https://"
            />
          </Field>
        )}
      </Card>

      {error && <ErrorText>{error}</ErrorText>}
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-stone-500">Synlig for alle godkjente ESAF-medlemmer.</p>
        <div className="flex gap-2">
          {cancel}
          <Button type="submit" variant="brand" disabled={saving}>
            {saving ? savingLabel : submitLabel}
          </Button>
        </div>
      </div>
    </form>
  )
}
