import type {
  EventDecision,
  ImportEventPreview,
  ParticipationLayout,
  ParticipationPlan,
  ParticipationPreview,
  RoleChoice,
} from '@esaf/core'
import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { ArrowLeft, Check, CircleCheck, Plus } from 'lucide-react'
import { useState } from 'react'
import { FilePicker } from '#/components/import/FilePicker.tsx'
import { layoutLabels, roleChoiceLabels, roleLabel, shortDate } from '#/components/import/labels.ts'
import {
  openPeople,
  PeopleResolver,
  type PersonDecisions,
} from '#/components/import/PeopleResolver.tsx'
import { ExampleSheet, Issues, StepTitle, Totals } from '#/components/import/Summary.tsx'
import { Button, Card, cx, ErrorText, Field, Input, Select } from '#/components/ui.tsx'
import { plural } from '#/lib/format.ts'
import { postImport } from '#/lib/import-client.ts'

export const Route = createFileRoute('/_konto/admin/arrangementer_/import')({
  beforeLoad: ({ context: { viewer } }) => {
    if (!viewer.permissions.includes('profiles.edit')) throw notFound()
  },
  head: () => ({ meta: [{ title: 'Importer deltakelse – Admin – ESAF' }] }),
  component: ImportParticipation,
})

const URL = '/api/import/deltakelse'

type Options = {
  layout?: ParticipationLayout
  sheet?: string
  roleMap: Record<string, RoleChoice>
  eventColumns?: number[]
  typeId?: string | null
}

type EventDecisions = Record<string, EventDecision>

const deltakelser = (n: number) => plural(n, 'deltakelse', 'deltakelser')

/** Valget for et arrangement: admins valg, ellers et sikkert treff, ellers ingenting. */
function eventDecision(e: ImportEventPreview, decisions: EventDecisions): EventDecision | null {
  return (
    decisions[e.key] ??
    (e.status === 'matched' ? { kind: 'existing', eventId: e.candidates[0]!.id } : null)
  )
}

/** Bare valgene for personer og arrangementer som fortsatt står i arket. */
function keep<T>(decisions: Record<string, T>, keys: string[]) {
  const set = new Set(keys)
  return Object.fromEntries(Object.entries(decisions).filter(([k]) => set.has(k)))
}

/**
 * Import av deltakelse fra et regneark: last opp, se over hvordan arket er
 * tolket og hvem og hva det treffer, se nøyaktig hva som blir lagret, og lagre.
 * Ingenting lagres før det siste steget, og da i én transaksjon.
 */
