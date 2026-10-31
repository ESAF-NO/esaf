import { createFileRoute, Link } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { Bot, Check, Eye, KeyRound, Pencil, ShieldCheck, TriangleAlert } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { z } from 'zod'
import { AuthCard, AuthShell } from '#/components/AuthLayout.tsx'
import { Button, ErrorText, Switch } from '#/components/ui.tsx'
import { describeMcpConsent, decideMcpConsent } from '#/lib/mcp-oauth.functions.ts'
import { noReferrer } from '#/lib/links.ts'
import { passkeySignInError, signInWithPasskey, usePasskeySupport } from '#/lib/passkey.ts'

/**
 * Godkjenningen når en MCP-klient (Claude, ChatGPT, Codex) kobler til
 * adminverktøyene med OAuth. OAuth-serveren sender hit via
 * `/api/mcp-oauth/godkjenn` med forespørselen signert (`q`). Bare admins i en
 * sterk økt kan godkjenne; serveren sjekker det igjen når svaret sendes.
 */
export const Route = createFileRoute('/mcp/godkjenn')({
  validateSearch: z.object({ q: z.coerce.string().catch('') }),
  loaderDeps: ({ search }) => ({ q: search.q }),
  loader: ({ deps }) =>
    deps.q ? describeMcpConsent({ data: { q: deps.q } }) : { state: 'expired' as const },
  // Adressen inneholder forespørselen fra klienten, så den sendes ikke videre.
  headers: () => noReferrer.headers,
  head: () => ({ meta: [{ title: 'Koble til MCP-klient – ESAF' }, noReferrer.meta] }),
  component: Consent,
})

