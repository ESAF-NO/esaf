import type { EventTypeSummary } from '@esaf/core'
import { createFileRoute, Link, notFound, useRouter } from '@tanstack/react-router'
import { CalendarDays, CalendarPlus, FileSpreadsheet, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Dialog, DialogActions } from '#/components/Dialog.tsx'
import { EventCreateActions } from '#/components/EventCreate.tsx'
import { emptyEventType, EventTypeDialog } from '#/components/EventForm.tsx'
import { Button, buttonClass, Card, EmptyState, ErrorText } from '#/components/ui.tsx'
import {
  fetchEventTypes,
  newEventType,
  removeEventType,
  saveEventType,
} from '#/lib/events.functions.ts'
import { plural } from '#/lib/format.ts'

export const Route = createFileRoute('/_konto/admin/arrangementer')({
  beforeLoad: ({ context: { viewer } }) => {
    if (!viewer.permissions.includes('profiles.edit')) throw notFound()
  },
  loader: () => fetchEventTypes(),
  head: () => ({ meta: [{ title: 'Arrangementer – Admin – ESAF' }] }),
  component: EventTypesAdmin,
  errorComponent: ({ error }) => (
    <ErrorText>{error instanceof Error ? error.message : 'Noe gikk galt.'}</ErrorText>
  ),
})

/** Gamle lenker til /esaf-helgen sendes hit, så den kan ikke slettes. */
const PROTECTED = 'esaf-helgen'

type Open =
  | { kind: 'new' }
  | { kind: 'edit'; type: EventTypeSummary }
  | { kind: 'delete'; type: EventTypeSummary }
  | null

/**
 * Arrangementene for admins: nye arrangementer og historikk, import av
 * deltakelse fra regneark, og typene (ESAF-helgen, generalforsamling, fagkveld …).
 */
function EventTypesAdmin() {
  const { types } = Route.useLoaderData()
  const router = useRouter()
  const [open, setOpen] = useState<Open>(null)
  const close = () => setOpen(null)

  return (
    <>
      <p className="mb-5 max-w-2xl text-sm text-stone-500">
        Arrangementene ESAF holder oversikt over, og hvem som var der. Deltakere og roller legges
        til på siden for hvert arrangement. Alt logges.
      </p>

      {types.length > 0 && (
        <Card className="mb-4 flex flex-wrap items-center gap-4 p-5">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
            <CalendarPlus className="size-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-stone-950">Legg inn arrangementer</h2>
            <p className="mt-0.5 text-sm text-stone-500">
              Ett om gangen, eller mange tidligere på én gang når du bare vet året eller semesteret,
              f.eks. hver høst fra 2008.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <EventCreateActions types={types} size="sm" />
          </div>
        </Card>
      )}

      <Card className="mb-6 flex flex-wrap items-center gap-4 p-5">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
          <FileSpreadsheet className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-stone-950">Importer deltakelse fra regneark</h2>
          <p className="mt-0.5 text-sm text-stone-500">
            Excel eller CSV med hvem som var på hva. Du ser alle treffene før noe lagres.
          </p>
        </div>
        <Link
          to="/admin/arrangementer/import"
          className={buttonClass({ variant: 'secondary', size: 'sm' })}
        >
          Importer
        </Link>
      </Card>

      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-stone-950">Typer</h2>
        <Button variant="secondary" size="sm" onClick={() => setOpen({ kind: 'new' })}>
          <Plus className="size-4" aria-hidden /> Ny type
        </Button>
      </div>
      {types.length === 0 ? (
        <EmptyState icon={CalendarDays} title="Ingen typer ennå" />
      ) : (
        <Card>
          <ul className="divide-y divide-stone-100">
            {types.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5">
                <div className="min-w-0 flex-1">
                  <Link
                    to="/arrangementer/$typeSlug"
                    params={{ typeSlug: t.slug }}
                    className="font-medium text-stone-950 hover:text-brand-600"
                  >
                    {t.name}
                  </Link>
                  <p className="text-sm text-stone-500 tabular-nums">
                    /arrangementer/{t.slug} · {plural(t.events, 'arrangement', 'arrangementer')} ·
                    rekkefølge {t.sortOrder}
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setOpen({ kind: 'edit', type: t })}
                  >
                    <Pencil className="size-4" aria-hidden /> Rediger
                    <span className="sr-only"> {t.name}</span>
                  </Button>
                  {t.slug !== PROTECTED && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setOpen({ kind: 'delete', type: t })}
                    >
                      <Trash2 className="size-4" aria-hidden /> Slett
                      <span className="sr-only"> {t.name}</span>
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {open?.kind === 'new' && (
        <EventTypeDialog
          title="Ny type"
          initial={emptyEventType}
          submitLabel="Opprett"
          onClose={close}
          onSubmit={async (values) => {
            await newEventType({ data: values })
            await router.invalidate()
            close()
          }}
        />
      )}
      {open?.kind === 'edit' && (
        <EventTypeDialog
          title={`Rediger ${open.type.name}`}
          slug={open.type.slug}
          initial={{
            name: open.type.name,
            plural: open.type.plural ?? '',
            description: open.type.description ?? '',
            sortOrder: open.type.sortOrder,
          }}
          submitLabel="Lagre"
          onClose={close}
          onSubmit={async (values) => {
            await saveEventType({ data: { typeId: open.type.id, values } })
            await router.invalidate()
            close()
          }}
        />
      )}
      {open?.kind === 'delete' && <DeleteDialog type={open.type} onClose={close} />}
    </>
  )
}

function DeleteDialog({ type: t, onClose }: { type: EventTypeSummary; onClose: () => void }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function confirmDelete() {
    setBusy(true)
    setError(null)
    try {
      await removeEventType({ data: { typeId: t.id } })
      await router.invalidate()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke slette.')
      setBusy(false)
    }
  }
  return (
    <Dialog
      title={`Slette ${t.name}?`}
      description={
        t.events > 0 ? (
          <p>
            {t.name} har {plural(t.events, 'arrangement', 'arrangementer')}. Slett dem eller flytt
            dem til en annen type først.
          </p>
        ) : (
          <p>Typen har ingen arrangementer. Det kan ikke angres.</p>
        )
      }
      onClose={onClose}
      busy={busy}
    >
      {error && <ErrorText>{error}</ErrorText>}
      <DialogActions>
        <Button variant="secondary" onClick={onClose} disabled={busy} data-autofocus>
          Avbryt
        </Button>
        <Button variant="destructive" onClick={confirmDelete} disabled={busy || t.events > 0}>
          {busy ? 'Sletter …' : 'Slett typen'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