function ImportParticipation() {
  const [file, setFile] = useState<File | null>(null)
  const [options, setOptions] = useState<Options>({ roleMap: {} })
  const [preview, setPreview] = useState<ParticipationPreview | null>(null)
  const [people, setPeople] = useState<PersonDecisions>({})
  const [events, setEvents] = useState<EventDecisions>({})
  const [plan, setPlan] = useState<ParticipationPlan | null>(null)
  const [saved, setSaved] = useState<ParticipationPlan | null>(null)
  const [busy, setBusy] = useState<'forhandsvis' | 'prov' | 'lagre' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function runPreview(f: File, next: Options) {
    setBusy('forhandsvis')
    setError(null)
    setPlan(null)
    try {
      const result = await postImport<ParticipationPreview>(URL, f, 'forhandsvis', next)
      setPreview(result)
      setOptions({ ...next, typeId: result.typeId })
      setPeople((d) =>
        keep(
          d,
          result.people.map((p) => p.key),
        ),
      )
      setEvents((d) =>
        keep(
          d,
          result.events.map((e) => e.key),
        ),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke lese fila.')
    } finally {
      setBusy(null)
    }
  }

  function change(patch: Partial<Options>) {
    if (file) void runPreview(file, { ...options, ...patch })
  }

  function decisions() {
    return { people, events }
  }

  async function review() {
    if (!file) return
    setBusy('prov')
    setError(null)
    try {
      setPlan(await postImport<ParticipationPlan>(URL, file, 'prov', options, decisions()))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke lage oversikten.')
    } finally {
      setBusy(null)
    }
  }

  async function save() {
    if (!file) return
    setBusy('lagre')
    setError(null)
    try {
      setSaved(await postImport<ParticipationPlan>(URL, file, 'lagre', options, decisions()))
      setPlan(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke lagre.')
    } finally {
      setBusy(null)
    }
  }

  function reset() {
    setFile(null)
    setPreview(null)
    setPlan(null)
    setSaved(null)
    setPeople({})
    setEvents({})
    setOptions({ roleMap: {} })
  }

  if (saved) {
    return (
      <div className="max-w-3xl space-y-4">
        <Back />
        <Card className="p-6">
          <p className="flex items-center gap-2 font-medium text-stone-950">
            <CircleCheck className="size-5 text-emerald-600" aria-hidden /> Importen er lagret
          </p>
          <p className="mt-1 text-sm text-stone-600" role="status">
            {[
              `${deltakelser(saved.totals.added)} lagt til`,
              saved.totals.updated && `${saved.totals.updated} endret`,
              saved.totals.unchanged && `${saved.totals.unchanged} fantes fra før`,
              saved.totals.eventsCreated &&
                `${plural(saved.totals.eventsCreated, 'nytt arrangement', 'nye arrangementer')}`,
              saved.totals.profilesCreated &&
                `${plural(saved.totals.profilesCreated, 'ny profil', 'nye profiler')}`,
            ]
              .filter(Boolean)
              .join(' · ')}
            . Alt står i loggen.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link
              to="/arrangementer"
              className="inline-flex h-10 items-center rounded-lg bg-stone-900 px-4 text-sm font-medium text-white hover:bg-stone-800"
            >
              Se arrangementene
            </Link>
            <Button variant="secondary" onClick={reset}>
              Importer en fil til
            </Button>
          </div>
        </Card>
      </div>
    )
  }

  const openPersons = preview ? openPeople(preview.people, people).length : 0
  const openEvents = preview
    ? preview.events.filter((e) => eventDecision(e, events) === null).length
    : 0

  return (
    <div className="space-y-6">
      <Back />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-6">
          <Card className="space-y-4 p-5">
            <StepTitle n={1}>Velg regnearket</StepTitle>
            <FilePicker
              file={file}
              disabled={busy !== null}
              onFile={(f) => {
                setFile(f)
                setSaved(null)
                setPeople({})
                setEvents({})
                const next = { roleMap: {}, typeId: options.typeId }
                setOptions(next)
                void runPreview(f, next)
              }}
            />
            {busy === 'forhandsvis' && (
              <p className="text-sm text-stone-500" role="status">
                Leser arket …
              </p>
            )}
          </Card>

          {error && <ErrorText>{error}</ErrorText>}

          {preview && file && (
            <>
              <Card className="space-y-4 p-5">
                <StepTitle n={2}>Sjekk hvordan arket er lest</StepTitle>
                <p className="text-sm text-stone-600">{preview.reason}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Oppsett">
                    <Select
                      value={preview.layout}
                      disabled={busy !== null}
                      onChange={(e) =>
                        change({
                          layout: e.target.value as ParticipationLayout,
                          sheet: undefined,
                          eventColumns: undefined,
                        })
                      }
                    >
                      {(Object.keys(layoutLabels) as ParticipationLayout[]).map((l) => (
                        <option key={l} value={l}>
                          {layoutLabels[l]}
                          {l === preview.detected ? ' (gjettet)' : ''}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Type" hint="Arrangementene matches mot og lages som denne typen.">
                    <Select
                      value={preview.typeId}
                      disabled={busy !== null}
                      onChange={(e) => change({ typeId: e.target.value })}
                    >
                      {preview.types.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  {preview.layout !== 'sheets' && preview.sheets.length > 1 && (
                    <Field label="Fane">
                      <Select
                        value={preview.sheet ?? ''}
                        disabled={busy !== null}
                        onChange={(e) => change({ sheet: e.target.value, eventColumns: undefined })}
                      >
                        {preview.sheets.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  )}
                </div>

                {preview.columns.length > 0 && (
                  <dl className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
                    {preview.columns.map((c) => (
                      <div key={c.label} className="flex gap-1.5">
                        <dt className="text-stone-500">{c.label}:</dt>
                        <dd className="font-medium text-stone-800">{c.header}</dd>
                      </div>
                    ))}
                  </dl>
                )}

                {preview.layout === 'matrix' && preview.matrixColumns.length > 0 && (
                  <fieldset>
                    <legend className="text-sm font-medium text-stone-800">
                      Kolonner som er arrangementer
                    </legend>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {preview.matrixColumns.map((c) => (
                        <label
                          key={c.index}
                          className={cx(
                            'inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1 text-sm ring-1 ring-inset',
                            c.used
                              ? 'bg-brand-50 text-brand-900 ring-brand-300'
                              : 'bg-white text-stone-600 ring-stone-200',
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={c.used}
                            disabled={busy !== null}
                            onChange={() =>
                              change({
                                eventColumns: preview.matrixColumns
                                  .filter((m) => (m.index === c.index ? !m.used : m.used))
                                  .map((m) => m.index),
                              })
                            }
                            className="accent-brand-600"
                          />
                          <span className="text-xs text-stone-400">{c.letter}</span> {c.header}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                )}

                {preview.values.length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium text-stone-800">Hva verdiene betyr</h3>
                    <p className="text-xs text-stone-500">
                      En celle med innhold betyr at personen var der. Endre det som er tolket feil.
                    </p>
                    <table className="mt-2 w-full text-sm">
                      <thead className="text-left text-xs text-stone-500">
                        <tr>
                          <th className="py-1 font-medium">Verdi</th>
                          <th className="py-1 font-medium">Antall</th>
                          <th className="py-1 font-medium">Betyr</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-stone-100">
                        {preview.values.slice(0, 100).map((v) => (
                          <tr key={v.value}>
                            <td className="py-1.5 pr-3">
                              <span className="font-mono text-[13px] text-stone-800">
                                {v.value}
                              </span>
                              {!v.known && (
                                <span className="ml-2 rounded-full bg-amber-100 px-1.5 py-px text-[11px] font-medium text-amber-800">
                                  ukjent
                                </span>
                              )}
                            </td>
                            <td className="py-1.5 pr-3 text-stone-600 tabular-nums">{v.count}</td>
                            <td className="py-1.5">
                              <Select
                                value={v.choice}
                                disabled={busy !== null}
                                aria-label={`Hva «${v.value}» betyr`}
                                onChange={(e) =>
                                  change({
                                    roleMap: {
                                      ...options.roleMap,
                                      [v.value]: e.target.value as RoleChoice,
                                    },
                                  })
                                }
                                className="h-8 w-44"
                              >
                                {(Object.keys(roleChoiceLabels) as RoleChoice[]).map((r) => (
                                  <option key={r} value={r}>
                                    {roleChoiceLabels[r]}
                                  </option>
                                ))}
                              </Select>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <Issues issues={preview.issues} title="Rader som hoppes over eller bør sjekkes" />
              </Card>

              <Card className="space-y-4 p-5">
                <StepTitle n={3}>Arrangementer</StepTitle>
                <p className="text-sm text-stone-600" aria-live="polite">
                  {plural(preview.events.length, 'arrangement', 'arrangementer')} i arket
                  {openEvents > 0 && ` · ${openEvents} må velges, opprettes eller hoppes over`}
                </p>
                <ol className="divide-y divide-stone-100 rounded-xl ring-1 ring-stone-200 ring-inset">
                  {preview.events.map((e) => (
                    <EventRow
                      key={e.key}
                      event={e}
                      types={preview.types}
                      typeId={preview.typeId}
                      decision={eventDecision(e, events)}
                      onChange={(d) => {
                        setPlan(null)
                        setEvents((all) => {
                          const next = { ...all }
                          if (d) next[e.key] = d
                          else delete next[e.key]
                          return next
                        })
                      }}
                    />
                  ))}
                </ol>
              </Card>

              <Card className="space-y-4 p-5">
                <StepTitle n={4}>Personer</StepTitle>
                <PeopleResolver
                  people={preview.people}
                  decisions={people}
                  canCreate
                  countLabel={deltakelser}
                  onChange={(key, d) => {
                    setPlan(null)
                    setPeople((all) => {
                      const next = { ...all }
                      if (d) next[key] = d
                      else delete next[key]
                      return next
                    })
                  }}
                />
              </Card>

              <Card className="space-y-4 p-5">
                <StepTitle n={5}>Se over og lagre</StepTitle>
                {!plan ? (
                  <>
                    <p className="text-sm text-stone-600">
                      {deltakelser(preview.entries)} i arket.
                      {(openPersons > 0 || openEvents > 0) &&
                        ' Det som ikke er avklart, hoppes over.'}{' '}
                      Ingenting lagres før du har sett endringene.
                    </p>
                    <Button variant="brand" onClick={review} disabled={busy !== null}>
                      {busy === 'prov' ? 'Regner ut …' : 'Se over endringene'}
                    </Button>
                  </>
                ) : (
                  <PlanView plan={plan} busy={busy} onSave={save} />
                )}
              </Card>
            </>
          )}
        </div>
        <Help />
      </div>
    </div>
  )
}

function Back() {
  return (
    <Link
      to="/admin/arrangementer"
      className="inline-flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-900"
    >
      <ArrowLeft className="size-4" aria-hidden /> Arrangementer
    </Link>
  )
}

const byLabel = { name: 'på navn', date: 'på dato', year: 'på år' } as const

function EventRow({
  event: e,
  types,
  typeId,
  decision,
  onChange,
}: {
  event: ImportEventPreview
  types: ParticipationPreview['types']
  typeId: string
  decision: EventDecision | null
  onChange: (d: EventDecision | undefined) => void
}) {
  const creating = decision?.kind === 'create' ? decision : null
  const chosen = decision?.kind === 'existing' ? decision.eventId : null
  const status =
    decision?.kind === 'skip'
      ? 'Hoppes over'
      : creating
        ? 'Opprettes'
        : e.status === 'matched'
          ? `Funnet ${e.by ? byLabel[e.by] : ''}`
          : e.status === 'ambiguous'
            ? 'Flere mulige'
            : 'Mangler'
  const tone =
    decision?.kind === 'skip' ? 'text-stone-500' : decision ? 'text-emerald-700' : 'text-amber-700'
  const set = (patch: Partial<Extract<EventDecision, { kind: 'create' }>>) =>
    creating && onChange({ ...creating, ...patch })

  return (
    <li className="px-3 py-2.5 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="min-w-0">
          <span className="font-medium text-stone-900">{e.label}</span>
          <span className="ml-2 text-xs text-stone-500">
            {e.source} · {deltakelser(e.count)}
          </span>
        </span>
        <span className={cx('shrink-0 text-xs font-medium', tone)}>{status}</span>
      </div>
      <div className="mt-1.5 space-y-1.5">
        {!creating && e.candidates.length > 0 && (
          <ul className="space-y-1">
            {e.candidates.map((c) => {
              const active = chosen === c.id
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() =>
                      onChange(
                        active
                          ? e.status === 'matched'
                            ? { kind: 'skip' }
                            : undefined
                          : { kind: 'existing', eventId: c.id },
                      )
                    }
                    className={cx(
                      'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs ring-1 transition ring-inset',
                      active
                        ? 'bg-brand-50 text-brand-900 ring-brand-300'
                        : 'bg-white text-stone-700 ring-stone-200 hover:ring-stone-400',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cx(
                        'grid size-4 shrink-0 place-items-center rounded-full ring-1 ring-inset',
                        active ? 'bg-brand-600 text-white ring-brand-600' : 'ring-stone-300',
                      )}
                    >
                      {active && <Check className="size-3" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{c.name}</span>
                      <span className="block text-stone-500">
                        {shortDate(c.startDate)} · {c.typeName}
                        {c.upcoming && (
                          <span className="font-medium text-red-700">
                            {' '}
                            · har ikke startet, kan ikke importeres
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {creating && (
          <div className="space-y-3 rounded-xl bg-stone-50 p-3 ring-1 ring-stone-200 ring-inset">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Navn">
                <Input
                  value={creating.name}
                  maxLength={120}
                  onChange={(x) => set({ name: x.target.value })}
                  className="h-9"
                />
              </Field>
              <Field label="Type">
                <Select
                  value={creating.typeId}
                  onChange={(x) => set({ typeId: x.target.value })}
                  className="h-9"
                >
                  {types.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Fra"
                hint={
                  e.suggestion.guessed
                    ? 'Sjekk datoen. Den er gjettet ut fra overskriften.'
                    : undefined
                }
              >
                <Input
                  type="date"
                  required
                  value={creating.startDate}
                  onChange={(x) => set({ startDate: x.target.value })}
                  className="h-9"
                />
              </Field>
              <Field label="Til" hint="Valgfritt">
                <Input
                  type="date"
                  value={creating.endDate ?? ''}
                  min={creating.startDate || undefined}
                  onChange={(x) => set({ endDate: x.target.value || null })}
                  className="h-9"
                />
              </Field>
              <Field label="Sted" hint="Valgfritt" className="sm:col-span-2">
                <Input
                  value={creating.location}
                  maxLength={120}
                  onChange={(x) => set({ location: x.target.value })}
                  className="h-9"
                />
              </Field>
            </div>
            <Button variant="ghost" size="sm" onClick={() => onChange(undefined)}>
              Ikke opprett
            </Button>
          </div>
        )}

        {!creating && (
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <button
              type="button"
              onClick={() =>
                onChange({
                  kind: 'create',
                  typeId,
                  name: e.suggestion.name,
                  startDate: e.suggestion.startDate,
                  endDate: e.suggestion.endDate,
                  location: '',
                })
              }
              className="inline-flex items-center gap-1 text-xs font-medium text-stone-500 hover:text-stone-900"
            >
              <Plus className="size-3.5" aria-hidden /> Opprett nytt arrangement
            </button>
            {decision?.kind === 'skip' ? (
              <button
                type="button"
                onClick={() => onChange(undefined)}
                className="text-xs font-medium text-stone-500 hover:text-stone-900"
              >
                Ikke hopp over
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onChange({ kind: 'skip' })}
                className="text-xs font-medium text-stone-500 hover:text-stone-900"
              >
                Hopp over
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  )
}

function PlanView({
  plan,
  busy,
  onSave,
}: {
  plan: ParticipationPlan
  busy: string | null
  onSave: () => void
}) {
  const [all, setAll] = useState(false)
  const t = plan.totals
  const nothing = !t.added && !t.updated && !t.profilesCreated && !t.eventsCreated
  const changes = all ? plan.changes : plan.changes.slice(0, 100)
  return (
    <div className="space-y-4" role="status">
      <Totals
        items={[
          { label: 'Nye deltakelser', value: t.added },
          { label: 'Endrede roller', value: t.updated },
          { label: 'Fantes fra før', value: t.unchanged },
          { label: 'Hoppes over', value: t.skipped },
          { label: 'Nye profiler', value: t.profilesCreated },
          { label: 'Nye arrangementer', value: t.eventsCreated },
        ]}
      />
      {plan.events.length > 0 && (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-stone-500">
            <tr>
              <th className="py-1 font-medium">Arrangement</th>
              <th className="py-1 text-right font-medium">Nye</th>
              <th className="py-1 text-right font-medium">Endret</th>
              <th className="py-1 text-right font-medium">Uendret</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100 tabular-nums">
            {plan.events.map((e) => (
              <tr key={e.key}>
                <td className="py-1.5 pr-3 text-stone-800">
                  {e.name}
                  {e.created && <span className="ml-2 text-xs text-emerald-700">nytt</span>}
                </td>
                <td className="py-1.5 text-right">{e.added}</td>
                <td className="py-1.5 text-right">{e.updated}</td>
                <td className="py-1.5 text-right text-stone-500">{e.unchanged}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {changes.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-stone-800">Endringer</h3>
          <ul className="mt-1.5 max-h-96 divide-y divide-stone-100 overflow-y-auto rounded-xl text-sm ring-1 ring-stone-200 ring-inset">
            {changes.map((c, i) => (
              <li key={i} className="flex flex-wrap justify-between gap-x-3 px-3 py-1.5">
                <span className="text-stone-800">
                  {c.fullName} <span className="text-stone-500">· {c.eventName}</span>
                </span>
                <span className="text-xs text-stone-600">
                  {c.kind === 'add'
                    ? `Ny: ${roleLabel(c.to)}`
                    : [
                        c.from !== c.to && `${roleLabel(c.from)} → ${roleLabel(c.to)}`,
                        c.note && 'notat lagt til',
                      ]
                        .filter(Boolean)
                        .join(', ')}
                </span>
              </li>
            ))}
          </ul>
          {!all && plan.changes.length > 100 && (
            <Button variant="ghost" size="sm" className="mt-1" onClick={() => setAll(true)}>
              Vis alle {plan.changes.length}
            </Button>
          )}
        </div>
      )}
      <Issues issues={plan.notes} title="Merknader" />
      {nothing ? (
        <p className="text-sm text-stone-600">Ingenting å lagre: alt i arket finnes fra før.</p>
      ) : (
        <Button variant="brand" onClick={onSave} disabled={busy !== null}>
          {busy === 'lagre' ? 'Lagrer …' : 'Lagre'}
        </Button>
      )}
    </div>
  )
}

function Help() {
  return (
    <aside className="space-y-4 lg:sticky lg:top-6">
      <Card className="space-y-4 p-5 text-sm text-stone-600">
        <h2 className="text-sm font-semibold text-stone-950">Slik kan arket se ut</h2>
        <p>
          Personer kjennes igjen på e-post, ellers på navn og kull. Oppsettet gjettes; rett det i
          steg 2 om det blir feil.
        </p>
        <ExampleSheet
          title="Matrise: én kolonne per arrangement"
          rows={[
            ['Navn', 'E-post', 'Kull', 'Høst 2018', 'Vår 2019'],
            ['Kari Nordmann', 'kari@…', 'ES 2018', 'x', 'arr'],
            ['Ola Hansen', '', '2019', '', 'foredrag'],
          ]}
        />
        <ExampleSheet
          title="Én fane per arrangement, f.eks. «ESAF-helgen høst 2018»"
          rows={[
            ['Navn', 'E-post', 'Rolle'],
            ['Kari Nordmann', 'kari@…', 'Arrangør'],
            ['Ola Hansen', '', ''],
          ]}
        />
        <ExampleSheet
          title="Én rad per deltakelse"
          rows={[
            ['Navn', 'E-post', 'Arrangement', 'Dato', 'Rolle'],
            ['Kari Nordmann', 'kari@…', 'Generalforsamling', '14.03.2024', 'Taler'],
          ]}
        />
        <p className="text-xs text-stone-500">
          «x», «✓», «ja» og «1» betyr deltaker; «arr» arrangør; «foredrag» eller «taler»
          foredragsholder; «frivillig» eller «hjelper» frivillig; «nei» og «0» ikke med. Samme fil
          to ganger gir ingen duplikater, og en tom rolle tar aldri bort en rolle som står. Fila
          lagres ikke.
        </p>
      </Card>
    </aside>
  )
}
