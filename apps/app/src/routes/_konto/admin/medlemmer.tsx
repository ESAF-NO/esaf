import type { AccountView } from '@esaf/core'
import type { MemberRole } from '@esaf/db'
import {
  createFileRoute,
  isNotFound,
  Link,
  notFound,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { CircleCheck, Search, SearchX, ShieldAlert, ShieldCheck } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { z } from 'zod'
import { Dialog, DialogActions } from '#/components/Dialog.tsx'
import {
  Avatar,
  Button,
  Card,
  cx,
  EmptyState,
  ErrorText,
  Field,
  Input,
  Select,
  Textarea,
} from '#/components/ui.tsx'
import { fetchAccounts, updateAccess, updateRole } from '#/lib/admin.functions.ts'
import { kull, lastActive, plural } from '#/lib/format.ts'
import { fold } from '#/lib/member-search.ts'
import {
  needsTwoFactor,
  roleAtLeast,
  roleConsequence,
  roleLabel,
  roleNames,
  roleOrder,
} from '#/lib/roles.ts'

export const Route = createFileRoute('/_konto/admin/medlemmer')({
  beforeLoad: ({ context: { viewer } }) => {
    if (!viewer.permissions.includes('members.manage')) throw notFound()
  },
  validateSearch: z.object({
    q: z.string().optional().catch(undefined),
    rolle: z.enum(roleNames).optional().catch(undefined),
    status: z.enum(['aktiv', 'deaktivert']).optional().catch(undefined),
  }),
  loader: () => fetchAccounts(),
  head: () => ({ meta: [{ title: 'Medlemmer – Admin – ESAF' }] }),
  component: Members,
  errorComponent: ({ error }) => (
    <ErrorText>{error instanceof Error ? error.message : 'Noe gikk galt.'}</ErrorText>
  ),
})

const PAGE = 50
const columns = 'md:grid md:grid-cols-[minmax(0,1fr)_10rem_9rem_8rem] md:items-center md:gap-4'

/** Handlingen admin har valgt og må bekrefte i en dialog. */
type Pending =
  | { kind: 'role'; account: AccountView; role: MemberRole }
  | { kind: 'access'; account: AccountView }

const firstName = (fullName: string) => fullName.split(/\s+/)[0] || fullName

function errorMessage(error: unknown) {
  // Serveren svarer «finnes ikke» både når personen er borte og når du har mistet rettigheten.
  if (isNotFound(error)) {
    return 'Fant ikke personen, eller du har ikke lenger tilgang til dette. Last siden på nytt.'
  }
  return error instanceof Error ? error.message : 'Noe gikk galt. Prøv igjen.'
}

function Members() {
  const accounts = Route.useLoaderData()
  const search = Route.useSearch()
  const { viewer } = Route.useRouteContext()
  const navigate = useNavigate({ from: Route.fullPath })
  const [shown, setShown] = useState(PAGE)
  const [pending, setPending] = useState<Pending | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const results = useMemo(() => {
    const words = fold(search.q ?? '')
      .split(/\s+/)
      .filter(Boolean)
    return accounts
      .filter(
        (a) =>
          (!search.rolle || roleNames[a.role] === search.rolle) &&
          (!search.status || (search.status === 'aktiv') === (a.status === 'active')) &&
          words.every((w) => fold(`${a.fullName} ${a.email}`).includes(w)),
      )
      .sort((a, b) => a.fullName.localeCompare(b.fullName, 'nb'))
  }, [accounts, search])

  const filtered = Boolean(search.q || search.rolle || search.status)
  const inactive = accounts.filter((a) => a.status === 'inactive').length
  const setSearch = (patch: Partial<typeof search>) => {
    setShown(PAGE)
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })
  }

  // Samme regler som serveren, bare for å vise riktige knapper. Serveren avgjør.
  const isOwner = viewer.role === 'owner'
  const canManageRoles = viewer.permissions.includes('roles.manage')
  const canManageAccess = viewer.permissions.includes('members.manage')
  const controls = (a: AccountView) => {
    const self = a.personId === viewer.personId
    const protectedAdmin = roleAtLeast(a.role, 'admin') && !isOwner
    return {
      self,
      role: canManageRoles && !self && a.status === 'active',
      access: canManageAccess && !self && !protectedAdmin,
      protectedAdmin: canManageAccess && !self && protectedAdmin,
    }
  }

  function done(message: string) {
    setPending(null)
    setNotice(message)
  }

  return (
    <>
      <p className="mb-5 max-w-3xl text-sm text-stone-500">
        Alle med konto som er eller har vært medlem. Ventende og avslåtte ligger under{' '}
        <Link to="/admin" className="font-medium text-stone-700 hover:text-brand-600">
          Forespørsler
        </Link>
        .{!isOwner && ' Bare en hovedadmin kan gi roller og endre tilgangen til admins.'}
      </p>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400"
            aria-hidden
          />
          <Input
            type="search"
            value={search.q ?? ''}
            onChange={(e) => setSearch({ q: e.target.value || undefined })}
            placeholder="Søk på navn eller e-post"
            aria-label="Søk på navn eller e-post"
            className="pl-9"
          />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <div className="sm:w-40">
            <Select
              value={search.rolle ?? ''}
              onChange={(e) =>
                setSearch({ rolle: (e.target.value || undefined) as typeof search.rolle })
              }
              aria-label="Rolle"
            >
              <option value="">Alle roller</option>
              {roleOrder.map((role) => (
                <option key={role} value={roleNames[role]}>
                  {roleLabel(role)}
                </option>
              ))}
            </Select>
          </div>
          <div className="sm:w-40">
            <Select
              value={search.status ?? ''}
              onChange={(e) =>
                setSearch({ status: (e.target.value || undefined) as typeof search.status })
              }
              aria-label="Status"
            >
              <option value="">Alle statuser</option>
              <option value="aktiv">Aktive</option>
              <option value="deaktivert">Deaktiverte</option>
            </Select>
          </div>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-sm text-stone-500" aria-live="polite">
          {filtered
            ? plural(results.length, 'treff', 'treff')
            : plural(accounts.length, 'konto', 'kontoer') +
              (inactive ? `, ${inactive} deaktivert` : '')}
        </p>
        <div role="status">
          {notice && (
            <p className="flex items-center gap-1.5 text-sm font-medium text-emerald-700">
              <CircleCheck className="size-4 shrink-0" aria-hidden /> {notice}
            </p>
          )}
        </div>
      </div>

      {results.length === 0 ? (
        <EmptyState icon={SearchX} title="Ingen treff">
          Prøv et annet søk, eller fjern filtrene.
        </EmptyState>
      ) : (
        <>
          <Card className="overflow-hidden">
            <div
              aria-hidden
              className={cx(
                'hidden border-b border-stone-200/70 bg-stone-50/70 px-4 py-2.5 text-xs font-medium text-stone-500',
                columns,
              )}
            >
              <span>Navn</span>
              <span>Rolle</span>
              <span>Status</span>
            </div>
            <ul aria-label="Medlemmer" className="divide-y divide-stone-100">
              {results.slice(0, shown).map((a) => (
                <AccountRow
                  key={a.personId}
                  account={a}
                  {...controls(a)}
                  onRole={(role) => setPending({ kind: 'role', account: a, role })}
                  onAccess={() => setPending({ kind: 'access', account: a })}
                />
              ))}
            </ul>
          </Card>
          {shown < results.length && (
            <div className="mt-6 text-center">
              <Button variant="secondary" onClick={() => setShown((n) => n + PAGE)}>
                Vis flere ({results.length - shown} til)
              </Button>
            </div>
          )}
        </>
      )}

      {pending?.kind === 'role' && (
        <RoleDialog
          account={pending.account}
          role={pending.role}
          onClose={() => setPending(null)}
          onDone={done}
        />
      )}
      {pending?.kind === 'access' && (
        <AccessDialog account={pending.account} onClose={() => setPending(null)} onDone={done} />
      )}
    </>
  )
}

