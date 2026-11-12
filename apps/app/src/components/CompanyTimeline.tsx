import type { CompanyEvent } from '@esaf/core'
import { Link, useRouter } from '@tanstack/react-router'
import {
  ArrowUpRight,
  Award,
  Banknote,
  Check,
  CircleDot,
  Flag,
  GraduationCap,
  Handshake,
  Pencil,
  Plus,
  Rocket,
  ShieldAlert,
  Sprout,
  Trash2,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { CompanyInput } from './CompanyInput.tsx'
import { Dialog, DialogActions } from './Dialog.tsx'
import { Button, Card, CompanyLogo, cx, ErrorText, Field, Input, Select, Textarea } from './ui.tsx'
import {
  eventTypeLabels,
  eventTypeOrder,
  programmeKindLabels,
  programmeKindOrder,
  type CompanyEventType,
  type ProgrammeKind,
} from '#/lib/companies.ts'
import {
  removeCompanyEvent,
  saveCompanyEvent,
  type CompanyEventFormValues,
} from '#/lib/companies.functions.ts'
import { monthNames, partialDate } from '#/lib/format.ts'

const icons: Record<CompanyEventType, LucideIcon> = {
  founded: Sprout,
  funding: Banknote,
  award: Award,
  launch: Rocket,
  acquired: Handshake,
  bankrupt: XCircle,
  dissolved: XCircle,
  closed: Flag,
  other: CircleDot,
  programme: GraduationCap,
}

const emptyProgramme: NonNullable<CompanyEventFormValues['programme']> = {
  name: '',
  companyId: null,
  kind: 'accelerator',
  batch: '',
}

/** Skjemaverdiene for en hendelse, eller tomme for en ny. */
function formValues(event: CompanyEvent | null): CompanyEventFormValues {
  if (!event) {
    return {
      year: new Date().getFullYear(),
      month: null,
      day: null,
      type: 'other',
      text: '',
      sourceUrl: '',
      sourceLabel: '',
      programme: null,
    }
  }
  const [y, m, d] = event.date.split('-').map(Number)
  return {
    year: y!,
    month: event.datePrecision === 'year' ? null : m!,
    day: event.datePrecision === 'day' ? d! : null,
    type: event.type,
    text: event.text,
    sourceUrl: event.source?.url ?? '',
    sourceLabel: event.source?.label ?? '',
    programme: event.programme
      ? {
          name: event.programme.company?.name ?? '',
          companyId: event.programme.company?.id ?? null,
          kind: event.programme.kind,
          batch: event.programme.batch ?? '',
        }
      : null,
  }
}

/** Programmet, med lenke til siden, typen og kullet. */
function ProgrammeLine({ programme: p }: { programme: NonNullable<CompanyEvent['programme']> }) {
  const detail = [programmeKindLabels[p.kind], p.batch].filter(Boolean).join(' · ')
  if (!p.company) {
    return <p className="mt-1 text-sm text-stone-500">Programmet er slettet · {detail}</p>
  }
  return (
    <Link
      to="/selskaper/$slug"
      params={{ slug: p.company.slug }}
      className="mt-1.5 inline-flex max-w-full items-center gap-2.5 rounded-xl py-1 pr-3 pl-1 ring-1 ring-stone-200 transition ring-inset hover:bg-stone-50"
    >
      <CompanyLogo name={p.company.name} logo={p.company.logo} size="sm" />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-stone-900">{p.company.name}</span>
        <span className="block truncate text-xs text-stone-500">{detail}</span>
      </span>
    </Link>
  )
}

function EventRow({
  event: e,
  canEdit,
  onEdit,
}: {
  event: CompanyEvent
  canEdit: boolean
  onEdit: (event: CompanyEvent) => void
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const Icon = icons[e.type]

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      await router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Noe gikk galt.')
    } finally {
      setBusy(false)
    }
  }

  const remove = () => {
    if (!confirm('Slette hendelsen? Det kan ikke angres.')) return
    void run(() => removeCompanyEvent({ data: { eventId: e.id } }))
  }
  // «Stemmer» lagrer hendelsen som den er; da regnes den som bekreftet.
  const approve = () =>
    run(() => saveCompanyEvent({ data: { eventId: e.id, values: formValues(e) } }))

  return (
    <li className="group/item relative flex gap-3.5 pb-6 last:pb-0">
      {/* Linjen mellom hendelsene. */}
      <span
        className="absolute top-9 bottom-0 left-4 w-px bg-stone-200 group-last/item:hidden"
        aria-hidden
      />
      <span
        className={cx(
          'relative grid size-8 shrink-0 place-items-center rounded-full ring-1 ring-inset',
          e.review
            ? 'bg-amber-50 text-amber-700 ring-amber-200'
            : 'bg-stone-100 text-stone-600 ring-stone-200',
        )}
      >
        <Icon className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 pt-1">
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-stone-500">
          <span className="font-medium text-stone-700 tabular-nums">
            {partialDate(e.date, e.datePrecision)}
          </span>
          <span>{eventTypeLabels[e.type]}</span>
          {e.review && (
            <span className="inline-flex items-center gap-1 font-medium text-amber-700">
              <ShieldAlert className="size-3.5" aria-hidden /> Til gjennomgang
            </span>
          )}
        </p>
        {e.programme && <ProgrammeLine programme={e.programme} />}
        {e.text && <p className="mt-1 text-sm leading-relaxed text-stone-800">{e.text}</p>}
        {(e.source || e.moreSources.length > 0 || canEdit) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-500">
            {e.source &&
              (e.source.url ? (
                <a
                  href={e.source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 hover:text-brand-600"
                >
                  {e.source.label}
                  <ArrowUpRight className="size-3" aria-hidden />
                </a>
              ) : (
                <span>{e.source.label}</span>
              ))}
            {e.moreSources.map((m) =>
              m.url ? (
                <a
                  key={m.url}
                  href={m.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 hover:text-brand-600"
                >
                  {m.label}
                  <ArrowUpRight className="size-3" aria-hidden />
                </a>
              ) : (
                <span key={m.label}>{m.label}</span>
              ),
            )}
            {canEdit && (
              <span className="flex items-center gap-1">
                {e.review && (
                  <Button variant="ghost" size="sm" onClick={approve} disabled={busy}>
                    <Check className="size-3.5" aria-hidden /> Stemmer
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onEdit(e)}
                  disabled={busy}
                  aria-label="Rediger hendelsen"
                >
                  <Pencil className="size-3.5" aria-hidden />
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={remove}
                  disabled={busy}
                  aria-label="Slett hendelsen"
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              </span>
            )}
          </div>
        )}
        {error && (
          <div className="mt-2">
            <ErrorText>{error}</ErrorText>
          </div>
        )}
      </div>
    </li>
  )
}

function EventList(props: {
  events: CompanyEvent[]
  canEdit: boolean
  onEdit: (event: CompanyEvent) => void
}) {
  return (
    <ol className="mt-4">
      {props.events.map((e) => (
        <EventRow key={e.id} event={e} canEdit={props.canEdit} onEdit={props.onEdit} />
      ))}
    </ol>
  )
}

/**
 * Historikken på selskapssiden, nyeste først. De som kan redigere selskapet, kan
 * legge til, rette og slette hendelser, og ser usikre hendelser fra importen
 * («til gjennomgang») for seg.
 */
export function CompanyTimeline({
  companyId,
  name,
  events,
  canEdit,
  adminEdit,
}: {
  companyId: string
  name: string
  events: CompanyEvent[]
  /** Kan rette og slette. Alle medlemmer kan legge til. */
  canEdit: boolean
  /** Redigerer som admin uten å være knyttet til selskapet; endringer logges. */
  adminEdit: boolean
}) {
  const [editing, setEditing] = useState<CompanyEvent | 'new' | null>(null)
  const confirmed = events.filter((e) => !e.review)
  const review = events.filter((e) => e.review)

  return (
    <Card className="p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-stone-950">Historikk</h2>
        <Button variant="secondary" size="sm" onClick={() => setEditing('new')}>
          <Plus className="size-4" aria-hidden /> Legg til
        </Button>
      </div>
      {confirmed.length > 0 ? (
        <EventList events={confirmed} canEdit={canEdit} onEdit={setEditing} />
      ) : (
        <p className="mt-2 text-sm text-stone-500">
          Ingen hendelser ennå. Legg til når {name} ble grunnlagt, var med i en akselerator, fikk
          kapital, vant priser eller lanserte noe.
        </p>
      )}
      {review.length > 0 && (
        <details className="mt-6 rounded-xl bg-amber-50/60 p-4 ring-1 ring-amber-200 ring-inset">
          <summary className="cursor-pointer text-sm font-medium text-amber-900">
            Til gjennomgang ({review.length})
          </summary>
          <p className="mt-2 text-xs leading-relaxed text-amber-900/80">
            Hentet automatisk fra nyhetssaker og registre, og ikke sjekket av noen. Bare de som kan
            redigere {name}, ser dem. Trykk «Stemmer» for å vise en hendelse for alle, eller slett
            den.
          </p>
          <EventList events={review} canEdit={canEdit} onEdit={setEditing} />
        </details>
      )}
      {editing && (
        <EventDialog
          companyId={companyId}
          event={editing === 'new' ? null : editing}
          adminEdit={adminEdit}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  )
}

function EventDialog({
  companyId,
  event,
  adminEdit,
  onClose,
}: {
  companyId: string
  event: CompanyEvent | null
  adminEdit: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const [values, setValues] = useState(() => formValues(event))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const set = (patch: Partial<CompanyEventFormValues>) => setValues((v) => ({ ...v, ...patch }))
  const thisYear = new Date().getFullYear()
  const programme = values.type === 'programme' ? (values.programme ?? emptyProgramme) : null
  const setProgramme = (patch: Partial<NonNullable<CompanyEventFormValues['programme']>>) =>
    set({ programme: { ...(values.programme ?? emptyProgramme), ...patch } })

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const data = { ...values, programme }
      await saveCompanyEvent({
        data: event ? { eventId: event.id, values: data } : { companyId, values: data },
      })
      await router.invalidate()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke lagre.')
      setSaving(false)
    }
  }

  return (
    <Dialog
      title={event ? 'Rediger hendelse' : 'Ny hendelse'}
      description={
        adminEdit
          ? 'Du redigerer som admin, og endringen logges.'
          : event
            ? undefined
            : 'Hendelsen vises for alle medlemmer med en gang.'
      }
      onClose={onClose}
      busy={saving}
      className="max-w-lg"
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_6rem_minmax(0,1fr)_5rem]">
          <Field label="Hva">
            <Select
              value={values.type}
              onChange={(e) => set({ type: e.target.value as CompanyEventType })}
              data-autofocus
            >
              {eventTypeOrder.map((t) => (
                <option key={t} value={t}>
                  {eventTypeLabels[t]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="År">
            <Input
              value={values.year || ''}
              onChange={(e) => set({ year: Number(e.target.value.replace(/\D/g, '').slice(0, 4)) })}
              inputMode="numeric"
              pattern="[0-9]{4}"
              maxLength={4}
              placeholder={String(thisYear)}
              required
            />
          </Field>
          <Field label="Måned">
            <Select
              value={values.month ?? ''}
              onChange={(e) =>
                set({
                  month: e.target.value ? Number(e.target.value) : null,
                  ...(e.target.value ? {} : { day: null }),
                })
              }
            >
              <option value="">Ukjent</option>
              {monthNames.map((m, i) => (
                <option key={m} value={i + 1}>
                  {m}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Dag">
            <Input
              value={values.day ?? ''}
              onChange={(e) => {
                const digits = e.target.value.replace(/\D/g, '').slice(0, 2)
                set({ day: digits ? Number(digits) : null })
              }}
              inputMode="numeric"
              maxLength={2}
              disabled={values.month === null}
            />
          </Field>
        </div>
        {programme && (
          <div className="grid gap-4 sm:grid-cols-2">
            <CompanyInput
              className="sm:col-span-2"
              label="Program"
              value={{ name: programme.name, companyId: programme.companyId }}
              onChange={(v) => setProgramme({ name: v.name, companyId: v.companyId })}
              placeholder="Y Combinator, StartupLab, 6am …"
              excludeId={companyId}
            />
            <Field label="Type">
              <Select
                value={programme.kind}
                onChange={(e) => setProgramme({ kind: e.target.value as ProgrammeKind })}
              >
                {programmeKindOrder.map((k) => (
                  <option key={k} value={k}>
                    {programmeKindLabels[k]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Kull" hint="Valgfritt.">
              <Input
                value={programme.batch}
                onChange={(e) => setProgramme({ batch: e.target.value })}
                maxLength={40}
                placeholder="W22"
              />
            </Field>
          </div>
        )}
        <Field
          label={programme ? 'Mer om det' : 'Hva skjedde'}
          hint={programme ? 'Valgfritt.' : undefined}
        >
          <Textarea
            value={values.text}
            onChange={(e) => set({ text: e.target.value })}
            rows={3}
            maxLength={500}
            required={!programme}
            placeholder={
              programme
                ? 'Tre måneder i San Francisco, avsluttet med Demo Day.'
                : 'Hentet 12 MNOK fra Investinor og Equinor Ventures.'
            }
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Lenke til kilden" hint="Valgfritt, f.eks. en nyhetssak.">
            <Input
              value={values.sourceUrl}
              onChange={(e) => set({ sourceUrl: e.target.value })}
              inputMode="url"
              maxLength={500}
            />
          </Field>
          <Field label="Navn på kilden" hint="Tomt gir domenet i lenken.">
            <Input
              value={values.sourceLabel}
              onChange={(e) => set({ sourceLabel: e.target.value })}
              maxLength={80}
            />
          </Field>
        </div>
        {error && <ErrorText>{error}</ErrorText>}
        <DialogActions>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Avbryt
          </Button>
          <Button type="submit" variant="brand" disabled={saving}>
            {saving ? 'Lagrer …' : 'Lagre'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}
