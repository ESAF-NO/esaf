import type { AssetView } from '@esaf/core'
import { Link2, Users, X } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { channelOrder, channels, type ChannelKey } from '#/lib/channels.ts'
import { useDraft } from '#/lib/drafts.ts'
import { useAttachments } from './Attachments.tsx'
import { Composer } from './Composer.tsx'
import { Button, cx, ErrorText } from './ui.tsx'

export type PostFormValues = { channel: ChannelKey; title: string; body: string; url: string }

/** Kanaler der en lenke er vanlig: lanseringer, stillinger og påmeldinger. */
const linkChannels: ChannelKey[] = ['lansering', 'jobb', 'arrangement']

/**
 * Skjemaet for nye innlegg og for å redigere et innlegg: hva slags innlegg som
 * små valg øverst, og tittel, tekst, vedlegg og lenke i ett skrivefelt
 * (`Composer`). Et nytt innlegg huskes som utkast til det er publisert
 * (`draftKey`). Valideringen skjer i @esaf/core.
 */
export function PostForm({
  initial,
  initialAttachments = [],
  submitLabel,
  savingLabel,
  onSubmit,
  cancel,
  autoFocus = false,
  draftKey = null,
}: {
  initial: PostFormValues
  /** Vedleggene innlegget har fra før, når det redigeres. */
  initialAttachments?: AssetView[]
  submitLabel: string
  savingLabel: string
  /** Kaster en feil med en melding til brukeren hvis noe er galt. */
  onSubmit: (values: PostFormValues & { attachmentIds: string[] }) => Promise<void>
  /** Lenken tilbake, ved siden av lagreknappen. */
  cancel: ReactNode
  autoFocus?: boolean
  /** Husk teksten som utkast under denne nøkkelen (nye innlegg). */
  draftKey?: string | null
}) {
  const [values, setValues, clearDraft] = useDraft(draftKey, initial)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const attachments = useAttachments({ til: 'innlegg' }, initialAttachments)
  const set = (patch: Partial<PostFormValues>) => setValues((v) => ({ ...v, ...patch }))
  const c = channels[values.channel]
  // Har innlegget allerede en lenke, vises feltet uansett kanal, så den kan endres eller fjernes.
  const linkSuggested = linkChannels.includes(values.channel) || initial.url !== ''
  const [showLink, setShowLink] = useState(initial.url !== '')
  const wantsUrl = linkSuggested || showLink

  async function submit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await onSubmit({
        ...values,
        url: wantsUrl ? values.url : '',
        attachmentIds: attachments.ids,
      })
      clearDraft()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke lagre innlegget.')
      setSaving(false)
    }
  }

  return (
    // Filer kan slippes og bilder limes inn hvor som helst i skjemaet.
    <form onSubmit={submit} className="space-y-4" {...attachments.drop.props}>
      <fieldset>
        <legend className="sr-only">Hva slags innlegg?</legend>
        <div className="flex flex-wrap gap-2">
          {channelOrder.map((key) => {
            const option = channels[key]
            const selected = key === values.channel
            return (
              <label
                key={key}
                title={option.hint}
                className={cx(
                  'inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full px-3.5 text-sm font-medium ring-1 transition ring-inset has-focus-visible:ring-2 has-focus-visible:ring-brand-500',
                  selected
                    ? option.tone
                    : 'bg-white text-stone-600 ring-stone-200 hover:text-stone-900 hover:ring-stone-300',
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
                <option.icon className="size-4" aria-hidden />
                {option.label}
              </label>
            )
          })}
        </div>
        <p className="mt-2 text-sm text-stone-500" aria-live="polite">
          {c.hint}.
        </p>
      </fieldset>

      <Composer
        id="innlegg-tekst"
        label="Teksten i innlegget"
        value={values.body}
        onChange={(body) => set({ body })}
        placeholder={c.prompt}
        maxLength={10000}
        attachments={attachments}
        minRows={6}
        dragging={attachments.drop.dragging}
        header={
          <>
            <label htmlFor="innlegg-tittel" className="sr-only">
              Tittel
            </label>
            <input
              id="innlegg-tittel"
              name="title"
              value={values.title}
              onChange={(e) => set({ title: e.target.value })}
              required
              minLength={3}
              maxLength={200}
              placeholder={c.placeholder}
              autoFocus={autoFocus}
              autoComplete="off"
              className="block w-full border-0 bg-transparent px-4 pt-4 pb-0 text-xl font-semibold tracking-tight text-stone-950 placeholder:font-medium placeholder:text-stone-300 focus:ring-0 focus:outline-none"
            />
          </>
        }
        footer={
          wantsUrl ? (
            <div className="mx-4 mb-3 flex items-center gap-2 rounded-xl bg-stone-50 px-3 ring-1 ring-stone-200/70 focus-within:ring-2 focus-within:ring-brand-500 ring-inset">
              <Link2 className="size-4 shrink-0 text-stone-400" aria-hidden />
              <label htmlFor="innlegg-lenke" className="sr-only">
                Lenke
              </label>
              <input
                id="innlegg-lenke"
                name="url"
                type="url"
                value={values.url}
                onChange={(e) => set({ url: e.target.value })}
                placeholder={
                  values.channel === 'jobb'
                    ? 'Lenke til annonsen (valgfritt)'
                    : values.channel === 'arrangement'
                      ? 'Lenke til påmelding (valgfritt)'
                      : 'Lenke (valgfritt), for eksempel nettsiden'
                }
                className="h-10 min-w-0 flex-1 border-0 bg-transparent p-0 text-sm text-stone-900 placeholder:text-stone-400 focus:ring-0 focus:outline-none"
              />
              {!linkSuggested && (
                <button
                  type="button"
                  onClick={() => {
                    set({ url: '' })
                    setShowLink(false)
                  }}
                  className="rounded-md p-1 text-stone-400 hover:bg-stone-200/60 hover:text-stone-700"
                  aria-label="Fjern lenken"
                >
                  <X className="size-4" aria-hidden />
                </button>
              )}
            </div>
          ) : (
            <div className="px-4 pb-2">
              <button
                type="button"
                onClick={() => setShowLink(true)}
                className="inline-flex items-center gap-1.5 rounded-md text-sm text-stone-500 hover:text-stone-900"
              >
                <Link2 className="size-4" aria-hidden /> Legg til lenke
              </button>
            </div>
          )
        }
      />

      {error && <ErrorText>{error}</ErrorText>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-1.5 text-sm text-stone-500">
          <Users className="size-4" aria-hidden />
          Synlig for alle godkjente medlemmer
        </p>
        <div className="flex items-center gap-2">
          {cancel}
          <Button type="submit" variant="brand" disabled={saving || attachments.busy}>
            {saving ? savingLabel : attachments.busy ? 'Laster opp …' : submitLabel}
          </Button>
        </div>
      </div>
    </form>
  )
}