function AccountRow({
  account: a,
  self,
  role,
  access,
  protectedAdmin,
  onRole,
  onAccess,
}: {
  account: AccountView
  self: boolean
  role: boolean
  access: boolean
  protectedAdmin: boolean
  onRole: (role: MemberRole) => void
  onAccess: () => void
}) {
  const active = a.status === 'active'
  const cohorts = kull(a.cohortYears)
  return (
    <li className={cx('flex flex-col gap-3 px-4 py-3.5', columns)}>
      <div className="flex min-w-0 items-center gap-3">
        <Avatar name={a.fullName} size="sm" muted={!active} />
        <div className="min-w-0">
          <p className="flex min-w-0 items-baseline gap-2 text-sm">
            {/* Profilen til en deaktivert person kan ikke åpnes, så den lenkes ikke. */}
            {active ? (
              <Link
                to="/medlemmer/$personId"
                params={{ personId: a.personId }}
                className="truncate font-medium text-stone-950 hover:text-brand-600"
              >
                {a.fullName}
              </Link>
            ) : (
              <span className="truncate font-medium text-stone-600">{a.fullName}</span>
            )}
            {self && <span className="shrink-0 text-xs text-stone-500">(deg)</span>}
            {cohorts && <span className="shrink-0 text-xs text-stone-500">{cohorts}</span>}
          </p>
          <p className="truncate text-xs text-stone-500">{a.email}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-x-6 gap-y-3 pl-11 md:contents">
        <div className="min-w-0">
          {role ? (
            <div className="w-40">
              <Select
                value={a.role}
                // Valget lagres ikke før det er bekreftet i dialogen.
                onChange={(e) => onRole(e.target.value as MemberRole)}
                aria-label={`Rolle for ${a.fullName}`}
              >
                {roleOrder.map((r) => (
                  <option key={r} value={r}>
                    {roleLabel(r)}
                  </option>
                ))}
              </Select>
            </div>
          ) : (
            <p className={cx('text-sm', active ? 'text-stone-800' : 'text-stone-500')}>
              {roleLabel(a.role)}
            </p>
          )}
          {needsTwoFactor(a.role) && <TwoFactorStatus enabled={a.twoFactorEnabled} />}
        </div>

        <div className="min-w-0">
          <p className={cx('text-sm', active ? 'text-stone-800' : 'font-medium text-red-700')}>
            {active ? 'Aktiv' : 'Deaktivert'}
          </p>
          <p className="text-xs text-stone-500">
            {a.lastSeenAt ? `Sist aktiv ${lastActive(a.lastSeenAt)}` : 'Ikke innlogget'}
          </p>
        </div>

        <div className="md:text-right">
          {access ? (
            <Button
              variant={active ? 'danger' : 'secondary'}
              size="sm"
              onClick={onAccess}
              aria-label={`${active ? 'Deaktiver' : 'Gjenopprett'} ${a.fullName}`}
            >
              {active ? 'Deaktiver' : 'Gjenopprett'}
            </Button>
          ) : protectedAdmin ? (
            <span className="text-xs text-stone-500">Krever hovedadmin</span>
          ) : null}
        </div>
      </div>
    </li>
  )
}

