import type { WeekendAttendee, WeekendDetails } from '@esaf/core'
import { createFileRoute, Link, useNavigate, useRouter } from '@tanstack/react-router'
import { ArrowLeft, Check, MapPin, Pencil, Tent, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { Dialog, DialogActions } from '#/components/Dialog.tsx'
import { Avatar, Button, buttonClass, Card, cx, ErrorText, Verified } from '#/components/ui.tsx'
import { WeekendAttendanceAdmin } from '#/components/WeekendAttendanceAdmin.tsx'
import { WeekendDialog } from '#/components/WeekendForm.tsx'
import { fetchCommunity } from '#/lib/feed.functions.ts'
import { dateRange, plural } from '#/lib/format.ts'
import {
  fetchWeekend,
  removeAttendee,
  removeWeekend,
  saveWeekend,
  setAttended,
} from '#/lib/weekends.functions.ts'

export const Route = createFileRoute('/_konto/esaf-helgen/$weekendId')({
  loader: async ({ params, context: { viewer } }) => {
    const [weekend, community] = await Promise.all([
      fetchWeekend({ data: { weekendId: params.weekendId } }),
      // Kullene til «Legg til hele kullet», bare for admins.
      viewer.permissions.includes('profiles.edit') ? fetchCommunity() : null,
    ])
    return { weekend, cohortYears: community?.cohorts.map((c) => c.graduationYear) ?? [] }
  },
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.weekend.name ?? 'ESAF-helgen'} – ESAF` }],
  }),
  component: WeekendPage,
  notFoundComponent: WeekendNotFound,
})

const sourceLabels = {
  self: 'Meldte seg selv',
  admin: 'Lagt inn av admin',
  import: 'Fra innlimt liste',
} as const

function WeekendPage() {
  const { weekend: w, cohortYears } = Route.useLoaderData()
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const router = useRouter()
  const cohorts = w.groups.filter((g) => g.graduationYear !== null).length

  return (
    <div className="mx-auto max-w-5xl">
      <Link
        to="/esaf-helgen"
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-900"
      >
        <ArrowLeft className="size-4" aria-hidden /> ESAF-helgen
      </Link>

      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-stone-950 sm:text-[28px]">
            {w.name}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-stone-500 tabular-nums">
            <span>{dateRange(w.startDate, w.endDate)}</span>
            {w.location && (
              <span className="inline-flex items-center gap-1">
                <MapPin className="size-3.5" aria-hidden /> {w.location}
              </span>
            )}
            {!w.upcoming && (
              <span>
                {plural(w.attendees, 'deltaker', 'deltakere')}
                {cohorts > 0 && ` fra ${plural(cohorts, 'kull', 'kull')}`}
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {w.canManage && (
            <>
              <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                <Pencil className="size-4" aria-hidden /> Rediger
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setDeleting(true)}>
                <Trash2 className="size-4" aria-hidden /> Slett
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-8">
          {w.description && (
            <p className="text-[15px] leading-relaxed whitespace-pre-line text-stone-700">
              {w.description}
            </p>
          )}
          <Attendees weekend={w} />
        </div>
        <aside className="space-y-4">
          <SelfToggle weekend={w} />
          {w.canManage && !w.upcoming && (
            <WeekendAttendanceAdmin weekendId={w.id} cohortYears={cohortYears} />
          )}
        </aside>
      </div>

      {editing && (
        <WeekendDialog
          title="Rediger helgen"
          initial={{
            name: w.name,
            startDate: w.startDate,
            endDate: w.endDate,
            location: w.location ?? '',
            description: w.description ?? '',
          }}
          submitLabel="Lagre"
          onClose={() => setEditing(false)}
          onSubmit={async (values) => {
            await saveWeekend({ data: { weekendId: w.id, values } })
            await router.invalidate()
            setEditing(false)
          }}
        />
      )}
      {deleting && <DeleteDialog weekend={w} onClose={() => setDeleting(false)} />}
    </div>
  )
}

/** «Jeg var der»: gjelder den innloggede selv, og lagres med en gang. */
function SelfToggle({ weekend: w }: { weekend: WeekendDetails }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function toggle(attended: boolean) {
    setBusy(true)
    setError(null)
    try {
      await setAttended({ data: { weekendId: w.id, attended } })
      await router.invalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke lagre.')
    } finally {
      setBusy(false)
    }
  }

  if (w.upcoming) {
    return (
      <Card className="p-5 text-sm text-stone-600">
        Helgen har ikke vært ennå. Når den har startet, kan du si at du var der.
      </Card>
    )
  }
  return (
    <Card className="p-5">
      {w.attended ? (
        <>
          <p className="flex items-center gap-2 text-sm font-medium text-stone-900">
            <span className="grid size-6 place-items-center rounded-full bg-brand-600 text-white">
              <Check className="size-3.5" aria-hidden />
            </span>
            Du var der
          </p>
          <p className="mt-1 text-sm text-stone-500">
            Du står på lista og telles med på profilen din.
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => toggle(false)}
            disabled={busy}
            className="mt-3 -ml-3"
          >
            <X className="size-4" aria-hidden /> {busy ? 'Fjerner …' : 'Jeg var ikke der'}
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm font-medium text-stone-900">Var du der?</p>
          <p className="mt-1 text-sm text-stone-500">
            Legg deg til, så telles du med her og på profilen din.
          </p>
          <Button
            variant="brand"
            onClick={() => toggle(true)}
            disabled={busy}
            className="mt-3 w-full"
          >
            <Tent className="size-4" aria-hidden /> {busy ? 'Lagrer …' : 'Jeg var der'}
          </Button>
        </>
      )}
      {error && (
        <div className="mt-3">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
    </Card>
  )
}

function Attendees({ weekend: w }: { weekend: WeekendDetails }) {
  if (w.upcoming) return null
  if (w.attendees === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-stone-300 px-4 py-10 text-center text-sm text-stone-500">
        Ingen har sagt at de var der ennå.
      </p>
    )
  }
  return (
    <div className="space-y-6">
      {w.groups.map((g) => (
        <section key={g.graduationYear ?? 'uten'} aria-labelledby={`kull-${g.graduationYear}`}>
          <h2
            id={`kull-${g.graduationYear}`}
            className="mb-2.5 flex items-baseline gap-2 text-sm font-semibold text-stone-950"
          >
            {g.graduationYear ? (
              <Link
                to="/kull/$year"
                params={{ year: g.graduationYear }}
                className="tabular-nums hover:text-brand-600"
              >
                ES {g.graduationYear}
              </Link>
            ) : (
              'Uten kull'
            )}
            <span className="text-xs font-normal text-stone-500 tabular-nums">
              {g.people.length}
            </span>
          </h2>
          <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {g.people.map((p) => (
              <AttendeeChip key={p.personId} weekendId={w.id} person={p} canManage={w.canManage} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function AttendeeChip({
  weekendId,
  person: p,
  canManage,
}: {
  weekendId: string
  person: WeekendAttendee
  canManage: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const inactive = canManage && p.status !== 'active'

  async function remove() {
    if (!confirm(`Fjerne ${p.fullName} fra helgen?`)) return
    setBusy(true)
    try {
      await removeAttendee({ data: { weekendId, personId: p.personId } })
      await router.invalidate()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Kunne ikke fjerne.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="flex items-center gap-2.5 rounded-xl bg-white px-3 py-2 shadow-card ring-1 ring-stone-200/70">
      <Avatar name={p.fullName} photo={p.photo} size="sm" muted={!p.claimed || inactive} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1 text-sm">
          {inactive ? (
            <span className="truncate text-stone-500">{p.fullName}</span>
          ) : (
            <Link
              to="/medlemmer/$personId"
              params={{ personId: p.personId }}
              className="truncate font-medium text-stone-900 hover:text-brand-600"
            >
              {p.fullName}
            </Link>
          )}
          <Verified claimed={p.claimed} />
        </span>
        {canManage && (
          <span className="block text-[11px] text-stone-500">
            {p.source && sourceLabels[p.source]}
            {inactive && ' · ikke aktivt medlem, vises ikke'}
          </span>
        )}
      </span>
      {canManage && (
        <button
          type="button"
          onClick={remove}
          disabled={busy}
          aria-label={`Fjern ${p.fullName} fra helgen`}
          className={cx(
            'grid size-7 shrink-0 place-items-center rounded-lg text-stone-400 transition hover:bg-stone-100 hover:text-red-600 disabled:opacity-50',
          )}
        >
          <X className="size-4" aria-hidden />
        </button>
      )}
    </li>
  )
}

function DeleteDialog({ weekend: w, onClose }: { weekend: WeekendDetails; onClose: () => void }) {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function confirmDelete() {
    setBusy(true)
    setError(null)
    try {
      await removeWeekend({ data: { weekendId: w.id } })
      await navigate({ to: '/esaf-helgen' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke slette.')
      setBusy(false)
    }
  }
  return (
    <Dialog
      title={`Slette ${w.name}?`}
      description={
        <p>
          Helgen og oppmøtet slettes
          {w.attendees > 0 && `, også for ${plural(w.attendees, 'deltaker', 'deltakere')}`}. Det kan
          ikke angres.
        </p>
      }
      onClose={onClose}
      busy={busy}
    >
      {error && <ErrorText>{error}</ErrorText>}
      <DialogActions>
        <Button variant="secondary" onClick={onClose} disabled={busy} data-autofocus>
          Avbryt
        </Button>
        <Button variant="destructive" onClick={confirmDelete} disabled={busy}>
          {busy ? 'Sletter …' : 'Slett helgen'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

function WeekendNotFound() {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-xl font-semibold tracking-tight text-stone-950">Fant ikke helgen</h1>
      <p className="mt-2 text-sm text-stone-500">Den kan ha blitt slettet.</p>
      <Link to="/esaf-helgen" className={buttonClass({ variant: 'secondary', size: 'sm' }, 'mt-6')}>
        Se alle helgene
      </Link>
    </div>
  )
}
