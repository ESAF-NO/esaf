import type { AccessRequestView } from '@esaf/core'
import { createFileRoute, Link, notFound, redirect, useRouter } from '@tanstack/react-router'
import {
  AlertTriangle,
  Check,
  CircleCheck,
  Phone,
  Search,
  ShieldCheck,
  UserPlus,
  X,
} from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { z } from 'zod'
import {
  Avatar,
  Button,
  Card,
  cx,
  EmptyState,
  ErrorText,
  Input,
  LinkedInIcon,
  PageHeader,
} from '#/components/ui.tsx'
import { decideRequest, fetchAccessRequests } from '#/lib/access.functions.ts'
import { timeAgo } from '#/lib/format.ts'
import { findUnclaimedProfiles } from '#/lib/members.functions.ts'

export const Route = createFileRoute('/_konto/admin')({
  beforeLoad: ({ context: { viewer } }) => {
    if (!viewer.adminArea) throw notFound()
    if (viewer.twoFactorMissing) throw redirect({ to: '/konto', search: { krav: 'tofaktor' } })
  },
  validateSearch: z.object({ vis: z.enum(['behandlet']).optional().catch(undefined) }),
  loaderDeps: ({ search }) => ({ vis: search.vis }),
  loader: async ({ deps }) => {
    const open = await fetchAccessRequests({ data: { status: 'open' } })
    if (deps.vis !== 'behandlet') return { open, decided: [] }
    const [approved, rejected] = await Promise.all([
      fetchAccessRequests({ data: { status: 'approved' } }),
      fetchAccessRequests({ data: { status: 'rejected' } }),
    ])
    const decided = [...approved, ...rejected].sort(
      (a, b) => new Date(b.decidedAt ?? 0).getTime() - new Date(a.decidedAt ?? 0).getTime(),
    )
    return { open, decided }
  },
  head: () => ({ meta: [{ title: 'Forespørsler – ESAF' }] }),
  component: Admin,
  errorComponent: ({ error }) => (
    <ErrorText>{error instanceof Error ? error.message : 'Noe gikk galt.'}</ErrorText>
  ),
})