function Consent() {
  const request = Route.useLoaderData()
  const { viewer } = Route.useRouteContext()
  const { q } = Route.useSearch()
  const decide = useServerFn(decideMcpConsent)
  const passkeys = usePasskeySupport() === true
  const [readOnly, setReadOnly] = useState(false)
  const [pending, setPending] = useState<'accept' | 'deny' | 'passkey' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function answer(accept: boolean) {
    setPending(accept ? 'accept' : 'deny')
    setError(null)
    const result = await decide({ data: { q, accept, readOnly } }).catch(() => ({
      error: 'Noe gikk galt. Prøv igjen.',
    }))
    if ('url' in result) {
      window.location.assign(result.url)
      return
    }
    setPending(null)
    setError(result.error)
  }

  async function strengthen() {
    setPending('passkey')
    setError(null)
    const failure = await signInWithPasskey()
    if (!failure) {
      // Ny, sterk økt: last siden på nytt, med samme forespørsel.
      window.location.reload()
      return
    }
    setPending(null)
    setError(passkeySignInError(failure))
  }

  if (viewer.level === 'anonymous') {
    const back = `/mcp/godkjenn?q=${encodeURIComponent(q)}`
    return (
      <Shell>
        <AuthCard
          title="Logg inn først"
          subtitle="Du må være logget inn for å koble til en MCP-klient."
        >
          <Link
            to="/logg-inn"
            search={{ til: back }}
            className="inline-flex w-full items-center justify-center rounded-xl bg-stone-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-stone-800"
          >
            Logg inn
          </Link>
        </AuthCard>
      </Shell>
    )
  }

  if (request.state === 'expired' || request.state === 'unknown_client') {
    return (
      <Shell>
        <AuthCard
          eyebrow="Koble til MCP-klient"
          title={request.state === 'expired' ? 'Forespørselen er utløpt' : 'Fant ikke klienten'}
          subtitle={
            request.state === 'expired'
              ? 'Tilkoblingen må fullføres innen ti minutter. Start den på nytt fra Claude, ChatGPT eller programmet du brukte.'
              : 'Klienten er ikke registrert hos ESAF lenger. Start tilkoblingen på nytt fra programmet du brukte.'
          }
        >
          <Link to="/admin/mcp" className="text-sm font-medium text-brand-600 hover:underline">
            Slik kobler du til
          </Link>
        </AuthCard>
      </Shell>
    )
  }

  const name = request.client.name ?? 'En MCP-klient'
  const signedInAs = (
    <>
      Du er logget inn som{' '}
      <strong className="font-medium text-stone-800">{viewer.fullName ?? viewer.email}</strong>.
    </>
  )

  if (request.state === 'forbidden') {
    return (
      <Shell>
        <AuthCard eyebrow="Koble til MCP-klient" title="Bare for admins" subtitle={signedInAs}>
          <p className="text-sm leading-relaxed text-stone-600">
            «{name}» vil bruke adminverktøyene i ESAF. Det kan bare admins gi tilgang til.
          </p>
          {error && <ErrorText>{error}</ErrorText>}
          <Button
            variant="secondary"
            size="lg"
            className="mt-6 w-full"
            onClick={() => answer(false)}
            disabled={pending !== null}
          >
            {pending === 'deny' ? 'Avbryter …' : 'Tilbake til klienten'}
          </Button>
        </AuthCard>
      </Shell>
    )
  }

  if (request.state === 'strong_auth_required') {
    return (
      <Shell>
        <AuthCard
          eyebrow="Koble til MCP-klient"
          title="Bekreft at det er deg"
          subtitle={signedInAs}
        >
          <p className="text-sm leading-relaxed text-stone-600">
            For å gi «{name}» tilgang til adminverktøyene må du være logget inn med passkey, eller
            ha tofaktor på kontoen.
          </p>
          {error && <ErrorText>{error}</ErrorText>}
          <div className="mt-6 space-y-3">
            {viewer.hasPasskey && passkeys ? (
              <Button
                variant="primary"
                size="lg"
                className="w-full"
                onClick={strengthen}
                disabled={pending !== null}
              >
                <KeyRound className="size-4" aria-hidden />
                {pending === 'passkey' ? 'Venter på passkey …' : 'Logg inn med passkey'}
              </Button>
            ) : (
              <Link
                to="/konto"
                search={{ krav: 'sterk-innlogging' }}
                className="inline-flex w-full items-center justify-center rounded-xl bg-stone-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-stone-800"
              >
                Legg til passkey eller tofaktor
              </Link>
            )}
            <Button
              variant="secondary"
              size="lg"
              className="w-full"
              onClick={() => answer(false)}
              disabled={pending !== null}
            >
              {pending === 'deny' ? 'Avbryter …' : 'Avbryt'}
            </Button>
          </div>
        </AuthCard>
      </Shell>
    )
  }

  const write = request.wantsWrite && !readOnly
  return (
    <Shell>
      <AuthCard
        eyebrow="Koble til MCP-klient"
        title={<>«{name}» vil bruke adminverktøyene i ESAF</>}
        subtitle={signedInAs}
      >
        <ul className="space-y-3 text-sm text-stone-700">
          <Item icon={Eye}>
            Lese alt adminsidene viser: personer, selskaper, kull, arrangementer, Gjennomgang og
            loggen.
          </Item>
          {write ? (
            <Item icon={Pencil}>
              Endre som deg: legge inn og rette profiler, selskaper og arrangementer, behandle
              forespørsler og invitasjoner. Alt merkes med «{name}» i loggen.
            </Item>
          ) : (
            <Item icon={Check}>
              Ingenting kan endres. Verktøyene som endrer, finnes ikke for den.
            </Item>
          )}
          <Item icon={ShieldCheck}>
            Aldri mer enn du har selv. Mister du adminrollen, mister den tilgangen. Du kan koble den
            fra når som helst under Admin → MCP.
          </Item>
        </ul>

        {request.wantsWrite && (
          <div className="mt-5">
            <Switch
              checked={readOnly}
              onChange={setReadOnly}
              label="Bare lesetilgang"
              description="Klienten kan lese, men ikke endre noe."
            />
          </div>
        )}

        <div className="mt-5 flex gap-2.5 rounded-xl bg-amber-50 px-3.5 py-3 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200 ring-inset">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>
            Godkjenn bare hvis du nettopp startet tilkoblingen selv. Navnet er det klienten oppgir.
            {request.client.redirectHosts.length > 0 && (
              <>
                {' '}
                Innloggingen sendes tilbake til{' '}
                <strong className="font-semibold">{request.client.redirectHosts.join(', ')}</strong>
                .
              </>
            )}
          </p>
        </div>

        {error && <ErrorText>{error}</ErrorText>}
        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row">
          <Button
            variant="secondary"
            size="lg"
            className="flex-1"
            onClick={() => answer(false)}
            disabled={pending !== null}
          >
            {pending === 'deny' ? 'Avbryter …' : 'Avbryt'}
          </Button>
          <Button
            variant="primary"
            size="lg"
            className="flex-1"
            onClick={() => answer(true)}
            disabled={pending !== null}
          >
            {pending === 'accept' ? 'Kobler til …' : 'Godkjenn'}
          </Button>
        </div>
      </AuthCard>
    </Shell>
  )
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <AuthShell
      action={
        <span className="inline-flex items-center gap-1.5 text-sm text-stone-500">
          <Bot className="size-4" aria-hidden /> MCP
        </span>
      }
    >
      {children}
    </AuthShell>
  )
}

function Item({ icon: Icon, children }: { icon: typeof Eye; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-stone-100 text-stone-600">
        <Icon className="size-3.5" aria-hidden />
      </span>
      <span className="leading-relaxed">{children}</span>
    </li>
  )
}
