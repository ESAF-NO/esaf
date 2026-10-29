import type { InvitationDetails } from '@esaf/core'
import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { ArrowRight, KeyRound, Link2Off, LockKeyhole, UserRound } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { AuthCard, AuthShell } from '#/components/AuthLayout.tsx'
import { Avatar, Button, buttonClass, cx, ErrorText, Field, Input } from '#/components/ui.tsx'
import { authClient } from '#/lib/auth-client.ts'
import { longDay } from '#/lib/format.ts'
import {
  acceptInvitationSignedIn,
  fetchLinkDetails,
  setFirstPassword,
} from '#/lib/invitations.functions.ts'
import { linkError, noReferrer } from '#/lib/links.ts'
import { passkeyManageError, usePasskeySupport } from '#/lib/passkey.ts'
import { roleNames } from '#/lib/roles.ts'

/**
 * Invitasjonen en admin har delt. Tokenet i adressen er hemmeligheten, så siden
 * sender aldri adressen videre (`Referrer-Policy: no-referrer`), caches ikke, og
 * tokenet sendes bare i innholdet av POST-forespørsler.
 */
export const Route = createFileRoute('/invitasjon/$token')({
  loader: ({ params }) => fetchLinkDetails({ data: { token: params.token, kind: 'invite' } }),
  // Ikke last inn igjen i bakgrunnen; siden oppdateres eksplisitt etter hvert steg.
  staleTime: Infinity,
  headers: () => noReferrer.headers,
  head: () => ({ meta: [{ title: 'Invitasjon – ESAF' }, noReferrer.meta] }),
  component: Invitation,
})

type Details = Extract<InvitationDetails, { status: 'pending' }>

function Invitation() {
  const details = Route.useLoaderData()
  const { viewer } = Route.useRouteContext()

  if (details.status !== 'pending') return <LinkProblem status={details.status} />
  if (viewer.level !== 'anonymous') {
    return viewer.email?.toLowerCase() === details.email ? (
      <AcceptSignedIn details={details} />
    ) : (
      <WrongAccount details={details} email={viewer.email} />
    )
  }
  if (details.account === 'verified') return <SignInFirst details={details} />
  return <CreateAccount details={details} />
}

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

/** Hvem som inviterte, og eventuelt rollen. */
function Invited({ details }: { details: Details }) {
  const who = details.invitedBy ?? 'Styret i ESAF'
  return (
    <>
      {who} har invitert deg til ESAF-appen
      {details.role !== 'member' && <> som {roleNames[details.role]}</>}. Invitasjonen gjelder{' '}
      <strong className="text-stone-900">{details.email}</strong> og varer til{' '}
      {longDay(details.expiresAt)}.
    </>
  )
}

function LinkProblem({ status }: { status: 'invalid' | 'used' | 'expired' | 'revoked' }) {
  const text = {
    invalid: {
      title: 'Lenken virker ikke',
      body: 'Sjekk at du har fått med hele lenken. Virker den fortsatt ikke, be den som inviterte deg om en ny.',
    },
    used: {
      title: 'Invitasjonen er allerede brukt',
      body: 'Har du tatt den i bruk selv, logger du bare inn. Hvis ikke, si fra til styret med en gang.',
    },
    expired: {
      title: 'Invitasjonen er utløpt',
      body: 'En invitasjon varer i sju dager. Be den som inviterte deg om en ny.',
    },
    revoked: {
      title: 'Invitasjonen er trukket tilbake',
      body: 'Den er erstattet av en nyere invitasjon eller trukket tilbake av styret. Bruk den nyeste lenken du har fått, eller be om en ny.',
    },
  }[status]
  return (
    <Shell>
      <AuthCard title={text.title} subtitle={text.body}>
        <div className="flex items-center gap-4 rounded-2xl bg-stone-50 p-4 ring-1 ring-stone-200/70 ring-inset">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-stone-100 text-stone-500 ring-1 ring-stone-200 ring-inset">
            <Link2Off className="size-5" aria-hidden />
          </span>
          <Link to="/logg-inn" className={buttonClass({ variant: 'secondary' })}>
            Til innlogging
          </Link>
        </div>
      </AuthCard>
    </Shell>
  )
}