function Admin() {
  const { open, decided } = Route.useLoaderData()
  const { vis } = Route.useSearch()

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Forespørsler om tilgang"
        description="Ingen slipper inn uten at en admin har godkjent. Se hva som faktisk er bekreftet før du godkjenner."
      />
      <div className="mb-6 inline-flex rounded-xl bg-stone-200/60 p-1" role="tablist">
        {(
          [
            [undefined, `Åpne (${open.length})`],
            ['behandlet', 'Behandlet'],
          ] as const
        ).map(([value, label]) => (
          <Link
            key={label}
            to="/admin"
            search={{ vis: value }}
            role="tab"
            aria-selected={vis === value}
            className={cx(
              'inline-flex h-8 items-center rounded-lg px-3 text-sm font-medium transition',
              vis === value
                ? 'bg-white text-stone-950 shadow-card'
                : 'text-stone-600 hover:text-stone-900',
            )}
          >
            {label}
          </Link>
        ))}
      </div>

      {vis === 'behandlet' ? (
        decided.length === 0 ? (
          <EmptyState icon={ShieldCheck} title="Ingen forespørsler er behandlet ennå" />
        ) : (
          <Card className="divide-y divide-stone-100">
            {decided.map((r) => (
              <DecidedRow key={r.id} request={r} />
            ))}
          </Card>
        )
      ) : open.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="Ingen venter på godkjenning">
          Nye forespørsler dukker opp her når noen har bekreftet e-posten og fortalt hvem de er.
        </EmptyState>
      ) : (
        <ul className="space-y-4">
          {open.map((r) => (
            <li key={r.id}>
              <RequestCard request={r} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** En profil fra kullisten som forespørselen kan kobles til. */
type Option = { personId: string; fullName: string; years: number[]; phone: string | null }

function Signal({ tone, children }: { tone: 'ok' | 'strong' | 'warn'; children: ReactNode }) {
  const Icon = tone === 'warn' ? AlertTriangle : tone === 'strong' ? ShieldCheck : CircleCheck
  return (
    <li
      className={cx(
        'flex gap-2.5 text-sm',
        tone === 'strong' && 'font-medium text-emerald-800',
        tone === 'ok' && 'text-stone-700',
        tone === 'warn' && 'text-amber-800',
      )}
    >
      <Icon
        className={cx(
          'mt-0.5 size-4 shrink-0',
          tone === 'warn' ? 'text-amber-500' : 'text-emerald-600',
        )}
        aria-hidden
      />
      <span>{children}</span>
    </li>
  )
}

function RequestCard({ request: r }: { request: AccessRequestView }) {
  const router = useRouter()
  const toOption = (p: {
    personId: string
    fullName: string
    years: number[]
    phone: string | null
  }) => ({ personId: p.personId, fullName: p.fullName, years: p.years, phone: p.phone }) as Option
  const [options, setOptions] = useState<Option[]>(() =>
    [...(r.profile ? [r.profile] : []), ...r.suggestions].map(toOption),
  )
  const [selected, setSelected] = useState<string | null>(r.profile?.personId ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chosen = options.find((o) => o.personId === selected) ?? null
  const strong = r.emailOnProfile && selected === r.profile?.personId

  async function decide(decision: 'approve' | 'reject') {
    setBusy(true)
    setError(null)
    try {
      await decideRequest({
        data: {
          requestId: r.id,
          decision,
          ...(decision === 'approve' && { profilePersonId: selected }),
        },
      })
      await router.invalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Noe gikk galt.')
      setBusy(false)
    }
  }

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const query = String(new FormData(event.currentTarget).get('query'))
    const found = await findUnclaimedProfiles({ data: { query } })
    setOptions((list) => [
      ...list,
      ...found
        .filter((f) => !list.some((o) => o.personId === f.personId))
        .map((f) => toOption({ ...f, years: f.cohortYears })),
    ])
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex items-start gap-4 p-5">
        <Avatar name={r.fullName} size="md" muted />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <p className="font-semibold text-stone-950">{r.fullName}</p>
            <p className="text-xs text-stone-500">{timeAgo(r.createdAt)}</p>
          </div>
          <p className="truncate text-sm text-stone-500">{r.email}</p>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-stone-700">
            <span>{r.graduationYear ? `Sier ES ${r.graduationYear}` : 'Kull ikke oppgitt'}</span>
            {r.linkedinUrl && (
              <a
                href={r.linkedinUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-brand-600 hover:underline"
              >
                <LinkedInIcon className="size-3.5" /> LinkedIn
              </a>
            )}
          </p>
          {r.note && (
            <p className="mt-2.5 rounded-lg bg-stone-50 px-3 py-2 text-sm text-stone-600 ring-1 ring-stone-200/70 ring-inset">
              {r.note}
            </p>
          )}
        </div>
      </div>

      <div className="space-y-5 border-t border-stone-100 bg-stone-50/60 p-5">
        <div>
          <p className="text-[11px] font-semibold tracking-wider text-stone-400 uppercase">
            Hva er bekreftet
          </p>
          <ul className="mt-2 space-y-1.5">
            <Signal tone="ok">
              E-postadressen er bekreftet: personen har tilgang til innboksen.
            </Signal>
            {r.profile && r.emailOnProfile ? (
              <Signal tone="strong">
                Adressen står i telefonlista på profilen personen valgte. Det er et sterkt tegn på
                at det er riktig person.
              </Signal>
            ) : (
              <Signal tone="warn">
                Adressen står ikke i telefonlista. Navn, kull og LinkedIn kan hvem som helst skrive
                inn, så sjekk selv før du godkjenner, for eksempel ved å ringe nummeret fra lista.
              </Signal>
            )}
          </ul>
        </div>

        <div>
          <p className="text-[11px] font-semibold tracking-wider text-stone-400 uppercase">
            Koble til profil fra kullisten
          </p>
          <ul className="mt-2 space-y-1.5" role="radiogroup" aria-label="Profil">
            {options.map((o) => (
              <ProfileOption
                key={o.personId}
                option={o}
                selected={selected === o.personId}
                verified={r.emailOnProfile && o.personId === r.profile?.personId}
                onSelect={() => setSelected(o.personId)}
              />
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
                Ingen profil. Godkjenn som ny person
                {r.graduationYear ? ` i ES ${r.graduationYear}` : ''}.
              </button>
            </li>
          </ul>
          <form onSubmit={search} className="mt-2.5 flex gap-2">
            <Input
              name="query"
              placeholder="Søk etter en annen profil"
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

        {error && <ErrorText>{error}</ErrorText>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={busy} onClick={() => decide('reject')}>
            <X className="size-4" aria-hidden /> Avslå
          </Button>
          <Button
            variant={strong ? 'brand' : 'primary'}
            disabled={busy}
            onClick={() => decide('approve')}
          >
            <Check className="size-4" aria-hidden />
            {chosen ? `Godkjenn som ${chosen.fullName}` : 'Godkjenn som ny person'}
          </Button>
        </div>
      </div>
    </Card>
  )
}

function ProfileOption({
  option: o,
  selected,
  verified,
  onSelect,
}: {
  option: Option
  selected: boolean
  verified: boolean
  onSelect: () => void
}) {
  return (
    <li
      className={cx(
        'flex items-center gap-3 rounded-xl pr-3 ring-1 transition ring-inset',
        selected ? 'bg-white ring-brand-500' : 'ring-stone-200 hover:bg-white',
      )}
    >
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-3 text-left"
      >
        <Avatar name={o.fullName} size="sm" muted />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-sm font-medium text-stone-950">
            <span className="truncate">{o.fullName}</span>
            {verified && (
              <span className="rounded-full bg-emerald-50 px-1.5 py-px text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-600/15 ring-inset">
                Samme e-post
              </span>
            )}
          </span>
          <span className="block text-xs text-stone-500">
            {o.years.length ? `ES ${o.years.join(', ')}` : 'Uten kull'}
          </span>
        </span>
      </button>
      {o.phone && !verified && (
        <a
          href={`tel:${o.phone.replace(/[^+0-9]/g, '')}`}
          className="inline-flex shrink-0 items-center gap-1 text-xs text-stone-500 hover:text-brand-600"
          title="Nummeret fra telefonlista. Ring for å sjekke at det er personen selv."
        >
          <Phone className="size-3.5" aria-hidden /> {o.phone}
        </a>
      )}
    </li>
  )
}

function DecidedRow({ request: r }: { request: AccessRequestView }) {
  const approved = r.status === 'approved'
  return (
    <div className="flex items-center gap-3.5 px-4 py-3">
      <Avatar name={r.fullName} size="sm" muted={!approved} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-stone-950">
          {r.profile?.fullName ?? r.fullName}
        </p>
        <p className="truncate text-xs text-stone-500">{r.email}</p>
      </div>
      <span
        className={cx(
          'rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
          approved
            ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/15'
            : 'bg-stone-100 text-stone-600 ring-stone-300',
        )}
      >
        {approved ? 'Godkjent' : 'Avslått'}
      </span>
      {r.decidedAt && (
        <span className="w-24 text-right text-xs text-stone-500">{timeAgo(r.decidedAt)}</span>
      )}
    </div>
  )
}
