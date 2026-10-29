import type { RepresentativePlan, RepresentativePreview } from '@esaf/core'
import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { ArrowLeft, CircleCheck } from 'lucide-react'
import { useState } from 'react'
import { FilePicker } from '#/components/import/FilePicker.tsx'
import { years } from '#/components/import/labels.ts'
import {
  openPeople,
  PeopleResolver,
  personDecision,
  type PersonDecisions,
} from '#/components/import/PeopleResolver.tsx'
import { ExampleSheet, Issues, StepTitle, Totals } from '#/components/import/Summary.tsx'
import { Button, Card, ErrorText } from '#/components/ui.tsx'
import { plural } from '#/lib/format.ts'
import { postImport } from '#/lib/import-client.ts'

export const Route = createFileRoute('/_konto/admin/kullrepresentanter_/import')({
  beforeLoad: ({ context: { viewer } }) => {
    if (!viewer.permissions.includes('members.manage')) throw notFound()
  },
  head: () => ({ meta: [{ title: 'Importer kullrepresentanter – Admin – ESAF' }] }),
  component: ImportRepresentatives,
})

const URL = '/api/import/kullrepresentanter'
const verv = (n: number) => plural(n, 'verv', 'verv')

/**
 * Import av kullrepresentanter fra et regneark: last opp, se over hvem radene
 * treffer, se nøyaktig hva som blir lagt til og endret, og lagre. Ingenting
 * lagres før det siste steget, og da i én transaksjon.
 */
