import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { ArrowRight, MailCheck } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { AccessSteps, AuthCard, AuthShell } from '#/components/AuthLayout.tsx'
import { Button, ErrorText, Field, Input } from '#/components/ui.tsx'
import { authClient } from '#/lib/auth-client.ts'

export const Route = createFileRoute('/registrer')({
  beforeLoad: ({ context }) => {
    if (context.viewer.level !== 'anonymous') throw redirect({ to: '/feed' })
  },
  head: () => ({ meta: [{ title: 'Be om tilgang – ESAF' }] }),
  component: SignUp,
})

function SignUp() {
  const [state, setState] = useState<'idle' | 'pending' | 'sent'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [email, setEmail] = useState('')

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const address = String(form.get('email')).trim()
    setState('pending')
    setError(null)
    setEmail(address)
    const { error } = await authClient.signUp.email({
      // Better Auth krever et navn. Det ekte navnet kommer i neste steg («Hvem er du?»).
      name: address.split('@')[0] ?? address,
      email: address,
      password: String(form.get('password')),
      callbackURL: '/velkommen',
    })
    // Samme svar om adressen allerede har en konto, så ingen kan sjekke hvem som er registrert.
    if (error && error.code !== 'USER_ALREADY_EXISTS') {
      setState('idle')
      setError(error.message ?? 'Kunne ikke opprette konto.')
      return
    }
    setState('sent')
  }

  const login = (
    <Link to="/logg-inn" className="text-sm font-medium text-stone-600 hover:text-stone-950">
      Logg inn
    </Link>
  )

  if (state === 'sent') {
    return (
      <AuthShell action={login}>
        <AccessSteps current={1} className="mb-6" />
        <AuthCard
          title="Sjekk e-posten din"
          subtitle={
            <>
              Vi har sendt en lenke til <strong className="text-stone-900">{email}</strong>. Åpne
              den for å bekrefte at adressen er din. Så forteller du hvem du er. Har du allerede en
              konto med denne adressen,{' '}
              <Link to="/logg-inn" className="font-medium text-brand-600 hover:underline">
                logger du bare inn
              </Link>
              .
            </>
          }
        >
          <div className="flex items-center gap-4 rounded-2xl bg-stone-50 p-4 ring-1 ring-stone-200/70 ring-inset">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-200 ring-inset">
              <MailCheck className="size-5" aria-hidden />
            </span>
            <p className="text-sm text-stone-600">
              Finner du den ikke? Sjekk søppelpost, eller vent et par minutter.
            </p>
          </div>
          {import.meta.env.DEV && (
            <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200 ring-inset">
              Lokalt: lenken skrives ut i terminalen der appen kjører.
            </p>
          )}
        </AuthCard>
      </AuthShell>
    )
  }

  return (
    <AuthShell action={login}>
      <AccessSteps current={0} className="mb-6" />
      <AuthCard
        title="Be om tilgang"
        subtitle="ESAF er for alle som går eller har gått på Entreprenørskolen. Styret sjekker hver forespørsel, så bare ES-ere slipper inn."
        footer={
          <>
            Har du konto?{' '}
            <Link to="/logg-inn" className="font-medium text-brand-600 hover:underline">
              Logg inn
            </Link>
          </>
        }
      >
        <form onSubmit={onSubmit} className="space-y-4">
          <Field
            label="E-post"
            hint="Bruk gjerne adressen du står med i kullisten. Da går godkjenningen raskere."
          >
            <Input name="email" type="email" autoComplete="email" required autoFocus />
          </Field>
          <Field label="Passord" hint="Minst 12 tegn.">
            <Input
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              required
            />
          </Field>
          {error && <ErrorText>{error}</ErrorText>}
          <Button
            type="submit"
            variant="brand"
            size="lg"
            className="w-full"
            disabled={state === 'pending'}
          >
            {state === 'pending' ? 'Oppretter …' : 'Fortsett'}
            {state !== 'pending' && <ArrowRight className="size-4" aria-hidden />}
          </Button>
        </form>
      </AuthCard>
    </AuthShell>
  )
}
