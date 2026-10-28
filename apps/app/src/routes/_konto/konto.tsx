import { createFileRoute, useRouter } from '@tanstack/react-router'
import { Check, Copy, ShieldAlert, ShieldCheck } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { z } from 'zod'
import { QrCode } from '#/components/QrCode.tsx'
import { Button, Card, ErrorText, Field, Input, PageHeader } from '#/components/ui.tsx'
import { authClient } from '#/lib/auth-client.ts'

export const Route = createFileRoute('/_konto/konto')({
  validateSearch: z.object({ krav: z.enum(['tofaktor']).optional().catch(undefined) }),
  head: () => ({ meta: [{ title: 'Konto og sikkerhet – ESAF' }] }),
  component: Account,
})

const roleNames = {
  member: 'medlem',
  moderator: 'moderator',
  admin: 'admin',
  owner: 'hovedadmin',
} as const

function Section({
  title,
  description,
  children,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <Card className="grid gap-6 p-5 sm:p-6 md:grid-cols-[220px_minmax(0,1fr)]">
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

/** Feilmeldinger fra Better Auth på norsk, uten tekniske detaljer. */
function message(error: { code?: string; message?: string } | null, fallback: string) {
  if (!error) return fallback
  if (error.code === 'INVALID_PASSWORD') return 'Feil passord.'
  if (error.code === 'INVALID_CODE' || error.code === 'INVALID_TWO_FACTOR_CODE') {
    return 'Feil kode. Sjekk at klokka på telefonen stemmer, og prøv igjen.'
  }
  if (error.code === 'SESSION_NOT_FRESH') return 'Logg ut og inn igjen før du endrer dette.'
  return fallback
}

function Account() {
  const { viewer } = Route.useRouteContext()
  const { krav } = Route.useSearch()
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Konto og sikkerhet"
        description={
          <>
            Logget inn som {viewer.email}
            {viewer.role && viewer.role !== 'member' && ` · ${roleNames[viewer.role]}`}
          </>
        }
      />
      {krav === 'tofaktor' && viewer.twoFactorMissing && (
        <div className="mb-4 flex gap-3 rounded-2xl bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>
            Som {viewer.role ? roleNames[viewer.role] : 'admin'} må du ha tofaktor for å bruke
            adminverktøyene. Det tar et minutt å slå på.
          </p>
        </div>
      )}
      <div className="space-y-4">
        <TwoFactor enabled={viewer.twoFactorEnabled} required={viewer.twoFactorMissing} />
        <ChangePassword />
        <Sessions />
      </div>
    </div>
  )
}

function TwoFactor({ enabled, required }: { enabled: boolean; required: boolean }) {
  const router = useRouter()
  const [step, setStep] = useState<'idle' | 'password' | 'scan' | 'codes' | 'disable' | 'renew'>(
    'idle',
  )
  const [setup, setSetup] = useState<{ uri: string; codes: string[] } | null>(null)
  const [codes, setCodes] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }

  const password = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    return String(new FormData(e.currentTarget).get('password'))
  }

  function start(e: FormEvent<HTMLFormElement>) {
    const pw = password(e)
    void run(async () => {
      const { data, error } = await authClient.twoFactor.enable({ password: pw })
      if (error || !data || !('totpURI' in data) || !data.totpURI) {
        return setError(message(error, 'Kunne ikke starte oppsettet.'))
      }
      setSetup({ uri: data.totpURI, codes: data.backupCodes ?? [] })
      setStep('scan')
    })
  }

  function confirm(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const code = String(new FormData(e.currentTarget).get('code')).replace(/\s/g, '')
    void run(async () => {
      const { error } = await authClient.twoFactor.verifyTotp({ code })
      if (error) return setError(message(error, 'Kunne ikke bekrefte koden.'))
      setCodes(setup?.codes ?? [])
      setStep('codes')
    })
  }

  function disable(e: FormEvent<HTMLFormElement>) {
    const pw = password(e)
    void run(async () => {
      const { error } = await authClient.twoFactor.disable({ password: pw })
      if (error) return setError(message(error, 'Kunne ikke slå av tofaktor.'))
      setStep('idle')
      await router.invalidate()
    })
  }

  function renew(e: FormEvent<HTMLFormElement>) {
    const pw = password(e)
    void run(async () => {
      const { data, error } = await authClient.twoFactor.generateBackupCodes({ password: pw })
      if (error || !data) return setError(message(error, 'Kunne ikke lage nye koder.'))
      setCodes(data.backupCodes)
      setStep('codes')
    })
  }

  const secret = setup ? new URL(setup.uri).searchParams.get('secret') : null

  return (
    <Section
      title="Tofaktor"
      description="En kode fra en autentiseringsapp i tillegg til passordet. Påkrevd for admins."
    >
      {step === 'codes' ? (
        <BackupCodes
          codes={codes}
          onDone={async () => {
            setStep('idle')
            setSetup(null)
            await router.invalidate()
          }}
        />
      ) : step === 'scan' && setup ? (
        <form onSubmit={confirm} className="space-y-4">
          <p className="text-sm text-stone-600">
            Skann koden med autentiseringsappen din (for eksempel 1Password, Google Authenticator
            eller Microsoft Authenticator), og skriv inn koden appen viser.
          </p>
          <div className="flex flex-wrap items-center gap-5">
            <QrCode value={setup.uri} />
            {secret && (
              <p className="max-w-56 text-xs text-stone-500">
                Kan du ikke skanne? Skriv inn denne nøkkelen i appen:
                <code className="mt-1 block font-mono text-sm break-all text-stone-900">
                  {secret}
                </code>
              </p>
            )}
          </div>
          <Field label="Kode fra appen">
            <Input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]{6,7}"
              required
              autoFocus
              className="max-w-40 font-mono tracking-widest"
            />
          </Field>
          {error && <ErrorText>{error}</ErrorText>}
          <div className="flex gap-2">
            <Button type="submit" variant="brand" disabled={busy}>
              Bekreft og slå på
            </Button>
            <Button variant="ghost" onClick={() => setStep('idle')}>
              Avbryt
            </Button>
          </div>
        </form>
      ) : step === 'password' || step === 'disable' || step === 'renew' ? (
        <form
          onSubmit={step === 'password' ? start : step === 'disable' ? disable : renew}
          className="space-y-4"
        >
          {step === 'disable' && required === false && enabled && (
            <p className="text-sm text-stone-600">
              Du trenger ikke tofaktor for rollen din, men det gjør kontoen tryggere.
            </p>
          )}
          <Field label="Bekreft med passordet ditt">
            <Input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              autoFocus
            />
          </Field>
          {error && <ErrorText>{error}</ErrorText>}
          <div className="flex gap-2">
            <Button
              type="submit"
              variant={step === 'disable' ? 'secondary' : 'brand'}
              disabled={busy}
            >
              {step === 'password'
                ? 'Fortsett'
                : step === 'disable'
                  ? 'Slå av tofaktor'
                  : 'Lag nye koder'}
            </Button>
            <Button variant="ghost" onClick={() => setStep('idle')}>
              Avbryt
            </Button>
          </div>
        </form>
      ) : enabled ? (
        <>
          <p className="flex items-center gap-2 text-sm font-medium text-emerald-700">
            <ShieldCheck className="size-4" aria-hidden /> Tofaktor er slått på
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => setStep('renew')}>
              Lag nye reservekoder
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setStep('disable')}>
              Slå av
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-stone-600">
            Tofaktor er ikke slått på.{' '}
            {required && 'Rollen din krever det for å bruke adminverktøyene.'}
          </p>
          <Button variant="brand" onClick={() => setStep('password')}>
            Slå på tofaktor
          </Button>
        </>
      )}
    </Section>
  )
}

function BackupCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="space-y-4">
      <p className="text-sm text-stone-600">
        Tofaktor er slått på. Ta vare på reservekodene: hver kan brukes én gang hvis du mister
        telefonen. Du får ikke se dem igjen.
      </p>
      <ul className="grid grid-cols-2 gap-2 rounded-xl bg-stone-50 p-4 font-mono text-sm text-stone-900 ring-1 ring-stone-200 ring-inset sm:grid-cols-3">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button
          variant="secondary"
          onClick={async () => {
            await navigator.clipboard.writeText(codes.join('\n'))
            setCopied(true)
          }}
        >
          {copied ? (
            <Check className="size-4" aria-hidden />
          ) : (
            <Copy className="size-4" aria-hidden />
          )}
          {copied ? 'Kopiert' : 'Kopier'}
        </Button>
        <Button variant="brand" onClick={onDone}>
          Jeg har tatt vare på dem
        </Button>
      </div>
    </div>
  )
}

function ChangePassword() {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle')
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const next = String(form.get('next'))
    if (next !== String(form.get('repeat'))) return setError('De nye passordene er ikke like.')
    setState('busy')
    setError(null)
    const { error } = await authClient.changePassword({
      currentPassword: String(form.get('current')),
      newPassword: next,
      revokeOtherSessions: true,
    })
    if (error) {
      setState('idle')
      return setError(
        error.code === 'PASSWORD_TOO_SHORT'
          ? 'Det nye passordet må ha minst 12 tegn.'
          : message(error, 'Kunne ikke bytte passord.'),
      )
    }
    e.currentTarget.reset()
    setState('done')
  }

  return (
    <Section title="Passord" description="Andre enheter logges ut når du bytter passord.">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Nåværende passord">
          <Input name="current" type="password" autoComplete="current-password" required />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nytt passord" hint="Minst 12 tegn.">
            <Input
              name="next"
              type="password"
              autoComplete="new-password"
              minLength={12}
              required
            />
          </Field>
          <Field label="Gjenta nytt passord">
            <Input
              name="repeat"
              type="password"
              autoComplete="new-password"
              minLength={12}
              required
            />
          </Field>
        </div>
        {error && <ErrorText>{error}</ErrorText>}
        <div className="flex items-center gap-3">
          <Button type="submit" variant="secondary" disabled={state === 'busy'}>
            Bytt passord
          </Button>
          {state === 'done' && (
            <span className="text-sm text-emerald-700">Passordet er byttet.</span>
          )}
        </div>
      </form>
    </Section>
  )
}

function Sessions() {
  const [done, setDone] = useState(false)
  return (
    <Section title="Innlogginger" description="Er du logget inn et sted du ikke lenger bruker?">
      <div className="flex items-center gap-3">
        <Button
          variant="secondary"
          onClick={async () => {
            await authClient.revokeOtherSessions()
            setDone(true)
          }}
        >
          Logg ut av alle andre enheter
        </Button>
        {done && <span className="text-sm text-emerald-700">Ferdig.</span>}
      </div>
    </Section>
  )
}
