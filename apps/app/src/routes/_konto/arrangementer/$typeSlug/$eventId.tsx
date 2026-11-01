import type { BadgeChip, EventDetails, EventParticipant, EventRole } from '@esaf/core'
import { createFileRoute, Link, redirect, useNavigate, useRouter } from '@tanstack/react-router'
import { ArrowLeft, Check, CircleCheck, MapPin, Pencil, Tent, Trash2, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { z } from 'zod'
import { DocumentsCard, EventAlbum } from '#/components/Attachments.tsx'
import { NewBadgesDialog } from '#/components/Badges.tsx'
import { RoleBadge } from '#/components/EventCharts.tsx'
import { EventDialog } from '#/components/EventForm.tsx'
import { EventParticipantsAdmin } from '#/components/EventParticipantsAdmin.tsx'
import { StrongAuthCallout } from '#/components/StrongAuth.tsx'
import { Dialog, DialogActions } from '#/components/Dialog.tsx'
import {
  Avatar,
  Button,
  buttonClass,
  Card,
  cx,
  ErrorText,
  Field,
  Select,
  Textarea,
  Verified,
} from '#/components/ui.tsx'
import { fetchCommunity } from '#/lib/feed.functions.ts'
import { plural } from '#/lib/format.ts'
import { eventWhen, roleLabels, roleOrder, roleSummary } from '#/lib/events.ts'
import {
  fetchEvent,
  fetchEventTypeOptions,
  removeEvent,
  removeParticipant,
  saveEvent,
  saveParticipant,
  setParticipated,
} from '#/lib/events.functions.ts'

export const Route = createFileRoute('/_konto/arrangementer/$typeSlug/$eventId')({
  // Satt når admin nettopp har opprettet arrangementet, så neste steg vises.
  validateSearch: z.object({ opprettet: z.boolean().optional().catch(undefined) }),
  loader: async ({ params, context: { viewer } }) => {
    const admin = viewer.permissions.includes('profiles.edit')
    const [event, community, types] = await Promise.all([
      fetchEvent({ data: { eventId: params.eventId } }),
      // Kullene til «Legg til hele kullet» og typene til «Rediger», bare for admins.
      admin ? fetchCommunity() : null,
      admin ? fetchEventTypeOptions() : [],
    ])
    // Har arrangementet byttet type, sendes lenken dit det hører hjemme nå.
    if (event.type.slug !== params.typeSlug) {
      throw redirect({
        to: '/arrangementer/$typeSlug/$eventId',
        params: { typeSlug: event.type.slug, eventId: event.id },
        search: true,
        replace: true,
      })
    }
    return { event, types, cohortYears: community?.cohorts.map((c) => c.graduationYear) ?? [] }
  },
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.event.name ?? 'Arrangement'} – ESAF` }],
  }),
  component: EventPage,
  notFoundComponent: EventNotFound,
})

const sourceLabels = {
  self: 'Meldte seg selv',
  admin: 'Lagt inn av admin',
  import: 'Fra liste eller regneark',
} as const

function EventPage() {
  const { event: w, types, cohortYears } = Route.useLoaderData()
  const { opprettet } = Route.useSearch()
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const router = useRouter()
  const navigate = useNavigate()
  const cohorts = w.groups.filter((g) => g.graduationYear !== null).length
  const roles = roleSummary(w.roles)

  return (
    <div className="mx-auto max-w-5xl">
      <Link
        to="/arrangementer/$typeSlug"
        params={{ typeSlug: w.type.slug }}
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-900"
      >
        <ArrowLeft className="size-4" aria-hidden /> {w.type.plural ?? w.type.name}
      </Link>

      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-stone-950 sm:text-[28px]">
            {w.name}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-stone-500 tabular-nums">
            <span>{eventWhen(w)}</span>
            {w.location && (
              <span className="inline-flex items-center gap-1">
                <MapPin className="size-3.5" aria-hidden /> {w.location}
              </span>
            )}
            {!w.upcoming && (
              <span>
                {plural(w.participants, 'deltaker', 'deltakere')}
                {cohorts > 0 && ` fra ${plural(cohorts, 'kull', 'kull')}`}
              </span>
            )}
            {!w.upcoming && roles && <span>{roles}</span>}
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

      {opprettet && w.canManage && <CreatedNotice event={w} />}
      <StrongAuthCallout className="mb-6">
        legge til deltakere og roller, eller rette arrangementet
      </StrongAuthCallout>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-8">
          {w.description && (
            <p className="text-[15px] leading-relaxed whitespace-pre-line text-stone-700">
              {w.description}
            </p>
          )}
          <EventAlbum
            eventId={w.id}
            photos={w.photos}
            canUpload={w.canUploadPhotos}
            upcoming={w.upcoming}
            max={1000}
          />
          <Participants event={w} />
        </div>
        <aside className="space-y-4">
          <SelfToggle event={w} />
          <DocumentsCard
            target={{ til: 'arrangement', id: w.id }}
            documents={w.documents}
            canUpload={w.canUploadDocuments}
            max={30}
            emptyText="Ingen dokumenter ennå. Legg ut program, referat eller presentasjoner."
            uploadHint="Arrangørene og admins kan laste opp. PDF, Word, Excel, PowerPoint, tekst, CSV eller bilder, maks 25 MB."
          />
          {w.canManage && !w.upcoming && (
            <EventParticipantsAdmin eventId={w.id} cohortYears={cohortYears} />
          )}
        </aside>
      </div>

      {editing && (
        <EventDialog
          title="Rediger arrangementet"
          types={types}
          initial={{
            typeId: w.type.id,
            name: w.name,
            startDate: w.startDate,
            endDate: w.endDate,
            datePrecision: w.datePrecision,
            location: w.location ?? '',
            description: w.description ?? '',
          }}
          submitLabel="Lagre"
          onClose={() => setEditing(false)}
          onSubmit={async (values) => {
            const { typeSlug } = await saveEvent({ data: { eventId: w.id, values } })
            if (typeSlug !== w.type.slug) {
              await navigate({
                to: '/arrangementer/$typeSlug/$eventId',
                params: { typeSlug, eventId: w.id },
                replace: true,
              })
            } else {
              await router.invalidate()
            }
            setEditing(false)
          }}
        />
      )}
      {deleting && <DeleteDialog event={w} onClose={() => setDeleting(false)} />}
    </div>
  )
}

/** Rett etter «Opprett»: hva admin gjør nå. */
function CreatedNotice({ event: w }: { event: EventDetails }) {
  return (
    <div
      role="status"
      className="mb-6 flex gap-3 rounded-2xl bg-emerald-50 p-4 text-sm text-emerald-900 ring-1 ring-emerald-200 ring-inset"
    >
      <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p>
        {w.name} er opprettet.{' '}
        {w.upcoming
          ? 'Deltakere kan legges til når det har startet.'
          : 'Legg til hvem som var der under «Legg til deltakere»: lim inn en liste, søk opp én og én, eller ta med et helt kull. Velg rollen (arrangør, foredragsholder, frivillig) før du legger til, eller endre den med blyanten på hver deltaker etterpå.'}
      </p>
    </div>
  )
}

/** «Jeg var der»: gjelder den innloggede selv, og lagres med en gang. */
function SelfToggle({ event: w }: { event: EventDetails }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [earned, setEarned] = useState<BadgeChip[]>([])

  async function toggle(participated: boolean) {
    if (
      !participated &&
      w.myRole &&
      !confirm(`Du står som ${roleLabels[w.myRole].toLocaleLowerCase('nb')}. Fjerne deg fra lista?`)
    ) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { badges } = await setParticipated({ data: { eventId: w.id, participated } })
      await router.invalidate()
      setEarned(badges)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke lagre.')
    } finally {
      setBusy(false)
    }
  }

  if (w.upcoming) {
    return (
      <Card className="p-5 text-sm text-stone-600">
        Arrangementet har ikke vært ennå. Når det har startet, kan du si at du var der.
      </Card>
    )
  }
  return (
    <Card className="p-5">
      {w.participated ? (
        <>
          <p className="flex items-center gap-2 text-sm font-medium text-stone-900">
            <span className="grid size-6 place-items-center rounded-full bg-brand-600 text-white">
              <Check className="size-3.5" aria-hidden />
            </span>
            Du var der
            <RoleBadge role={w.myRole} />
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
      {!!earned.length && <NewBadgesDialog badges={earned} onClose={() => setEarned([])} />}
    </Card>
  )
}

function Participants({ event: w }: { event: EventDetails }) {
  const [editing, setEditing] = useState<EventParticipant | null>(null)
  if (w.upcoming) return null
  if (w.participants === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-stone-300 px-4 py-10 text-center text-sm text-stone-500">
        {w.canManage
          ? 'Ingen deltakere ennå. Legg dem til under «Legg til deltakere», så vises de her etter kull, med rollene.'
          : 'Ingen har sagt at de var der ennå.'}
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
              <ParticipantChip
                key={p.personId}
                eventId={w.id}
                person={p}
                canManage={w.canManage}
                onEdit={() => setEditing(p)}
              />
            ))}
          </ul>
        </section>
      ))}
      {editing && (
        <ParticipantDialog eventId={w.id} person={editing} onClose={() => setEditing(null)} />
      )}
    </div>
  )
}

/** Rollen og notatet til én deltaker. Bare for admins; logges. */
function ParticipantDialog({
  eventId,
  person: p,
  onClose,
}: {
  eventId: string
  person: EventParticipant
  onClose: () => void
}) {
  const router = useRouter()
  const [role, setRole] = useState<EventRole | null>(p.role)
  const [note, setNote] = useState(p.note ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await saveParticipant({ data: { eventId, personId: p.personId, role, note } })
      await router.invalidate()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke lagre.')
      setBusy(false)
    }
  }
  return (
    <Dialog
      title={p.fullName}
      description={<p>Rolle og notat på arrangementet.</p>}
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Rolle">
          <Select
            data-autofocus
            value={role ?? ''}
            onChange={(e) => setRole((e.target.value || null) as EventRole | null)}
          >
            <option value="">Deltaker</option>
            {roleOrder.map((r) => (
              <option key={r} value={r}>
                {roleLabels[r]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Notat" hint="Valgfritt. Vises bare for admins.">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
        </Field>
        {error && <ErrorText>{error}</ErrorText>}
        <DialogActions>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Avbryt
          </Button>
          <Button type="submit" variant="brand" disabled={busy}>
            {busy ? 'Lagrer …' : 'Lagre'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

function ParticipantChip({
  eventId,
  person: p,
  canManage,
  onEdit,
}: {
  eventId: string
  person: EventParticipant
  canManage: boolean
  onEdit: () => void
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const inactive = canManage && p.status !== 'active'

  async function remove() {
    if (!confirm(`Fjerne ${p.fullName} fra arrangementet?`)) return
    setBusy(true)
    try {
      await removeParticipant({ data: { eventId, personId: p.personId } })
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
          <RoleBadge role={p.role} className="ml-0.5" />
        </span>
        {canManage && (
          <span className="block truncate text-[11px] text-stone-500" title={p.note ?? undefined}>
            {p.source && sourceLabels[p.source]}
            {inactive && ' · ikke aktivt medlem, vises ikke'}
            {p.note && ` · ${p.note}`}
          </span>
        )}
      </span>
      {canManage && (
        <button
          type="button"
          onClick={onEdit}
          aria-label={`Endre rollen til ${p.fullName}`}
          className="grid size-7 shrink-0 place-items-center rounded-lg text-stone-400 transition hover:bg-stone-100 hover:text-stone-900"
        >
          <Pencil className="size-3.5" aria-hidden />
        </button>
      )}
      {canManage && (
        <button
          type="button"
          onClick={remove}
          disabled={busy}
          aria-label={`Fjern ${p.fullName} fra arrangementet`}
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

function DeleteDialog({ event: w, onClose }: { event: EventDetails; onClose: () => void }) {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function confirmDelete() {
    setBusy(true)
    setError(null)
    try {
      const { typeSlug } = await removeEvent({ data: { eventId: w.id } })
      await navigate({ to: '/arrangementer/$typeSlug', params: { typeSlug } })
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
          Arrangementet og deltakelsen slettes
          {w.participants > 0 && `, også for ${plural(w.participants, 'deltaker', 'deltakere')}`}.
          Det kan ikke angres.
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
          {busy ? 'Sletter …' : 'Slett arrangementet'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

function EventNotFound() {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-xl font-semibold tracking-tight text-stone-950">
        Fant ikke arrangementet
      </h1>
      <p className="mt-2 text-sm text-stone-500">Det kan ha blitt slettet.</p>
      <Link
        to="/arrangementer"
        className={buttonClass({ variant: 'secondary', size: 'sm' }, 'mt-6')}
      >
        Se alle arrangementer
      </Link>
    </div>
  )
}
