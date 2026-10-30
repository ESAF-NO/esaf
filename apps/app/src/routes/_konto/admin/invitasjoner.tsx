import type { InvitationView } from '@esaf/core'
import type { MemberRole } from '@esaf/db'
import { createFileRoute, isNotFound, notFound, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { Check, Info, MailPlus, Search, UserPlus, X } from 'lucide-react'
import { useId, useState, type FormEvent } from 'react'
import { Dialog, DialogActions } from '#/components/Dialog.tsx'
import { ShareLink } from '#/components/ShareLink.tsx'
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
} from '#/components/ui.tsx'
import { kull, longDay, timeAgo } from '#/lib/format.ts'
import {
  createInvite,
  fetchAuthOptions,
  fetchInvitations,
  inviteTarget,
  revokeLink,
  type ShareableLink,
} from '#/lib/invitations.functions.ts'
import { findUnclaimedProfiles } from '#/lib/members.functions.ts'
import { roleConsequence, roleLabel, roleNames, roleOrder } from '#/lib/roles.ts'

export const Route = createFileRoute('/_konto/admin/invitasjoner')({
  beforeLoad: ({ context: { viewer } }) => {
    if (!viewer.permissions.includes('members.review')) throw notFound()
  },
  loader: async () => {
    const [invitations, { emailEnabled }] = await Promise.all([
      fetchInvitations(),
      fetchAuthOptions(),
    ])
    return { invitations, emailEnabled }
  },
  head: () => ({ meta: [{ title: 'Invitasjoner – Admin – ESAF' }] }),
  component: Invitations,
  errorComponent: ({ error }) => (
    <ErrorText>{error instanceof Error ? error.message : 'Noe gikk galt.'}</ErrorText>
  ),
})

function errorMessage(error: unknown) {
  if (isNotFound(error)) {
    return 'Fant den ikke, eller du har ikke lenger tilgang til dette. Last siden på nytt.'
  }
  return error instanceof Error ? error.message : 'Noe gikk galt. Prøv igjen.'
}

function Invitations() {
  const { invitations, emailEnabled } = Route.useLoaderData()
  const [created, setCreated] = useState<ShareableLink | null>(null)
  const [revoking, setRevoking] = useState<InvitationView | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  return (
    <div className="max-w-3xl space-y-8">
      <p className="text-sm text-stone-500">
        {emailEnabled
          ? 'En invitasjon er en personlig lenke som sendes på e-post til adressen du skriver inn. Lenken vises også her, så du kan sende den selv om e-posten ikke kommer fram.'
          : 'En invitasjon er en personlig lenke du sender selv, for eksempel på SMS.'}{' '}
        Den som åpner den, velger passord eller passkey og er inne, uten å bekrefte e-post. Lenken
        er bundet til én e-postadresse, virker én gang og går ut etter sju dager. Lenker for nytt
        passord lages under Medlemmer.
      </p>

      <Card className="p-5 sm:p-6">
        <h2 className="text-base font-semibold text-stone-950">
          {created
            ? created.emailed
              ? 'Invitasjonen er sendt'
              : 'Invitasjonen er klar'
            : 'Inviter noen'}
        </h2>
        <div className="mt-4">
          {created ? (
            <div className="space-y-4">
              <ShareLink link={created} kind="invite" />
              <Button variant="secondary" onClick={() => setCreated(null)}>
                <MailPlus className="size-4" aria-hidden /> Inviter en til
              </Button>
            </div>
          ) : (
            <InviteForm onCreated={setCreated} emailEnabled={emailEnabled} />
          )}
        </div>
      </Card>

      <section aria-labelledby="sendte">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="sendte" className="text-base font-semibold text-stone-950">
            Sendte lenker
          </h2>
          <div role="status">
            {notice && (
              <p className="flex items-center gap-1.5 text-sm font-medium text-emerald-700">
                <Check className="size-4 shrink-0" aria-hidden /> {notice}
              </p>
            )}
          </div>
        </div>
        {invitations.length === 0 ? (
          <EmptyState icon={MailPlus} title="Ingen invitasjoner ennå">
            Invitasjoner og lenker for nytt passord vises her, med status.
          </EmptyState>
        ) : (
          <Card className="divide-y divide-stone-100">
            {invitations.map((i) => (
              <InvitationRow key={i.id} invitation={i} onRevoke={() => setRevoking(i)} />
            ))}
          </Card>
        )}
      </section>

      {revoking && (
        <RevokeDialog
          invitation={revoking}
          onClose={() => setRevoking(null)}
          onDone={() => {
            setRevoking(null)
            setNotice(`Lenken til ${revoking.email} er trukket tilbake.`)
          }}
        />
      )}
    </div>
  )
}

type Profile = { personId: string; fullName: string; years: number[] }

