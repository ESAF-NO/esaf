import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { CircleCheck, Link2Off } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { AuthCard, AuthShell } from '#/components/AuthLayout.tsx'
import { Button, buttonClass, ErrorText, Field, Input } from '#/components/ui.tsx'
import { authClient } from '#/lib/auth-client.ts'
import { timestamp } from '#/lib/format.ts'
import { fetchAuthOptions, fetchLinkDetails } from '#/lib/invitations.functions.ts'
import { linkError, noReferrer } from '#/lib/links.ts'

/**
 * Nytt passord med en lenke fra en admin, eller en personen ba om selv på
 * e-post. Som invitasjonen: tokenet i adressen sendes aldri videre, og bare i
 * innholdet av POST-forespørsler. Etterpå er alle økter logget ut, og personen
 * logger inn med det nye passordet (og tofaktor).
 */
export const Route = createFileRoute('/nytt-passord/$token')({
  loader: async ({ params }) => {
    const [details, { emailEnabled }] = await Promise.all([
      fetchLinkDetails({ data: { token: params.token, kind: 'password_reset' } }),
      fetchAuthOptions(),
    ])
    return { details, emailEnabled }
  },
  staleTime: Infinity,
  headers: () => noReferrer.headers,
  head: () => ({ meta: [{ title: 'Nytt passord – ESAF' }, noReferrer.meta] }),
  component: NewPassword,
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

function NewPassword() {
  const { details, emailEnabled } = Route.useLoaderData()
  const { token } = Route.useParams()
  const router = useRouter()
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle')
  const [error, setError] = useState<string | null>(null)

  if (state === 'done') {
    return (
      <Shell>
        <AuthCard
          title="Passordet er byttet"
          subtitle="Du er logget ut på alle enheter. Logg inn med det nye passordet."
        >
          <div className="flex items-center gap-4 rounded-2xl bg-emerald-50 p-4 ring-1 ring-emerald-200 ring-inset">
            <CircleCheck className="size-5 shrink-0 text-emerald-600" aria-hidden />
            <Link to="/logg-inn" className={buttonClass({ variant: 'primary' })}>
              Logg inn
            </Link>
          </div>
        </AuthCard>
      </Shell>
    )
  }

  if (details.status !== 'pending') {
    const text = {
      invalid: 'Sjekk at du har fått med hele lenken. Virker den fortsatt ikke, be om en ny.',
      used: 'Lenken er allerede brukt. Logg inn med passordet du valgte, eller be om en ny lenke.',
      expired: 'Lenken er utløpt. Be om en ny.',
      revoked:
        'Den er erstattet av en nyere lenke eller trukket tilbake. Be om en ny om du trenger det.',
    }[details.status]
    return (
      <Shell>
        <AuthCard title="Lenken virker ikke" subtitle={text}>
          <div className="flex items-center gap-4 rounded-2xl bg-stone-50 p-4 ring-1 ring-stone-200/70 ring-inset">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-stone-100 text-stone-500 ring-1 ring-stone-200 ring-inset">
              <Link2Off className="size-5" aria-hidden />
            </span>
            {emailEnabled && details.status !== 'used' ? (
              <Link to="/glemt-passord" className={buttonClass({ variant: 'secondary' })}>
                Be om en ny lenke
              </Link>
            ) : (
              <Link to="/logg-inn" className={buttonClass({ variant: 'secondary' })}>
                Til innlogging
              </Link>
            )}
          </div>
          {!emailEnabled && (
            <p className="mt-4 text-sm text-stone-500">
              En ny lenke får du av styret, på{' '}
              <a
                href="mailto:styret@esaf.no"
                className="font-medium text-brand-600 hover:underline"
              >
                styret@esaf.no
              </a>
              .
            </p>
          )}
        </AuthCard>
      </Shell>
    )
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const password = String(form.get('password'))
    if (password !== String(form.get('repeat'))) return setError('Passordene er ikke like.')
    setState('busy')
    setError(null)
    const { error } = await authClient.$fetch('/invitation/reset-password', {
      method: 'POST',
      body: { token, password },
    })
    if (error) {
      setState('idle')
      return setError(linkError(error))
    }
    setState('done')
    // Øktene er slettet; resten av appen skal se det.
    await router.invalidate()
  }

  return (
    <Shell>
      <AuthCard
        title="Velg nytt passord"
        subtitle={
          <>
            For <strong className="text-stone-900">{details.email}</strong>. Lenken virker én gang,
            til {timestamp(details.expiresAt)}. Du blir logget ut på alle enheter. Har du tofaktor,
            trenger du fortsatt koden når du logger inn.
          </>
        }
      >
        <form onSubmit={onSubmit} className="space-y-4">
          <input
            type="email"
            name="email"
            value={details.email}
            autoComplete="username"
            readOnly
            hidden
          />
          <Field label="Nytt passord" hint="Minst 12 tegn.">
            <Input
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              required
              autoFocus
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
          {error && <ErrorText>{error}</ErrorText>}
          <Button
            type="submit"
            variant="primary"
            size="lg"
            className="w-full"
            disabled={state === 'busy'}
          >
            {state === 'busy' ? 'Lagrer …' : 'Lagre nytt passord'}
          </Button>
        </form>
      </AuthCard>
    </Shell>
  )
}
