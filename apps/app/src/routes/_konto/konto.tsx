import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { Bot, Check, Copy, KeyRound, ShieldAlert, ShieldCheck } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { z } from 'zod'
import { Dialog, DialogActions } from '#/components/Dialog.tsx'
import { PasskeySignInButton } from '#/components/StrongAuth.tsx'
import { QrCode } from '#/components/QrCode.tsx'
import {
  Button,
  buttonClass,
  Card,
  ErrorText,
  Field,
  Input,
  PageHeader,
  Select,
  Switch,
} from '#/components/ui.tsx'
import { fetchApiTokens, newApiToken, removeApiToken } from '#/lib/api-tokens.functions.ts'
import { authClient } from '#/lib/auth-client.ts'
import { fetchSignInMethods, setFirstPassword } from '#/lib/invitations.functions.ts'
import { longDay, timeAgo } from '#/lib/format.ts'
import { passkeyManageError, usePasskeySupport } from '#/lib/passkey.ts'
import { needsStrongAuth, roleNames } from '#/lib/roles.ts'

export const Route = createFileRoute('/_konto/konto')({
  validateSearch: z.object({
    krav: z.enum(['sterk-innlogging']).optional().catch(undefined),
  }),
  // Kontoer fra en invitasjon kan ha bare passkey, uten passord. MCP-nøklene
  // hentes bare for admins som kan bruke dem nå (sterkt innlogget).
  loader: async ({ context: { viewer } }) => {
    const [methods, mcp] = await Promise.all([
      fetchSignInMethods(),
      viewer.permissions.includes('mcp.access') ? fetchApiTokens() : null,
    ])
    return { ...methods, mcp }
  },
  head: () => ({ meta: [{ title: 'Konto og sikkerhet – ESAF' }] }),
  component: Account,
})

function Section({
  id,
  title,
  description,
  children,
}: {
  id?: string
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <Card id={id} className="grid scroll-mt-6 gap-6 p-5 sm:p-6 md:grid-cols-[220px_minmax(0,1fr)]">
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
  if (error.code === 'STRONG_AUTH_REQUIRED') {
    return 'Logg inn med en av passkeyene dine før du endrer dette.'
  }
  return fallback
}

function Account() {
  const { viewer } = Route.useRouteContext()
  const { krav } = Route.useSearch()
  const { hasPassword } = Route.useLoaderData()
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
      {krav === 'sterk-innlogging' && viewer.strongAuthMissing && (
        <StrongAuthNotice role={viewer.role} hasPasskey={viewer.hasPasskey} />
      )}
      <div className="space-y-4">
        <Passkeys
          mayChange={viewer.mayChangeSignInMethods}
          strongAuthMissing={viewer.strongAuthMissing}
        />
        <TwoFactor
          enabled={viewer.twoFactorEnabled}
          required={viewer.strongAuthMissing}
          mayChange={viewer.mayChangeSignInMethods}
          hasPassword={hasPassword}
        />
        {hasPassword ? (
          <ChangePassword />
        ) : (
          <SetPassword mayChange={viewer.mayChangeSignInMethods} />
        )}
        <Sessions />
        {viewer.adminArea && <McpAccess />}
      </div>
    </div>
  )
}

/**
 * Den gule boksen for admins som kom hit fra adminverktøyene. Har de passkey,
 * holder det å logge inn med den. Ellers velger de passkey eller tofaktor.
 */
