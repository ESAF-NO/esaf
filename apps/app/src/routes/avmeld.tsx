import { createFileRoute, Link } from '@tanstack/react-router'
import { BellOff, Check } from 'lucide-react'
import { useState } from 'react'
import { z } from 'zod'
import { AuthCard, AuthShell } from '#/components/AuthLayout.tsx'
import { Button, ErrorText } from '#/components/ui.tsx'
import { confirmUnsubscribe, fetchUnsubscribe } from '#/lib/notifications.functions.ts'

/**
 * Lenken «Slutt å få … på e-post» fra varsel-e-postene. Virker uten innlogging,
 * med den signerte lenken. Siden sier hva som slås av, og gjør det først når
 * man trykker, så lenkesjekkere i e-postprogrammer ikke melder noen av.
 */
export const Route = createFileRoute('/avmeld')({
  validateSearch: z.object({ t: z.string().max(500).optional().catch(undefined) }),
  loaderDeps: ({ search }) => ({ token: search.t ?? '' }),
  loader: ({ deps }) => (deps.token ? fetchUnsubscribe({ data: { token: deps.token } }) : null),
  head: () => ({
    meta: [{ title: 'Varsler på e-post – ESAF' }, { name: 'robots', content: 'noindex' }],
  }),
  component: Unsubscribe,
})

function Unsubscribe() {
  const target = Route.useLoaderData()
  const { t } = Route.useSearch()
  const { viewer } = Route.useRouteContext()
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle')
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    setState('busy')
    setError(null)
    try {
      await confirmUnsubscribe({ data: { token: t ?? '' } })
      setState('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke lagre.')
      setState('idle')
    }
  }

  const settings = (
    <Link
      to={viewer.level === 'anonymous' ? '/logg-inn' : '/konto'}
      hash="varsler"
      className="font-medium text-brand-700 hover:text-brand-800"
    >
      {viewer.level === 'anonymous'
        ? 'Logg inn for å velge hvilke varsler du vil ha'
        : 'Velg hvilke varsler du vil ha'}
    </Link>
  )

  if (!target) {
    return (
      <AuthShell>
        <AuthCard title="Lenken virker ikke" subtitle="Den kan være kopiert feil.">
          <p className="text-sm text-stone-600">
            Du kan endre varslene dine under Konto og sikkerhet. {settings}.
          </p>
        </AuthCard>
      </AuthShell>
    )
  }

  return (
    <AuthShell>
      {state === 'done' ? (
        <AuthCard
          eyebrow={<Check className="size-5 text-emerald-600" aria-hidden />}
          title="Du er meldt av"
          subtitle={`Du får ikke lenger ${target.label.toLocaleLowerCase('nb')} på e-post. Varslene står fortsatt i appen.`}
        >
          <p className="text-sm text-stone-600">{settings}.</p>
        </AuthCard>
      ) : (
        <AuthCard
          eyebrow={<BellOff className="size-5 text-stone-500" aria-hidden />}
          title="Slutte å få e-post?"
          subtitle={`Du slutter å få ${target.label.toLocaleLowerCase('nb')} på e-post. Varslene står fortsatt i appen, og du kan slå det på igjen når du vil.`}
        >
          <div className="space-y-4">
            <Button
              variant="brand"
              className="w-full"
              onClick={confirm}
              disabled={state === 'busy'}
            >
              {state === 'busy' ? 'Lagrer …' : 'Slutt å sende'}
            </Button>
            {error && <ErrorText>{error}</ErrorText>}
            <p className="text-center text-sm text-stone-600">{settings}</p>
          </div>
        </AuthCard>
      )}
    </AuthShell>
  )
}