/** Innlogget med adressen invitasjonen gjelder: ett klikk, så er kontoen godkjent. */
function AcceptSignedIn({ details }: { details: Details }) {
  const router = useRouter()
  const { token } = Route.useParams()
  const accept = useServerFn(acceptInvitationSignedIn)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onAccept() {
    setBusy(true)
    setError(null)
    try {
      await accept({ data: { token } })
      await router.invalidate()
      await router.navigate({ to: '/feed' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke ta imot invitasjonen.')
      setBusy(false)
    }
  }

  return (
    <AuthShell>
      <AuthCard
        eyebrow="Invitasjon"
        title="Ta imot invitasjonen"
        subtitle={<Invited details={details} />}
      >
        {details.profile && <ProfileBox profile={details.profile} />}
        {error && <ErrorText>{error}</ErrorText>}
        <Button
          variant="brand"
          size="lg"
          className="mt-4 w-full"
          onClick={onAccept}
          disabled={busy}
        >
          {busy ? 'Godkjenner …' : 'Ta imot invitasjonen'}
          {!busy && <ArrowRight className="size-4" aria-hidden />}
        </Button>
      </AuthCard>
    </AuthShell>
  )
}

function WrongAccount({ details, email }: { details: Details; email: string | null }) {
  const router = useRouter()
  async function signOut() {
    await authClient.signOut()
    await router.invalidate()
  }
  return (
    <AuthShell>
      <AuthCard
        eyebrow="Invitasjon"
        title="Du er logget inn med en annen konto"
        subtitle={
          <>
            Du er logget inn som <strong className="text-stone-900">{email ?? 'en annen'}</strong>,
            men invitasjonen gjelder <strong className="text-stone-900">{details.email}</strong>.
            Logg ut for å ta den imot.
          </>
        }
      >
        <Button variant="primary" size="lg" className="w-full" onClick={signOut}>
          Logg ut
        </Button>
      </AuthCard>
    </AuthShell>
  )
}

function SignInFirst({ details }: { details: Details }) {
  const { token } = Route.useParams()
  return (
    <Shell>
      <AuthCard
        eyebrow="Invitasjon"
        title="Du har allerede en konto"
        subtitle={
          <>
            <Invited details={details} /> Det finnes allerede en konto med denne adressen. Logg inn,
            så kommer du tilbake hit og kan ta imot invitasjonen.
          </>
        }
        footer="Glemt passordet? Be den som inviterte deg om en lenke for nytt passord."
      >
        <Link
          to="/logg-inn"
          search={{ til: `/invitasjon/${token}` }}
          className={buttonClass({ variant: 'brand', size: 'lg' }, 'w-full')}
        >
          Logg inn <ArrowRight className="size-4" aria-hidden />
        </Link>
      </AuthCard>
    </Shell>
  )
}

function ProfileBox({ profile }: { profile: NonNullable<Details['profile']> }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-stone-50 p-4 ring-1 ring-stone-200/70 ring-inset">
      <Avatar name={profile.fullName} size="sm" />
      <div className="min-w-0 text-sm">
        <p className="font-medium text-stone-950">{profile.fullName}</p>
        <p className="text-stone-500">
          {profile.years.length ? `ES ${profile.years.join(', ')} · ` : ''}Profilen din i ESAF. Du
          kan rette den etterpå.
        </p>
      </div>
    </div>
  )
}

type Method = 'password' | 'passkey'

/** Ny konto: navn (uten profil), og passord eller passkey. */
function CreateAccount({ details }: { details: Details }) {
  const router = useRouter()
  const { token } = Route.useParams()
  const passkeys = usePasskeySupport() === true
  const [method, setMethod] = useState<Method>('password')
  const [step, setStep] = useState<'form' | 'passkey-failed'>('form')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function enter() {
    // Rutevaktene sender nye medlemmer til velkomststegene (/kom-i-gang).
    await router.invalidate()
    await router.navigate({ to: '/feed' })
  }

  async function addPasskey() {
    const { error } = await authClient.passkey.addPasskey()
    if (!error) return enter()
    setBusy(false)
    setStep('passkey-failed')
    setError(
      passkeyManageError(error, 'Passkeyen ble ikke lagret.') ??
        'Du avbrøt. Prøv igjen, eller velg et passord.',
    )
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const password = String(form.get('password') ?? '')
    if (method === 'password' && password !== String(form.get('repeat'))) {
      return setError('Passordene er ikke like.')
    }
    setBusy(true)
    setError(null)
    const { error } = await authClient.$fetch('/invitation/accept', {
      method: 'POST',
      body: {
        token,
        ...(method === 'password' && { password }),
        ...(!details.profile && { fullName: String(form.get('fullName') ?? '') }),
      },
    })
    if (error) {
      setBusy(false)
      return setError(linkError(error))
    }
    if (method === 'passkey') return addPasskey()
    await enter()
  }

  if (step === 'passkey-failed') {
    return (
      <Shell>
        <AuthCard
          eyebrow="Nesten ferdig"
          title="Legg til innloggingen din"
          subtitle="Kontoen er laget, og du er logget inn. Før du går videre, trenger den en passkey eller et passord, så du kommer inn igjen senere."
        >
          {error && <ErrorText>{error}</ErrorText>}
          <Button
            variant="brand"
            size="lg"
            className="mt-4 w-full"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              setError(null)
              void addPasskey()
            }}
          >
            <KeyRound className="size-4" aria-hidden /> Prøv passkey igjen
          </Button>
          <div className="my-5 flex items-center gap-3 text-xs text-stone-400">
            <span className="h-px flex-1 bg-stone-200" />
            eller
            <span className="h-px flex-1 bg-stone-200" />
          </div>
          <FirstPassword onDone={enter} />
        </AuthCard>
      </Shell>
    )
  }

  return (
    <Shell>
      <AuthCard
        eyebrow="Invitasjon"
        title="Velkommen til ESAF"
        subtitle={<Invited details={details} />}
      >
        <form onSubmit={onSubmit} className="space-y-5">
          {details.profile ? (
            <ProfileBox profile={details.profile} />
          ) : (
            <Field label="Fullt navn" hint="Slik andre ES-ere ser deg i appen.">
              <Input
                name="fullName"
                autoComplete="name"
                minLength={2}
                maxLength={120}
                required
                autoFocus
              />
            </Field>
          )}
          {/* Til passordhåndtereren, så den lagrer passordet på riktig adresse. */}
          <input
            type="email"
            name="email"
            value={details.email}
            autoComplete="username"
            readOnly
            hidden
          />

          {passkeys && (
            <fieldset>
              <legend className="text-sm font-medium text-stone-800">Slik logger du inn</legend>
              <div className="mt-1.5 grid grid-cols-2 gap-2" role="radiogroup">
                <MethodOption
                  selected={method === 'password'}
                  onSelect={() => setMethod('password')}
                  icon={<LockKeyhole className="size-4" aria-hidden />}
                  title="Passord"
                  text="Minst 12 tegn"
                />
                <MethodOption
                  selected={method === 'passkey'}
                  onSelect={() => setMethod('passkey')}
                  icon={<KeyRound className="size-4" aria-hidden />}
                  title="Passkey"
                  text="Ansikt, fingeravtrykk eller PIN"
                />
              </div>
            </fieldset>
          )}

          {method === 'password' ? (
            <div className="space-y-4">
              <Field label="Passord" hint="Minst 12 tegn.">
                <Input
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  required
                />
              </Field>
              <Field label="Gjenta passordet">
                <Input
                  name="repeat"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  required
                />
              </Field>
            </div>
          ) : (
            <p className="rounded-xl bg-stone-50 px-3 py-2.5 text-sm text-stone-600 ring-1 ring-stone-200/70 ring-inset">
              Passkeyen lagres i passordhåndtereren din eller på enheten. Du logger inn med ansikt,
              fingeravtrykk eller PIN, uten passord.
            </p>
          )}

          {error && <ErrorText>{error}</ErrorText>}
          <Button type="submit" variant="brand" size="lg" className="w-full" disabled={busy}>
            {busy ? 'Lager kontoen …' : 'Bli med'}
            {!busy && <ArrowRight className="size-4" aria-hidden />}
          </Button>
        </form>
      </AuthCard>
    </Shell>
  )
}