function TwoFactorStatus({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <p className="mt-1 flex items-center gap-1 text-xs text-emerald-700">
      <ShieldCheck className="size-3.5 shrink-0" aria-hidden /> Tofaktor på
    </p>
  ) : (
    <p className="mt-1 flex items-center gap-1 text-xs text-amber-700">
      <ShieldAlert className="size-3.5 shrink-0" aria-hidden /> Mangler tofaktor
    </p>
  )
}

/** Felles for dialogene: lagrer, laster listen på nytt og melder fra, eller viser feilen. */
function useSave(onDone: (message: string) => void) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function save(action: () => Promise<unknown>, message: string) {
    setBusy(true)
    setError(null)
    try {
      await action()
      // Dialogen står til listen er oppdatert, så raden ikke viser gammel status etterpå.
      await router.invalidate()
      onDone(message)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  return { busy, error, setError, save }
}

function RoleDialog({
  account: a,
  role,
  onClose,
  onDone,
}: {
  account: AccountView
  role: MemberRole
  onClose: () => void
  onDone: (message: string) => void
}) {
  const changeRole = useServerFn(updateRole)
  const { busy, error, save } = useSave(onDone)
  const name = firstName(a.fullName)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim()
    void save(
      () => changeRole({ data: { personId: a.personId, role, ...(reason && { reason }) } }),
      `${a.fullName} er nå ${roleNames[role]}.`,
    )
  }

  return (
    <Dialog
      title={`Endre rollen til ${a.fullName}?`}
      description={
        <>
          <p>
            Fra {roleNames[a.role]} til {roleNames[role]}. {roleConsequence(role, name)}
          </p>
          {needsTwoFactor(role) && !a.twoFactorEnabled && (
            <p className="text-amber-800">
              {name} har ikke slått på tofaktor, og kan ikke bruke rettighetene før det er gjort
              under «Konto og sikkerhet».
            </p>
          )}
        </>
      }
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Begrunnelse" hint="Valgfritt. Lagres i loggen sammen med endringen.">
          <Input name="reason" maxLength={500} autoComplete="off" data-autofocus />
        </Field>
        {error && <ErrorText>{error}</ErrorText>}
        <DialogActions>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Avbryt
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? 'Lagrer …' : `Gjør til ${roleNames[role]}`}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

function AccessDialog({
  account: a,
  onClose,
  onDone,
}: {
  account: AccountView
  onClose: () => void
  onDone: (message: string) => void
}) {
  const setAccess = useServerFn(updateAccess)
  const { busy, error, setError, save } = useSave(onDone)
  const deactivate = a.status === 'active'
  const name = firstName(a.fullName)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim()
    // Samme krav som serveren, så svaret kommer før noe sendes.
    if (deactivate && reason.length < 3) {
      return setError('Skriv en kort begrunnelse. Den lagres i loggen.')
    }
    void save(
      () => setAccess({ data: { personId: a.personId, active: !deactivate, reason } }),
      deactivate
        ? `${a.fullName} er deaktivert og logget ut.`
        : `${a.fullName} har fått tilgangen tilbake.`,
    )
  }

  return (
    <Dialog
      title={deactivate ? `Deaktiver ${a.fullName}?` : `Gjenopprett tilgangen til ${a.fullName}?`}
      description={
        deactivate ? (
          <>
            <p>
              {name} blir logget ut på alle enheter med en gang, mister tilgangen til appen og vises
              ikke lenger i katalogen.
            </p>
            {a.role !== 'member' && (
              <p>
                {name} mister også rollen som {roleNames[a.role]}. Den må gis på nytt hvis tilgangen
                gjenopprettes.
              </p>
            )}
          </>
        ) : (
          <p>
            {name} kan logge inn igjen og får vanlig medlemskap. Eventuelle roller må gis på nytt av
            en hovedadmin.
          </p>
        )
      }
      onClose={onClose}
      busy={busy}
    >
      {/* Egen sjekk med norsk tekst i stedet for nettleserens. */}
      <form onSubmit={submit} noValidate className="space-y-4">
        <Field
          label="Begrunnelse"
          hint={deactivate ? 'Påkrevd. Lagres i loggen.' : 'Valgfritt. Lagres i loggen.'}
        >
          <Textarea name="reason" rows={3} maxLength={500} required={deactivate} data-autofocus />
        </Field>
        {error && <ErrorText>{error}</ErrorText>}
        <DialogActions>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Avbryt
          </Button>
          <Button type="submit" variant={deactivate ? 'destructive' : 'primary'} disabled={busy}>
            {busy ? 'Lagrer …' : deactivate ? 'Deaktiver' : 'Gjenopprett tilgang'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}
