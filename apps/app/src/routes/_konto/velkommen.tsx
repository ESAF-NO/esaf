import { createFileRoute, useRouter } from '@tanstack/react-router'
import { BadgeCheck } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { AccessSteps, AuthCard } from '#/components/AuthLayout.tsx'
import { Avatar, Button, ErrorText, Field, Input, Select, Textarea } from '#/components/ui.tsx'
import { fetchAccessState, sendAccessRequest } from '#/lib/access.functions.ts'
import { esPeriod } from '#/lib/format.ts'

export const Route = createFileRoute('/_konto/velkommen')({
  loader: () => fetchAccessState(),
  head: () => ({ meta: [{ title: 'Hvem er du? – ESAF' }] }),
  component: WhoAreYou,
})

// Nåværende studenter er med: ES-kull navngis etter året de blir uteksaminert.
const newest = new Date().getFullYear() + 2
const years = Array.from({ length: newest - 2005 + 1 }, (_, i) => newest - i)

function WhoAreYou() {
  const state = Route.useLoaderData()
  const router = useRouter()
  const previous = state.request
  const [useMatch, setUseMatch] = useState(Boolean(state.match && (!previous || previous.profile)))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const match = useMatch ? state.match : null

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const text = (name: string) => String(form.get(name) ?? '')
    setSaving(true)
    setError(null)
    try {
      await sendAccessRequest({
        data: {
          profilePersonId: match?.personId ?? null,
          fullName: match ? match.fullName : text('fullName'),
          graduationYear: match
            ? (match.years.at(-1) ?? null)
            : text('kull')
              ? Number(text('kull'))
              : null,
          linkedinUrl: text('linkedinUrl'),
          note: text('note'),
        },
      })
      await router.invalidate()
      await router.navigate({ to: '/venter' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke sende forespørselen.')
      setSaving(false)
    }
  }

  return (
    <>
      <AccessSteps current={2} className="mb-6" />
      <AuthCard
        title="Hvem er du?"
        subtitle="Styret må vite hvem du er før de slipper deg inn. Det du skriver her, ser bare styret."
      >
        <form onSubmit={onSubmit} className="space-y-5">
          {match ? (
            <div>
              <p className="text-sm text-stone-600">
                <strong className="font-medium text-stone-900">{state.email}</strong> står i
                kullisten på denne profilen:
              </p>
              <div className="mt-3 flex items-center gap-3.5 rounded-2xl bg-brand-50/70 p-4 ring-1 ring-brand-200 ring-inset">
                <Avatar name={match.fullName} size="lg" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-stone-950">{match.fullName}</p>
                  <p className="text-sm text-stone-600">
                    {match.years.length
                      ? match.years.map((y) => `ES ${y} (${esPeriod(y)})`).join(', ')
                      : 'Kull ikke oppgitt'}
                  </p>
                </div>
                <BadgeCheck className="size-6 shrink-0 fill-brand-500 text-white" aria-hidden />
              </div>
              <button
                type="button"
                onClick={() => setUseMatch(false)}
                className="mt-2.5 text-sm text-stone-500 underline-offset-2 hover:text-stone-900 hover:underline"
              >
                Dette er ikke meg
              </button>
            </div>
          ) : (
            <>
              <p className="rounded-xl bg-stone-50 px-4 py-3 text-sm leading-relaxed text-stone-600 ring-1 ring-stone-200/70 ring-inset">
                {state.match
                  ? 'Greit. Fortell hvem du er, så finner styret riktig profil.'
                  : `Vi fant ikke ${state.email} i kullisten. Det er helt greit: fortell hvem du er, så finner styret deg.`}
              </p>
              <Field label="Fullt navn">
                <Input
                  name="fullName"
                  defaultValue={previous && !previous.profile ? previous.fullName : ''}
                  autoComplete="name"
                  required
                  minLength={2}
                  maxLength={120}
                  autoFocus
                />
              </Field>
              <Field label="Kull" hint="Året kullet ble uteksaminert. ES 2024 gikk 2022–2024.">
                <Select name="kull" defaultValue={previous?.graduationYear ?? ''}>
                  <option value="">Velg kull</option>
                  {years.map((y) => (
                    <option key={y} value={y}>
                      ES {y} ({esPeriod(y)})
                    </option>
                  ))}
                </Select>
              </Field>
              {state.match && (
                <button
                  type="button"
                  onClick={() => setUseMatch(true)}
                  className="text-sm text-stone-500 underline-offset-2 hover:text-stone-900 hover:underline"
                >
                  Tilbake til {state.match.fullName}
                </button>
              )}
            </>
          )}

          <Field label="LinkedIn" hint="Valgfritt. Gjør det lettere for styret å kjenne deg igjen.">
            <Input
              name="linkedinUrl"
              defaultValue={previous?.linkedinUrl ?? ''}
              placeholder="https://www.linkedin.com/in/…"
            />
          </Field>
          <Field
            label="Melding til styret"
            hint="Valgfritt. For eksempel adressen du brukte på ES, eller hvem i kullet som kan gå god for deg."
          >
            <Textarea name="note" defaultValue={previous?.note ?? ''} rows={3} maxLength={500} />
          </Field>
          {error && <ErrorText>{error}</ErrorText>}
          <Button type="submit" variant="brand" size="lg" className="w-full" disabled={saving}>
            {saving ? 'Sender …' : match ? 'Ja, det er meg' : 'Send forespørsel'}
          </Button>
        </form>
      </AuthCard>
    </>
  )
}