function InviteForm({
  onCreated,
  emailEnabled,
}: {
  onCreated: (link: ShareableLink) => void
  emailEnabled: boolean
}) {
  const { viewer } = Route.useRouteContext()
  const router = useRouter()
  const create = useServerFn(createInvite)
  const describe = useServerFn(inviteTarget)
  const search = useServerFn(findUnclaimedProfiles)
  const mayGiveRoles = viewer.permissions.includes('roles.manage')
  const profilesLabel = useId()

  const [email, setEmail] = useState('')
  const [role, setRole] = useState<MemberRole>('member')
  const [options, setOptions] = useState<Profile[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [target, setTarget] = useState<Awaited<ReturnType<typeof describe>> | null>(null)
  const [checkedEmail, setCheckedEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** Ser etter profiler med adressen i kullisten, og om den allerede har en konto. */
  async function lookUp(value: string) {
    const address = value.trim().toLowerCase()
    if (address === checkedEmail || !address.includes('@')) return
    setCheckedEmail(address)
    try {
      const result = await describe({ data: { email: address } })
      setTarget(result)
      if (result.profiles.length) {
        setOptions((current) => [
          ...result.profiles,
          ...current.filter((o) => !result.profiles.some((p) => p.personId === o.personId)),
        ])
        // Én profil med samme adresse er nesten alltid riktig, men admin bekrefter ved å sende.
        if (result.profiles.length === 1 && selected === null) {
          setSelected(result.profiles[0]!.personId)
        }
      }
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  async function onSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const query = String(new FormData(event.currentTarget).get('query') ?? '').trim()
    if (query.length < 2) return
    try {
      const found = await search({ data: { query } })
      if (!found.length) return setError(`Fant ingen profil uten konto som heter «${query}».`)
      setError(null)
      setOptions((current) => [
        ...current,
        ...found
          .filter((p) => !current.some((o) => o.personId === p.personId))
          .map((p) => ({ personId: p.personId, fullName: p.fullName, years: p.cohortYears })),
      ])
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const link = await create({ data: { email, role, personId: selected } })
      await router.invalidate()
      onCreated(link)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  const chosen = options.find((o) => o.personId === selected) ?? null
  const sameEmail = new Set(target?.profiles.map((p) => p.personId))
  const account = target?.account

  return (
    <div className="space-y-5">
      <form id="invite" onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-[1fr_12rem]">
        <Field
          label="E-post"
          hint="Personen må bruke denne adressen. Den kan ikke endres i lenken."
        >
          <Input
            name="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={(e) => void lookUp(e.target.value)}
            autoComplete="off"
            required
            autoFocus
          />
        </Field>
        <Field
          label="Rolle"
          hint={mayGiveRoles ? undefined : 'Bare hovedadmins kan invitere med en rolle.'}
        >
          <Select
            value={role}
            onChange={(e) => setRole(e.target.value as MemberRole)}
            disabled={!mayGiveRoles}
          >
            {(mayGiveRoles ? roleOrder : (['member'] as MemberRole[])).map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </Select>
        </Field>
      </form>

      {account && (
        <p className="flex gap-2 rounded-xl bg-sky-50 px-3 py-2.5 text-sm text-sky-900 ring-1 ring-sky-200 ring-inset">
          <Info className="mt-0.5 size-4 shrink-0 text-sky-600" aria-hidden />
          <span>
            {account.status === 'active'
              ? `Adressen hører til et aktivt medlem${account.fullName ? ` (${account.fullName})` : ''}. Endre rollen under Medlemmer i stedet.`
              : account.verified
                ? `Adressen har allerede en konto${account.fullName ? ` (${account.fullName})` : ''}${account.status === 'inactive' ? ' som er deaktivert eller avslått' : ' som venter på godkjenning'}. Personen logger inn og åpner lenken, og blir da aktivt medlem.`
                : 'Adressen har en konto som aldri ble bekreftet. Den overtas av den som åpner lenken.'}
          </span>
        </p>
      )}

      <div>
        <p id={profilesLabel} className="text-sm font-medium text-stone-900">
          Profil fra kullisten
        </p>
        <p className="mt-0.5 text-xs text-stone-500">
          Velg profilen hvis personen står i kullisten, så kobles kontoen til den. Profiler med
          samme e-postadresse foreslås når du har skrevet adressen.
        </p>
        <ul className="mt-2 space-y-1.5" role="radiogroup" aria-labelledby={profilesLabel}>
          {options.map((o) => (
            <li key={o.personId}>
              <button
                type="button"
                role="radio"
                aria-checked={selected === o.personId}
                onClick={() => setSelected(o.personId)}
                className={cx(
                  'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left ring-1 transition ring-inset',
                  selected === o.personId
                    ? 'bg-white ring-brand-500'
                    : 'ring-stone-200 hover:bg-white',
                )}
              >
                <Avatar name={o.fullName} size="sm" muted />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-sm font-medium text-stone-950">
                    <span className="truncate">{o.fullName}</span>
                    {sameEmail.has(o.personId) && (
                      <span className="rounded-full bg-emerald-50 px-1.5 py-px text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-600/15 ring-inset">
                        Samme e-post
                      </span>
                    )}
                  </span>
                  <span className="block text-xs text-stone-500">
                    {kull(o.years) ?? 'Uten kull'}
                  </span>
                </span>
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              role="radio"
              aria-checked={selected === null}
              onClick={() => setSelected(null)}
              className={cx(
                'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm ring-1 transition ring-inset',
                selected === null
                  ? 'bg-white text-stone-950 ring-brand-500'
                  : 'text-stone-600 ring-stone-200 hover:bg-white',
              )}
            >
              <span className="grid size-8 place-items-center rounded-full bg-stone-100 text-stone-500">
                <UserPlus className="size-4" aria-hidden />
              </span>
              Ingen profil. Personen skriver inn navnet selv.
            </button>
          </li>
        </ul>
        <form onSubmit={onSearch} className="mt-2.5 flex gap-2">
          <Input
            name="query"
            placeholder="Søk etter en profil uten konto"
            minLength={2}
            required
            aria-label="Søk etter profil"
            className="h-9"
          />
          <Button type="submit" variant="secondary" size="sm" className="h-9">
            <Search className="size-4" aria-hidden /> Søk
          </Button>
        </form>
      </div>

      {role !== 'member' && (
        <p className="text-sm text-stone-600">
          {roleConsequence(role, 'personen')} Rettighetene virker først når personen har lagt til en
          passkey eller slått på tofaktor.
        </p>
      )}
      {error && <ErrorText>{error}</ErrorText>}
      <div className="flex justify-end">
        <Button type="submit" form="invite" variant="brand" disabled={busy}>
          <MailPlus className="size-4" aria-hidden />
          {busy
            ? emailEnabled
              ? 'Sender …'
              : 'Lager lenke …'
            : `${emailEnabled ? 'Send invitasjon' : 'Lag invitasjon'}${
                chosen
                  ? ` for ${chosen.fullName}`
                  : role === 'member'
                    ? ''
                    : ` som ${roleNames[role]}`
              }`}
        </Button>
      </div>
    </div>
  )
}

const statusText = {
  pending: { label: 'Venter', tone: 'bg-amber-50 text-amber-800 ring-amber-600/20' },
  used: { label: 'Brukt', tone: 'bg-emerald-50 text-emerald-700 ring-emerald-600/15' },
  expired: { label: 'Utløpt', tone: 'bg-stone-100 text-stone-600 ring-stone-300' },
  revoked: { label: 'Trukket tilbake', tone: 'bg-stone-100 text-stone-600 ring-stone-300' },
} as const

function InvitationRow({
  invitation: i,
  onRevoke,
}: {
  invitation: InvitationView
  onRevoke: () => void
}) {
  const status = statusText[i.status]
  const what =
    i.kind === 'password_reset'
      ? `Nytt passord${i.profile ? ` for ${i.profile.fullName}` : ''}`
      : [
          i.role !== 'member' ? roleLabel(i.role) : 'Medlem',
          i.profile ? `profil: ${i.profile.fullName}` : null,
        ]
          .filter(Boolean)
          .join(' · ')
  const when =
    i.status === 'used' && i.usedAt
      ? `Brukt ${timeAgo(i.usedAt)}${i.usedBy ? ` av ${i.usedBy.fullName}` : ''}`
      : i.status === 'pending'
        ? `Gjelder til ${longDay(i.expiresAt)}`
        : i.status === 'revoked' && i.revokedAt
          ? `Trukket tilbake ${timeAgo(i.revokedAt)}`
          : `Utløp ${longDay(i.expiresAt)}`
  return (
    <div className="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-2 text-sm">
          <span className="truncate font-medium text-stone-950">{i.email}</span>
          <span
            className={cx(
              'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
              status.tone,
            )}
          >
            {status.label}
          </span>
        </p>
        <p className="truncate text-xs text-stone-500">
          {what} ·{' '}
          {i.requestedBySelf ? 'Bedt om selv' : i.createdBy ? i.createdBy.fullName : 'Operatør'},{' '}
          {timeAgo(i.createdAt)}
        </p>
        <p className="text-xs text-stone-500">{when}</p>
      </div>
      {i.status === 'pending' && (
        <Button
          variant="secondary"
          size="sm"
          onClick={onRevoke}
          aria-label={`Trekk tilbake lenken til ${i.email}`}
        >
          <X className="size-4" aria-hidden /> Trekk tilbake
        </Button>
      )}
    </div>
  )
}

function RevokeDialog({
  invitation: i,
  onClose,
  onDone,
}: {
  invitation: InvitationView
  onClose: () => void
  onDone: () => void
}) {
  const router = useRouter()
  const revoke = useServerFn(revokeLink)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      await revoke({ data: { id: i.id } })
      await router.invalidate()
      onDone()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={`Trekke tilbake lenken til ${i.email}?`}
      description="Lenken slutter å virke med en gang. Du kan lage en ny etterpå."
      onClose={onClose}
      busy={busy}
    >
      {error && <ErrorText>{error}</ErrorText>}
      <DialogActions>
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Avbryt
        </Button>
        <Button variant="destructive" onClick={confirm} disabled={busy} data-autofocus>
          {busy ? 'Trekker tilbake …' : 'Trekk tilbake'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
