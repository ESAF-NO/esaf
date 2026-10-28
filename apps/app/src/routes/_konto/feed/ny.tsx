import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { z } from 'zod'
import { Button, Card, cx, ErrorText, Field, Input, Textarea } from '#/components/ui.tsx'
import { channelKeys, channelOrder, channels, type ChannelKey } from '#/lib/channels.ts'
import { submitPost } from '#/lib/feed.functions.ts'

export const Route = createFileRoute('/_konto/feed/ny')({
  validateSearch: z.object({ kanal: z.enum(channelKeys).optional().catch(undefined) }),
  head: () => ({ meta: [{ title: 'Nytt innlegg – ESAF' }] }),
  component: NewPost,
})

function NewPost() {
  const { kanal } = Route.useSearch()
  const router = useRouter()
  const [channel, setChannel] = useState<ChannelKey>(kanal ?? 'sporsmal')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const c = channels[channel]
  const wantsUrl = channel === 'lansering' || channel === 'jobb' || channel === 'arrangement'

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    setSaving(true)
    setError(null)
    try {
      const postId = await submitPost({
        data: {
          channel,
          title: String(form.get('title') ?? ''),
          body: String(form.get('body') ?? ''),
          url: String(form.get('url') ?? ''),
        },
      })
      await router.navigate({ to: '/feed/$postId', params: { postId } })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke publisere.')
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <Link
        to="/feed"
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-900"
      >
        <ArrowLeft className="size-4" aria-hidden /> Tilbake
      </Link>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight text-stone-950">Nytt innlegg</h1>

      <form onSubmit={onSubmit} className="space-y-6">
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-stone-800">Hva slags innlegg?</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {channelOrder.map((key) => {
              const option = channels[key]
              const selected = key === channel
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
                    onChange={() => setChannel(key)}
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
              required
              minLength={3}
              maxLength={200}
              placeholder={c.placeholder}
              autoFocus
            />
          </Field>
          <Field
            label="Detaljer"
            hint="Gi nok kontekst til at folk kan hjelpe. Hold det kort og konkret."
          >
            <Textarea name="body" rows={7} maxLength={10000} />
          </Field>
          {wantsUrl && (
            <Field
              label="Lenke"
              hint="Valgfritt. For eksempel nettside, stillingsannonse eller påmelding."
            >
              <Input name="url" type="url" placeholder="https://" />
            </Field>
          )}
        </Card>

        {error && <ErrorText>{error}</ErrorText>}
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-stone-500">Synlig for alle godkjente ESAF-medlemmer.</p>
          <div className="flex gap-2">
            <Link
              to="/feed"
              className="inline-flex h-10 items-center px-3 text-sm text-stone-600 hover:text-stone-900"
            >
              Avbryt
            </Link>
            <Button type="submit" variant="brand" disabled={saving}>
              {saving ? 'Publiserer …' : 'Publiser'}
            </Button>
          </div>
        </div>
      </form>
    </div>
  )
}