function StrongAuthNotice({
  role,
  hasPasskey,
}: {
  role: keyof typeof roleNames | null
  hasPasskey: boolean
}) {
  const title = role ? roleNames[role] : 'admin'
  return (
    <div className="mb-4 flex gap-3 rounded-2xl bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset">
      <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 space-y-3">
        {hasPasskey ? (
          <>
            <p>
              Logg inn med passkey for å bruke adminverktøyene. Som {title} holder ikke passordet
              alene.
            </p>
            <PasskeySignInButton then="/admin" />
          </>
        ) : (
          <>
            <p>
              Som {title} må du logge inn med passkey eller ha tofaktor for å bruke adminverktøyene.
              Det tar et minutt å sette opp.
            </p>
            <div className="flex flex-wrap gap-2">
              <a href="#passkeys" className={buttonClass({ variant: 'brand', size: 'sm' })}>
                Legg til passkey
              </a>
              <a href="#tofaktor" className={buttonClass({ variant: 'secondary', size: 'sm' })}>
                Slå på tofaktor
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

type PasskeyItem = {
  id: string
  name?: string | null
  createdAt: Date | string
  deviceType: string
}

function Passkeys({
  mayChange,
  strongAuthMissing,
}: {
  mayChange: boolean
  strongAuthMissing: boolean
}) {
  const router = useRouter()
  const list = authClient.useListPasskeys()
  const passkeys = (list.data ?? []) as PasskeyItem[]
  // Ukjent (null) på serveren; da vises knappen.
  const supported = usePasskeySupport() !== false
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [added, setAdded] = useState(false)
  const [removing, setRemoving] = useState<PasskeyItem | null>(null)

  async function add() {
    setBusy(true)
    setError(null)
    setAdded(false)
    const { error } = await authClient.passkey.addPasskey()
    setBusy(false)
    if (error) return setError(passkeyManageError(error, 'Kunne ikke legge til passkeyen.'))
    setAdded(true)
    // Oppdaterer kravene (har passkey, kan endre metoder) i resten av appen.
    await router.invalidate()
  }

  return (
    <Section
      id="passkeys"
      title="Passkeys"
      description="En passkey er en nøkkel som ligger trygt på telefonen, datamaskinen eller i passordhåndtereren din, og lar deg logge inn med ansikt, fingeravtrykk eller PIN i stedet for passord. Admins kan bruke den i stedet for tofaktor."
    >
      {list.isPending ? (
        <p className="text-sm text-stone-500">Henter passkeys …</p>
      ) : list.error ? (
        <ErrorText>Kunne ikke hente passkeyene dine. Last siden på nytt.</ErrorText>
      ) : passkeys.length ? (
        <ul className="divide-y divide-stone-100 rounded-xl ring-1 ring-stone-200 ring-inset">
          {passkeys.map((p) => (
            <PasskeyRow
              key={p.id}
              passkey={p}
              mayChange={mayChange}
              onRemove={() => setRemoving(p)}
            />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-stone-600">Du har ingen passkeys ennå.</p>
      )}

      {added && strongAuthMissing && (
        <p className="text-sm text-stone-600">
          Passkeyen er lagt til. Logg inn med den for å bruke adminverktøyene nå.
        </p>
      )}
      {!supported ? (
        <p className="text-sm text-stone-600">
          Denne nettleseren støtter ikke passkeys. Prøv en nyere nettleser eller en annen enhet.
        </p>
      ) : mayChange ? (
        <Button variant={passkeys.length ? 'secondary' : 'brand'} onClick={add} disabled={busy}>
          <KeyRound className="size-4" aria-hidden />
          {busy ? 'Venter på enheten …' : 'Legg til passkey'}
        </Button>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-stone-600">
            Du er logget inn med passord. For å legge til eller fjerne passkeys må du logge inn med
            en av dem, så ingen som bare kan passordet ditt, kan bytte dem ut.
          </p>
          <PasskeySignInButton />
        </div>
      )}
      {error && <ErrorText>{error}</ErrorText>}

      {removing && (
        <RemovePasskey
          passkey={removing}
          last={passkeys.length === 1}
          onClose={() => setRemoving(null)}
          onDone={async () => {
            setRemoving(null)
            await router.invalidate()
          }}
        />
      )}
    </Section>
  )
}

const passkeyName = (p: PasskeyItem) => p.name?.trim() || 'Passkey'

function PasskeyRow({
  passkey: p,
  mayChange,
  onRemove,
}: {
  passkey: PasskeyItem
  mayChange: boolean
  onRemove: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function rename(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const name = String(new FormData(e.currentTarget).get('name')).trim()
    if (!name) return setError('Skriv et navn.')
    setBusy(true)
    setError(null)
    const { error } = await authClient.passkey.updatePasskey({ id: p.id, name })
    setBusy(false)
    if (error) return setError(passkeyManageError(error, 'Kunne ikke endre navnet.'))
    setEditing(false)
  }

  if (editing) {
    return (
      <li className="p-3">
        <form onSubmit={rename} className="space-y-2">
          <Field label="Navn på passkeyen">
            <Input
              name="name"
              defaultValue={p.name ?? ''}
              maxLength={60}
              placeholder="For eksempel «iPhone» eller «Jobb-PC»"
              autoComplete="off"
              required
              autoFocus
            />
          </Field>
          {error && <ErrorText>{error}</ErrorText>}
          <div className="flex gap-2">
            <Button type="submit" variant="secondary" size="sm" disabled={busy}>
              Lagre
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Avbryt
            </Button>
          </div>
        </form>
      </li>
    )
  }

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
      <KeyRound className="size-4 shrink-0 text-stone-400" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-stone-900">{passkeyName(p)}</p>
        <p className="text-xs text-stone-500">
          Lagt til {longDay(p.createdAt)} ·{' '}
          {p.deviceType === 'multiDevice'
            ? 'synkroniseres mellom enhetene dine'
            : 'bare på én enhet'}
        </p>
      </div>
      <div className="flex gap-1">
        <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
          Gi nytt navn
        </Button>
        {mayChange && (
          <Button variant="danger" size="sm" onClick={onRemove}>
            Fjern
          </Button>
        )}
      </div>
    </li>
  )
}

function RemovePasskey({
  passkey: p,
  last,
  onClose,
  onDone,
}: {
  passkey: PasskeyItem
  last: boolean
  onClose: () => void
  onDone: () => void
}) {
  const { viewer } = Route.useRouteContext()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const adminWithoutTotp =
    viewer.role !== null && needsStrongAuth(viewer.role) && !viewer.twoFactorEnabled

  async function remove() {
    setBusy(true)
    setError(null)
    const { error } = await authClient.passkey.deletePasskey({ id: p.id })
    if (error) {
      setBusy(false)
      return setError(passkeyManageError(error, 'Kunne ikke fjerne passkeyen.'))
    }
    onDone()
  }

  return (
    <Dialog
      title={`Fjerne «${passkeyName(p)}»?`}
      description={
        <>
          <p>
            Du kan ikke lenger logge inn med den. Slett den også fra enheten eller
            passordhåndtereren, så den ikke blir foreslått.
          </p>
          {last && adminWithoutTotp && (
            <p className="text-amber-800">
              Det er din eneste passkey, og du har ikke tofaktor. Neste gang du logger inn, kan du
              ikke bruke adminverktøyene før du har satt opp en av dem igjen.
            </p>
          )}
        </>
      }
      onClose={onClose}
      busy={busy}
    >
      {error && <ErrorText>{error}</ErrorText>}
      <DialogActions>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Avbryt
        </Button>
        <Button variant="destructive" onClick={remove} disabled={busy} data-autofocus>
          {busy ? 'Fjerner …' : 'Fjern passkey'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

function TwoFactor({
  enabled,
  required,
  mayChange,
  hasPassword,
}: {
  enabled: boolean
  required: boolean
  mayChange: boolean
  hasPassword: boolean
}) {
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
      id="tofaktor"
      title="Tofaktor"
      description="En kode fra en autentiseringsapp i tillegg til passordet. Admins må ha tofaktor eller logge inn med passkey."
    >
      {!hasPassword && !enabled ? (
        <p className="text-sm text-stone-600">
          Tofaktor gjelder innlogging med passord. Du logger inn med passkey, som allerede er sterk
          innlogging. Vil du også kunne bruke passord med tofaktor, setter du et passord under
          først.
        </p>
      ) : step === 'codes' ? (
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
            {required &&
              'Rollen din krever tofaktor eller innlogging med passkey for å bruke adminverktøyene.'}
          </p>
          {mayChange ? (
            <Button variant={required ? 'brand' : 'secondary'} onClick={() => setStep('password')}>
              Slå på tofaktor
            </Button>
          ) : (
            <p className="text-sm text-stone-600">
              Logg inn med en av passkeyene dine for å slå på tofaktor.
            </p>
          )}
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

/** For kontoer uten passord (bare passkey, fra en invitasjon). */
function SetPassword({ mayChange }: { mayChange: boolean }) {
  const router = useRouter()
  const save = useServerFn(setFirstPassword)
  const [state, setState] = useState<'idle' | 'busy'>('idle')
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const next = String(form.get('next'))
    if (next !== String(form.get('repeat'))) return setError('Passordene er ikke like.')
    setState('busy')
    setError(null)
    try {
      await save({ data: { password: next } })
      await router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke sette passordet.')
    } finally {
      setState('idle')
    }
  }

  return (
    <Section
      title="Passord"
      description="Kontoen din har ikke passord. Du logger inn med passkey. Et passord er en reserve om du mister passkeyen."
    >
      {mayChange ? (
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Passord" hint="Minst 12 tegn.">
              <Input
                name="next"
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
          {error && <ErrorText>{error}</ErrorText>}
          <Button type="submit" variant="secondary" disabled={state === 'busy'}>
            Sett passord
          </Button>
        </form>
      ) : (
        <p className="text-sm text-stone-600">
          Logg inn med en av passkeyene dine for å sette et passord.
        </p>
      )}
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

type ApiToken = NonNullable<Awaited<ReturnType<typeof fetchApiTokens>>>['tokens'][number]

const tokenLifetimes = [
  { days: 30, label: '30 dager' },
  { days: 90, label: '90 dager' },
  { days: 365, label: 'Ett år' },
]

/**
 * MCP-nøkler for admins: kobler Claude eller en annen MCP-klient til
 * adminverktøyene på `/api/mcp`. Nøkkelen vises én gang. Reglene står i
 * `api-tokens.ts` i @esaf/core.
 */
function McpAccess() {
  const { viewer } = Route.useRouteContext()
  const { mcp } = Route.useLoaderData()
  const router = useRouter()
  const create = useServerFn(newApiToken)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [readOnly, setReadOnly] = useState(false)
  const [created, setCreated] = useState<{ token: string; name: string; endpoint: string } | null>(
    null,
  )
  const [revoking, setRevoking] = useState<ApiToken | null>(null)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    setBusy(true)
    setError(null)
    try {
      const result = await create({
        data: {
          name: String(form.get('name')),
          days: Number(form.get('days')),
          readOnly,
        },
      })
      setCreated({ token: result.token, name: result.view.name, endpoint: result.endpoint })
      setCreating(false)
      setReadOnly(false)
      await router.invalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke lage nøkkelen.')
    } finally {
      setBusy(false)
    }
  }

  const tokens = mcp?.tokens ?? []
  const active = tokens.filter((t) => t.status === 'active')
  const old = tokens.filter((t) => t.status !== 'active')

  return (
    <Section
      id="mcp"
      title="MCP-tilgang"
      description={
        <>
          Koble Claude eller en annen MCP-klient til adminverktøyene, så du kan legge inn profiler,
          selskaper og arrangementer, og rydde i data, ved å skrive hva du vil ha gjort. Nøkkelen
          gir aldri mer enn du selv har, og alt den gjør, står i loggen merket med navnet på
          nøkkelen.
        </>
      }
    >
      {!mcp ? (
        <p className="text-sm text-stone-600">
          {viewer.strongAuthMissing
            ? 'Logg inn med passkey eller slå på tofaktor for å lage og se MCP-nøkler.'
            : 'Rollen din gir ikke tilgang til MCP-nøkler.'}
        </p>
      ) : created ? (
        <NewToken {...created} onDone={() => setCreated(null)} />
      ) : (
        <>
          {active.length > 0 ? (
            <ul className="divide-y divide-stone-100 rounded-xl ring-1 ring-stone-200 ring-inset">
              {active.map((t) => (
                <TokenRow key={t.id} token={t} onRevoke={() => setRevoking(t)} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-stone-600">Du har ingen gyldige MCP-nøkler.</p>
          )}

          {creating ? (
            <form
              onSubmit={onSubmit}
              className="space-y-3 rounded-xl p-4 ring-1 ring-stone-200 ring-inset"
            >
              <Field label="Navn" hint="Så du kjenner den igjen, for eksempel hvor den brukes.">
                <Input
                  name="name"
                  maxLength={80}
                  placeholder="Claude Code på laptopen"
                  autoComplete="off"
                  required
                  autoFocus
                />
              </Field>
              <Field label="Gyldig i">
                <Select name="days" defaultValue="90">
                  {tokenLifetimes.map((l) => (
                    <option key={l.days} value={l.days}>
                      {l.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Switch
                checked={readOnly}
                onChange={setReadOnly}
                label="Bare lesing"
                description="Klienten kan slå opp og søke, men ikke endre noe."
              />
              {error && <ErrorText>{error}</ErrorText>}
              <div className="flex gap-2">
                <Button type="submit" variant="brand" disabled={busy}>
                  {busy ? 'Lager …' : 'Lag nøkkel'}
                </Button>
                <Button variant="ghost" onClick={() => setCreating(false)} disabled={busy}>
                  Avbryt
                </Button>
              </div>
            </form>
          ) : (
            <Button
              variant={active.length ? 'secondary' : 'brand'}
              onClick={() => setCreating(true)}
            >
              <Bot className="size-4" aria-hidden />
              Ny MCP-nøkkel
            </Button>
          )}

          {old.length > 0 && (
            <details className="text-sm text-stone-600">
              <summary className="cursor-pointer text-stone-500">
                Utløpte og tilbaketrukne ({old.length})
              </summary>
              <ul className="mt-2 divide-y divide-stone-100 rounded-xl ring-1 ring-stone-200 ring-inset">
                {old.map((t) => (
                  <TokenRow key={t.id} token={t} />
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      {revoking && (
        <RevokeToken
          token={revoking}
          onClose={() => setRevoking(null)}
          onDone={async () => {
            setRevoking(null)
            await router.invalidate()
          }}
        />
      )}
    </Section>
  )
}

function TokenRow({ token: t, onRevoke }: { token: ApiToken; onRevoke?: () => void }) {
  const status =
    t.status === 'active'
      ? `Gyldig til ${longDay(t.expiresAt)}`
      : t.status === 'expired'
        ? `Utløpt ${longDay(t.expiresAt)}`
        : `Trukket tilbake ${longDay(t.revokedAt!)}`
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
      <Bot className="size-4 shrink-0 text-stone-400" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-stone-900">
          {t.name}
          {t.readOnly && <span className="ml-2 font-normal text-stone-500">bare lesing</span>}
        </p>
        <p className="text-xs text-stone-500">
          <span className="font-mono">{t.prefix}…</span> · {status} ·{' '}
          {t.lastUsedAt ? `brukt ${timeAgo(t.lastUsedAt)}` : 'aldri brukt'}
        </p>
      </div>
      {onRevoke && (
        <Button variant="danger" size="sm" onClick={onRevoke}>
          Trekk tilbake
        </Button>
      )}
    </li>
  )
}

/** Nøkkelen, én gang, med oppsett for Claude Code og andre klienter. */
function NewToken({
  token,
  name,
  endpoint,
  onDone,
}: {
  token: string
  name: string
  endpoint: string
  onDone: () => void
}) {
  const command = `claude mcp add --transport http esaf ${endpoint} --header "Authorization: Bearer ${token}"`
  return (
    <div className="space-y-4">
      <p className="text-sm text-stone-600">
        Nøkkelen «{name}» er laget. Kopier den nå: du får ikke se den igjen. Den er like hemmelig
        som et passord, så ikke del den eller legg den i kode.
      </p>
      <div className="space-y-2">
        <p className="text-sm font-medium text-stone-800">Nøkkelen</p>
        <code className="block rounded-xl bg-stone-50 p-3 font-mono text-sm break-all text-stone-900 ring-1 ring-stone-200 ring-inset">
          {token}
        </code>
        <CopyButton value={token} />
      </div>
      <div className="space-y-2">
        <p className="text-sm font-medium text-stone-800">Claude Code</p>
        <code className="block rounded-xl bg-stone-50 p-3 font-mono text-xs break-all text-stone-900 ring-1 ring-stone-200 ring-inset">
          {command}
        </code>
        <CopyButton value={command} />
      </div>
      <p className="text-xs leading-relaxed text-stone-500">
        Andre klienter: koble til <span className="font-mono">{endpoint}</span> med Streamable HTTP
        og hodet <span className="font-mono">Authorization: Bearer &lt;nøkkelen&gt;</span>.
      </p>
      <Button variant="brand" onClick={onDone}>
        Jeg har tatt vare på den
      </Button>
    </div>
  )
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={async () => {
        await navigator.clipboard.writeText(value)
        setCopied(true)
      }}
    >
      {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
      {copied ? 'Kopiert' : 'Kopier'}
    </Button>
  )
}

function RevokeToken({
  token,
  onClose,
  onDone,
}: {
  token: ApiToken
  onClose: () => void
  onDone: () => void
}) {
  const remove = useServerFn(removeApiToken)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function revoke() {
    setBusy(true)
    setError(null)
    try {
      await remove({ data: { id: token.id } })
      onDone()
    } catch (e) {
      setBusy(false)
      setError(e instanceof Error ? e.message : 'Kunne ikke trekke tilbake nøkkelen.')
    }
  }
  return (
    <Dialog
      title={`Trekke tilbake «${token.name}»?`}
      description="Klienter som bruker nøkkelen, mister tilgangen med en gang. Det kan ikke angres."
      onClose={onClose}
      busy={busy}
    >
      {error && <ErrorText>{error}</ErrorText>}
      <DialogActions>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Avbryt
        </Button>
        <Button variant="destructive" onClick={revoke} disabled={busy} data-autofocus>
          {busy ? 'Trekker tilbake …' : 'Trekk tilbake'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