function MethodOption({
  selected,
  onSelect,
  icon,
  title,
  text,
}: {
  selected: boolean
  onSelect: () => void
  icon: ReactNode
  title: string
  text: string
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cx(
        'flex flex-col items-start gap-1 rounded-xl px-3 py-2.5 text-left ring-1 transition ring-inset',
        selected ? 'bg-white ring-brand-500' : 'ring-stone-200 hover:bg-stone-50',
      )}
    >
      <span className="flex items-center gap-1.5 text-sm font-medium text-stone-950">
        {icon}
        {title}
      </span>
      <span className="text-xs text-stone-500">{text}</span>
    </button>
  )
}

/** Passord i stedet for passkey, for den som nettopp har fått konto uten noen av dem. */
function FirstPassword({ onDone }: { onDone: () => Promise<void> }) {
  const save = useServerFn(setFirstPassword)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const password = String(form.get('password'))
    if (password !== String(form.get('repeat'))) return setError('Passordene er ikke like.')
    setBusy(true)
    setError(null)
    try {
      await save({ data: { password } })
      await onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke sette passordet.')
      setBusy(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field label="Passord" hint="Minst 12 tegn.">
        <Input
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
        />
      </Field>
      <Field label="Gjenta passordet">
        <Input name="repeat" type="password" autoComplete="new-password" minLength={12} required />
      </Field>
      {error && <ErrorText>{error}</ErrorText>}
      <Button type="submit" variant="secondary" size="lg" className="w-full" disabled={busy}>
        <UserRound className="size-4" aria-hidden /> Bruk passord
      </Button>
    </form>
  )
}
