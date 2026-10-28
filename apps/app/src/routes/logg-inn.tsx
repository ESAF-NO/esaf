import { createFileRoute, Link, redirect, useRouter } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { AuthCard, AuthShell } from '#/components/AuthLayout.tsx'
import { Button, ErrorText, Field, Input } from '#/components/ui.tsx'
import { authClient } from '#/lib/auth-client.ts'

export const Route = createFileRoute('/logg-inn')({
  beforeLoad: ({ context }) => {
    if (context.viewer.level !== 'anonymous') throw redirect({ to: '/feed' })
  },
  head: () => ({ meta: [{ title: 'Logg inn – ESAF' }] }),
  component: SignIn,
})

function SignIn() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [step, setStep] = useState<'password' | 'code' | 'backup'>('password')

  async function enter() {
    // Rutevaktene sender den som ikke er godkjent ennå, til riktig steg.
    await router.invalidate()
    await router.navigate({ to: '/feed' })
  }

  async function onCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const code = String(new FormData(event.currentTarget).get('code')).replace(/\s/g, '')
    setPending(true)
    setError(null)
    const { error } =
      step === 'code'
        ? await authClient.twoFactor.verifyTotp({ code })
        : await authClient.twoFactor.verifyBackupCode({ code })
    if (error) {
      setPending(false)
      setError(
        error.status === 429
          ? 'For mange feil forsøk. Prøv igjen om et kvarter.'
          : step === 'code'
            ? 'Feil kode. Sjekk at klokka på telefonen stemmer, og prøv igjen.'
            : 'Feil reservekode.',
      )
      return
    }
    await enter()
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    setError(null)
    const { data, error } = await authClient.signIn.email({
      email: String(form.get('email')),
      password: String(form.get('password')),
    })
    if (error) {
      setPending(false)
      setError(
        error.status === 403
          ? 'Du må bekrefte e-postadressen din før du kan logge inn. Sjekk innboksen.'
          : 'Feil e-post eller passord.',
      )
      return
    }
    if (data && 'twoFactorRedirect' in data && data.twoFactorRedirect) {
      setPending(false)
      setStep('code')
      return
    }
    await enter()
  }

  if (step !== 'password') {
    return (
      <AuthShell>
        <AuthCard
          title="Tofaktor"
          subtitle={
            step === 'code'
              ? 'Skriv inn koden fra autentiseringsappen din.'
              : 'Skriv inn en av reservekodene du lagret. Hver kode virker én gang.'
          }
        >
          <form onSubmit={onCode} className="space-y-4" key={step}>
            <Field label={step === 'code' ? 'Kode' : 'Reservekode'}>
              <Input
                name="code"
                inputMode={step === 'code' ? 'numeric' : 'text'}
                autoComplete="one-time-code"
                required
                autoFocus
                className="font-mono tracking-widest"
              />
            </Field>
            {error && <ErrorText>{error}</ErrorText>}
            <Button type="submit" variant="primary" size="lg" className="w-full" disabled={pending}>
              {pending ? 'Sjekker …' : 'Logg inn'}
            </Button>
            <button
              type="button"
              onClick={() => {
                setError(null)
                setStep(step === 'code' ? 'backup' : 'code')
              }}
              className="w-full text-center text-sm text-stone-500 hover:text-stone-900"
            >
              {step === 'code'
                ? 'Har du ikke telefonen? Bruk en reservekode'
                : 'Bruk koden fra appen'}
            </button>
          </form>
        </AuthCard>
      </AuthShell>
    )
  }

  return (
    <AuthShell
      action={
        <Link to="/registrer" className="text-sm font-medium text-stone-600 hover:text-stone-950">
          Be om tilgang
        </Link>
      }
    >
      <AuthCard
        title="Logg inn"
        subtitle="Velkommen tilbake til ES-nettverket."
        footer={
          <>
            Ikke medlem ennå?{' '}
            <Link to="/registrer" className="font-medium text-brand-600 hover:underline">
              Be om tilgang
            </Link>
          </>
        }
      >
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="E-post">
            <Input name="email" type="email" autoComplete="email" required autoFocus />
          </Field>
          <Field label="Passord">
            <Input name="password" type="password" autoComplete="current-password" required />
          </Field>
          {error && <ErrorText>{error}</ErrorText>}
          <Button type="submit" variant="primary" size="lg" className="w-full" disabled={pending}>
            {pending ? 'Logger inn …' : 'Logg inn'}
          </Button>
        </form>
      </AuthCard>
    </AuthShell>
  )
}
