import { createFileRoute, Link, redirect, useRouter } from '@tanstack/react-router'
import { KeyRound } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { z } from 'zod'
import { AuthCard, AuthShell } from '#/components/AuthLayout.tsx'
import { Button, ErrorText, Field, Input } from '#/components/ui.tsx'
import { authClient } from '#/lib/auth-client.ts'
import { fetchAuthOptions } from '#/lib/invitations.functions.ts'
import { noReferrer, safeRedirect } from '#/lib/links.ts'
import {
  passkeyAutofillSupported,
  passkeySignInError,
  signInWithPasskey,
  usePasskeySupport,
} from '#/lib/passkey.ts'

/** `til` kan peke på et endepunkt på serveren, som innloggingen for MCP-klienter. */
const isServerPath = (path: string) => path.startsWith('/api/')

export const Route = createFileRoute('/logg-inn')({
  // `til`: siden personen kom fra, for eksempel en invitasjon. Bare stier i appen godtas.
  validateSearch: z.object({ til: z.string().optional().transform(safeRedirect).catch(undefined) }),
  beforeLoad: ({ context, search }) => {
    if (context.viewer.level !== 'anonymous') {
      throw search.til
        ? redirect({ href: search.til, reloadDocument: isServerPath(search.til) })
        : redirect({ to: '/feed' })
    }
  },
  // Med e-post kan man be om en lenke for nytt passord selv; ellers spør man styret.
  loader: () => fetchAuthOptions(),
  // Adressen kan inneholde en invitasjon (`til`), så den sendes ikke videre.
  headers: () => noReferrer.headers,
  head: () => ({ meta: [{ title: 'Logg inn – ESAF' }, noReferrer.meta] }),
  component: SignIn,
})

function SignIn() {
  const { emailEnabled, selfSignUp } = Route.useLoaderData()
  const router = useRouter()
  const { til } = Route.useSearch()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [step, setStep] = useState<'password' | 'code' | 'backup'>('password')
  const passkeys = usePasskeySupport() === true
  // Økes for å starte forslaget i e-postfeltet på nytt etter et forsøk med knappen.
  const [autofillRound, setAutofillRound] = useState(0)

  async function enter() {
    // Rutevaktene sender den som ikke er godkjent ennå, til riktig steg.
    await router.invalidate()
    // Stier på serveren (som innloggingen for MCP-klienter) er ikke sider i appen.
    if (til && isServerPath(til)) window.location.assign(til)
    else if (til) await router.navigate({ href: til })
    else await router.navigate({ to: '/feed' })
  }

  // Betinget innlogging: nettleseren foreslår passkeys for ESAF i e-postfeltet.
  // Venter i bakgrunnen til personen velger en, eller til knappen under tar over.
  useEffect(() => {
    let current = true
    void (async () => {
      if (!(await passkeyAutofillSupported())) return
      const error = await signInWithPasskey({ autoFill: true })
      if (!current) return
      if (!error) return enter()
      const text = passkeySignInError(error)
      if (text) setError(text)
    })()
    return () => {
      current = false
    }
    // `enter` er stabil nok; forslaget skal bare startes på nytt når runden økes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autofillRound])

  async function onPasskey() {
    setPending(true)
    setError(null)
    const error = await signInWithPasskey()
    if (!error) return enter()
    setPending(false)
    setError(passkeySignInError(error))
    setAutofillRound((n) => n + 1)
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
          ? selfSignUp
            ? 'Du må bekrefte e-postadressen din før du kan logge inn. Vi har sendt deg en ny lenke; sjekk innboksen.'
            : 'Du må bekrefte e-postadressen din før du kan logge inn. Sjekk innboksen.'
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
            {/* `webauthn` lar nettleseren foreslå passkeys her. */}
            <Input name="email" type="email" autoComplete="email webauthn" required autoFocus />
          </Field>
          <Field
            label="Passord"
            hint={
              emailEnabled ? (
                <Link to="/glemt-passord" className="font-medium text-brand-600 hover:underline">
                  Glemt passordet?
                </Link>
              ) : (
                'Glemt passordet? Be en i styret om en lenke for å velge nytt.'
              )
            }
          >
            <Input name="password" type="password" autoComplete="current-password" required />
          </Field>
          {error && <ErrorText>{error}</ErrorText>}
          <Button type="submit" variant="primary" size="lg" className="w-full" disabled={pending}>
            {pending ? 'Logger inn …' : 'Logg inn'}
          </Button>
        </form>
        {passkeys && (
          <>
            <div className="my-5 flex items-center gap-3 text-xs text-stone-400">
              <span className="h-px flex-1 bg-stone-200" />
              eller
              <span className="h-px flex-1 bg-stone-200" />
            </div>
            <Button
              variant="secondary"
              size="lg"
              className="w-full"
              onClick={onPasskey}
              disabled={pending}
            >
              <KeyRound className="size-4" aria-hidden /> Logg inn med passkey
            </Button>
          </>
        )}
      </AuthCard>
    </AuthShell>
  )
}