function ImportRepresentatives() {
  const { viewer } = Route.useRouteContext()
  // Nye profiler krever retten til å lage profiler.
  const canCreate = viewer.permissions.includes('profiles.edit')
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<RepresentativePreview | null>(null)
  const [people, setPeople] = useState<PersonDecisions>({})
  const [plan, setPlan] = useState<RepresentativePlan | null>(null)
  const [saved, setSaved] = useState<RepresentativePlan | null>(null)
  const [busy, setBusy] = useState<'forhandsvis' | 'prov' | 'lagre' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function run<T>(steg: 'forhandsvis' | 'prov' | 'lagre', f: File, done: (r: T) => void) {
    setBusy(steg)
    setError(null)
    try {
      done(
        await postImport<T>(
          URL,
          f,
          steg,
          undefined,
          steg === 'forhandsvis' ? undefined : { people },
        ),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Noe gikk galt.')
    } finally {
      setBusy(null)
    }
  }

  function reset() {
    setFile(null)
    setPreview(null)
    setPeople({})
    setPlan(null)
    setSaved(null)
  }

  if (saved) {
    const t = saved.totals
    return (
      <div className="max-w-3xl space-y-4">
        <Back />
        <Card className="p-6">
          <p className="flex items-center gap-2 font-medium text-stone-950">
            <CircleCheck className="size-5 text-emerald-600" aria-hidden /> Importen er lagret
          </p>
          <p className="mt-1 text-sm text-stone-600" role="status">
            {[
              `${verv(t.added)} lagt til`,
              t.updated && `${t.updated} rettet`,
              t.unchanged && `${t.unchanged} fantes fra før`,
              t.profilesCreated && plural(t.profilesCreated, 'ny profil', 'nye profiler'),
            ]
              .filter(Boolean)
              .join(' · ')}
            . Alt står i loggen.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link
              to="/admin/kullrepresentanter"
              className="inline-flex h-10 items-center rounded-lg bg-stone-900 px-4 text-sm font-medium text-white hover:bg-stone-800"
            >
              Se kullrepresentantene
            </Link>
            <Button variant="secondary" onClick={reset}>
              Importer en fil til
            </Button>
          </div>
        </Card>
      </div>
    )
  }

  const names = new Map(preview?.people.map((p) => [p.key, p]) ?? [])
  const open = preview ? openPeople(preview.people, people).length : 0

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
                setPeople({})
                setPlan(null)
                void run<RepresentativePreview>('forhandsvis', f, setPreview)
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
                <StepTitle n={2}>Vervene i arket</StepTitle>
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
                <div className="max-h-96 overflow-y-auto rounded-xl ring-1 ring-stone-200 ring-inset">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-white text-left text-xs text-stone-500">
                      <tr>
                        <th className="px-3 py-1.5 font-medium">Kull</th>
                        <th className="px-3 py-1.5 font-medium">Person</th>
                        <th className="px-3 py-1.5 font-medium">Periode</th>
                        <th className="px-3 py-1.5 font-medium">Notat</th>
                        <th className="px-3 py-1.5 font-medium">Rad</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-stone-100">
                      {preview.rows.map((r) => {
                        const p = names.get(r.personKey)
                        const d = p ? personDecision(p, people) : null
                        return (
                          <tr key={r.key}>
                            <td className="px-3 py-1.5 text-stone-800 tabular-nums">
                              ES {r.graduationYear}
                            </td>
                            <td className="px-3 py-1.5">
                              <span className="text-stone-800">{p?.fullName || p?.emails[0]}</span>
                              {!d && (
                                <span className="ml-1.5 text-xs text-amber-700">må avklares</span>
                              )}
                              {d?.kind === 'skip' && (
                                <span className="ml-1.5 text-xs text-stone-500">hoppes over</span>
                              )}
                              {d?.kind === 'create' && (
                                <span className="ml-1.5 text-xs text-emerald-700">ny profil</span>
                              )}
                            </td>
                            <td className="px-3 py-1.5 text-stone-600 tabular-nums">
                              {years(r.startYear, r.endYear)}
                            </td>
                            <td className="max-w-48 truncate px-3 py-1.5 text-stone-600">
                              {r.note}
                            </td>
                            <td className="px-3 py-1.5 text-xs text-stone-500">{r.where}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <Issues issues={preview.issues} title="Rader som hoppes over" />
              </Card>

              <Card className="space-y-4 p-5">
                <StepTitle n={3}>Personer</StepTitle>
                <PeopleResolver
                  people={preview.people}
                  decisions={people}
                  canCreate={canCreate}
                  countLabel={verv}
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
                <StepTitle n={4}>Se over og lagre</StepTitle>
                {!plan ? (
                  <>
                    <p className="text-sm text-stone-600">
                      {plural(preview.rows.length, 'verv', 'verv')} i arket.
                      {open > 0 && ' Personer som ikke er avklart, hoppes over.'} Ingenting lagres
                      før du har sett endringene.
                    </p>
                    <Button
                      variant="brand"
                      disabled={busy !== null}
                      onClick={() => void run<RepresentativePlan>('prov', file, setPlan)}
                    >
                      {busy === 'prov' ? 'Regner ut …' : 'Se over endringene'}
                    </Button>
                  </>
                ) : (
                  <PlanView
                    plan={plan}
                    busy={busy}
                    onSave={() =>
                      void run<RepresentativePlan>('lagre', file, (r) => {
                        setSaved(r)
                        setPlan(null)
                      })
                    }
                  />
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
      to="/admin/kullrepresentanter"
      className="inline-flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-900"
    >
      <ArrowLeft className="size-4" aria-hidden /> Kullrepresentanter
    </Link>
  )
}

function PlanView({
  plan,
  busy,
  onSave,
}: {
  plan: RepresentativePlan
  busy: string | null
  onSave: () => void
}) {
  const t = plan.totals
  const nothing = !t.added && !t.updated && !t.profilesCreated
  return (
    <div className="space-y-4" role="status">
      <Totals
        items={[
          { label: 'Nye verv', value: t.added },
          { label: 'Rettede verv', value: t.updated },
          { label: 'Fantes fra før', value: t.unchanged },
          { label: 'Hoppes over', value: t.skipped },
          { label: 'Nye profiler', value: t.profilesCreated },
        ]}
      />
      {plan.changes.length > 0 && (
        <ul className="max-h-96 divide-y divide-stone-100 overflow-y-auto rounded-xl text-sm ring-1 ring-stone-200 ring-inset">
          {plan.changes.map((c, i) => (
            <li
              key={i}
              className="flex flex-wrap items-baseline justify-between gap-x-3 px-3 py-1.5"
            >
              <span className="text-stone-800">
                {c.fullName} <span className="text-stone-500">· ES {c.graduationYear}</span>
                {c.otherCohort && (
                  <span className="ml-2 rounded-full bg-amber-100 px-1.5 py-px text-[11px] font-medium text-amber-800">
                    Annet kull
                  </span>
                )}
              </span>
              <span className="text-xs text-stone-600 tabular-nums">
                {c.kind === 'add'
                  ? `Nytt verv: ${years(c.to.startYear, c.to.endYear)}`
                  : [
                      c.from &&
                        (c.from.startYear !== c.to.startYear || c.from.endYear !== c.to.endYear) &&
                        `${years(c.from.startYear, c.from.endYear)} → ${years(c.to.startYear, c.to.endYear)}`,
                      c.noteChanged && 'nytt notat',
                    ]
                      .filter(Boolean)
                      .join(', ')}
              </span>
            </li>
          ))}
        </ul>
      )}
      {plan.changes.some((c) => c.otherCohort) && (
        <p className="text-xs text-stone-500">
          «Annet kull»: personen går ikke selv i kullet. Det er lov, men sjekk at det er riktig.
        </p>
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
        <ExampleSheet
          title="Ett verv per rad"
          rows={[
            ['Kull', 'Navn', 'E-post', 'Fra', 'Til', 'Notat'],
            ['ES 2019', 'Kari Nordmann', 'kari@…', '2019', '', 'Valgt på samlingen'],
            ['2016', 'Ola Hansen', '', '2016', '2018', ''],
          ]}
        />
        <p>
          En fane som heter «ES 2019» kan stå i stedet for kullkolonnen. «Periode» med «2019–2022»,
          «siden 2021» eller «til 2018» virker også. Uten til-år er vervet nåværende.
        </p>
        <p className="text-xs text-stone-500">
          Personer kjennes igjen på e-post, ellers på navn og kull. Samme fil to ganger endrer
          ingenting; nye år vises som endringer, og et tomt notat tar ikke bort et notat som står.
          Fila lagres ikke.
        </p>
      </Card>
    </aside>
  )
}
