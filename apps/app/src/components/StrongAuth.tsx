import { Link, useNavigate, useRouteContext, useRouter } from '@tanstack/react-router'
import { KeyRound, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { passkeySignInError, signInWithPasskey } from '#/lib/passkey.ts'
import { roleNames } from '#/lib/roles.ts'
import { Button, buttonClass, cx, ErrorText } from './ui.tsx'

/**
 * Logger inn på nytt med passkey, så økten blir sterk nok til adminverktøyene.
 * Uten `then` blir man på siden, som lastes på nytt med verktøyene synlige.
 */
export function PasskeySignInButton({ then }: { then?: '/admin' }) {
  const router = useRouter()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function signIn() {
    setBusy(true)
    setError(null)
    const failure = await signInWithPasskey()
    if (failure) {
      setBusy(false)
      return setError(passkeySignInError(failure))
    }
    await router.invalidate()
    if (then) await navigate({ to: then })
    setBusy(false)
  }

  return (
    <div className="space-y-2">
      <Button variant="brand" size="sm" onClick={signIn} disabled={busy}>
        <KeyRound className="size-4" aria-hidden />{' '}
        {busy ? 'Venter på passkey …' : 'Logg inn med passkey'}
      </Button>
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  )
}

/**
 * Den gule boksen der adminverktøy ellers ville stått, for admins som ikke er
 * sterkt innlogget. Verktøyene skjules aldri i stillhet: boksen sier hva som
 * mangler og gir knappen. Har kontoen passkey, holder det å logge inn med den
 * her; ellers går man til «Konto og sikkerhet» og setter opp passkey eller
 * tofaktor. Vises bare når rollen krever sterk innlogging og økten ikke er det.
 */
export function StrongAuthCallout({
  children,
  className,
}: {
  /** Hva verktøyene her gjør: «legge inn arrangementer og historikk». */
  children: string
  className?: string
}) {
  const { viewer } = useRouteContext({ from: '/_konto' })
  if (!viewer.strongAuthMissing) return null
  const title = viewer.role ? roleNames[viewer.role] : 'admin'
  return (
    <div
      role="note"
      className={cx(
        'flex gap-3 rounded-2xl bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset',
        className,
      )}
    >
      <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 space-y-3">
        {viewer.hasPasskey ? (
          <>
            <p>
              Logg inn med passkey for å {children}. Som {title} holder ikke passordet alene, så
              adminverktøyene er skjult.
            </p>
            <PasskeySignInButton />
          </>
        ) : (
          <>
            <p>
              Som {title} må du logge inn med passkey eller ha tofaktor for å {children}. Det tar et
              minutt å sette opp.
            </p>
            <Link
              to="/konto"
              search={{ krav: 'sterk-innlogging' }}
              className={buttonClass({ variant: 'brand', size: 'sm' })}
            >
              Sett opp passkey eller tofaktor
            </Link>
          </>
        )}
      </div>
    </div>
  )
}
