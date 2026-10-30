import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { MailCheck, MailX } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { AuthCard, AuthShell } from '#/components/AuthLayout.tsx'
import { Button, ErrorText, Field, Input } from '#/components/ui.tsx'
import { authClient } from '#/lib/auth-client.ts'
import { fetchAuthOptions } from '#/lib/invitations.functions.ts'

/**
 * «Glemt passord?»: en lenke for nytt passord på e-post. Svaret er det samme
 * om adressen har en konto eller ikke, så siden kan ikke brukes til å sjekke
 * hvem som er registrert. Uten e-postleverandør finnes ikke endepunktet, og
 * siden sier at styret lager lenken.
 */
export const Route = createFileRoute('/glemt-passord')({
  beforeLoad: ({ context }) => {
    if (context.viewer.level !== 'anonymous') throw redirect({ to: '/feed' })
  },
  loader: () => fetchAuthOptions(),
  head: () => ({ meta: [{ title: 'Glemt passord – ESAF' }] }),
  component: ForgotPassword,
})

function Shell({ children }: { children: ReactNode }) {
  return (
    <AuthShell
      action={
        <Link to="/logg-inn" className="text-sm font-medium text-stone-600 hover:text-stone-950">
          Logg inn
        </Link>
      }
    >
      {children}
    </AuthShell>
  )
}

function ForgotPassword() {
  const { emailEnabled } = Route.useLoaderData()
  const [state, setState] = useState<'idle' | 'pending' | 'sent'>('idle')
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const email = String(new FormData(event.currentTarget).get('email')).trim()
    setState('pending')
    setError(null)
    const { error } = await authClient.$fetch('/invitation/request-password-reset', {
      method: 'POST',
      body: { email },
    })
    if (error) {
      setState('idle')
      setError(
        error.status === 429
          ? 'For mange forsøk. Vent et minutt og prøv igjen.'
          : 'Noe gikk galt. Prøv igjen.',
      )
      return
    }
    setState('sent')
  }

  if (!emailEnabled) {
    return (
      <Shell>
        <AuthCard
          title="Glemt passordet?"
          subtitle="Be en i styret om en lenke for å velge nytt passord. Lenken er personlig og virker én gang."
        >
          <div className="flex gap-4 rounded-2xl bg-stone-50 p-4 ring-1 ring-stone-200/70 ring-inset">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-200 ring-inset">
              <MailX className="size-5" aria-hidden />
            </span>
            <p className="text-sm text-stone-600">
              Ta kontakt med styret på{' '}
              <a
                href="mailto:styret@esaf.no"
                className="font-medium text-brand-600 hover:underline"
              >
                styret@esaf.no
              </a>
              . Har du passkey, kan du fortsatt logge inn med den.
            </p>
          </div>
        </AuthCard>
      </Shell>
    )
  }

  if (state === 'sent') {
    return (
      <Shell>
        <AuthCard
          title="Sjekk e-posten din"
          subtitle="Hvis det finnes en konto med denne adressen, har vi sendt en lenke. Den virker i én time."
        >
          <div className="flex items-center gap-4 rounded-2xl bg-stone-50 p-4 ring-1 ring-stone-200/70 ring-inset">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-200 ring-inset">
              <MailCheck className="size-5" aria-hidden />
            </span>
            <p className="text-sm text-stone-600">
              Finner du den ikke? Sjekk søppelpost, eller vent et par minutter før du prøver igjen.
              Kommer det ingenting, ta kontakt med styret på{' '}
              <a
                href="mailto:styret@esaf.no"
                className="font-medium text-brand-600 hover:underline"
              >
                styret@esaf.no
              </a>
              .
            </p>
          </div>
          {import.meta.env.DEV && (
            <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200 ring-inset">
              Lokalt med EMAIL_PROVIDER=console: e-posten skrives ut i terminalen der appen kjører.
            </p>
          )}
        </AuthCard>
      </Shell>
    )
  }

  return (
    <Shell>
      <AuthCard
        title="Glemt passordet?"
        subtitle="Skriv inn e-postadressen du logger inn med, så sender vi en lenke for å velge nytt passord."
        footer={
          <>
            Kom du på det?{' '}
            <Link to="/logg-inn" className="font-medium text-brand-600 hover:underline">
              Logg inn
            </Link>
          </>
        }
      >
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="E-post">
            <Input
              name="email"
              type="email"
              autoComplete="email"
              maxLength={254}
              required
              autoFocus
            />
          </Field>
          {error && <ErrorText>{error}</ErrorText>}
          <Button
            type="submit"
            variant="primary"
            size="lg"
            className="w-full"
            disabled={state === 'pending'}
          >
            {state === 'pending' ? 'Sender …' : 'Send lenke'}
          </Button>
        </form>
      </AuthCard>
    </Shell>
  )
}
