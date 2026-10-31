import type { MergeChoiceField, PersonMergePreview } from '@esaf/core'
import { ArrowDown, GitMerge } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Dialog, DialogActions } from './Dialog.tsx'
import { Avatar, Button, cx, ErrorText, Verified } from './ui.tsx'
import { mergePerson, previewPersonMerge } from '#/lib/people.functions.ts'
import { yearSpan } from '#/lib/format.ts'

const labels = {
  fullName: 'Navn',
  city: 'Bosted',
  studyBackground: 'Studiebakgrunn',
  bio: 'Om personen',
  linkedinUrl: 'LinkedIn',
  expertise: 'Kan hjelpe med',
  industries: 'Bransjer',
  esCompanyId: 'ES-selskap',
  photoKey: 'Profilbilde',
}
const relations = { student: 'Student', staff: 'Ansatt på ES', mentor: 'Mentor' }
const statuses = { active: 'Aktiv', pending: 'Venter på godkjenning', inactive: 'Inaktiv' }

/**
 * Sammenslåing av to personer, fra profilen og fra Gjennomgang: viser profilen slik
 * den blir (fra serveren, med de samme reglene som sammenslåingen), lar admin velge
 * duplikatets verdi der begge har ulike verdier, og krever en egen bekreftelse.
 */
export function PersonMergeDialog({
  sourceId,
  targetId,
  onClose,
  onMerged,
}: {
  sourceId: string
  targetId: string
  onClose: () => void
  onMerged: (personId: string) => Promise<void>
}) {
  const [preview, setPreview] = useState<PersonMergePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [needsRefresh, setNeedsRefresh] = useState(false)
  // Felt der duplikatets verdi skal brukes i stedet for den beholdtes.
  const [useSource, setUseSource] = useState<ReadonlySet<MergeChoiceField>>(new Set())
  useEffect(() => {
    let cancelled = false
    void previewPersonMerge({ data: { sourceId, targetId } })
      .then((value) => {
        if (!cancelled) {
          setPreview(value)
          setNeedsRefresh(false)
          // Valg for felt som ikke lenger er ulike, gjelder ikke.
          setUseSource(
            (current) =>
              new Set(
                value.fields.filter((f) => f.conflict && current.has(f.field)).map((f) => f.field),
              ),
          )
        }
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : 'Kunne ikke laste forhåndsvisningen.')
      })
    return () => {
      cancelled = true
    }
  }, [sourceId, targetId, refresh])

  function reload() {
    setPreview(null)
    setError(null)
    setRefresh((r) => r + 1)
  }
  async function merge() {
    if (!preview || busy || needsRefresh) return
    setBusy(true)
    setError(null)
    try {
      const result = await mergePerson({
        data: { sourceId, targetId, previewToken: preview.token, useSource: [...useSource] },
      })
      await onMerged(result.personId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke slå sammen profilene.')
      setNeedsRefresh(true)
    } finally {
      setBusy(false)
    }
  }

  const choose = (field: MergeChoiceField, fromSource: boolean) =>
    setUseSource((current) => {
      const next = new Set(current)
      if (fromSource) next.add(field)
      else next.delete(field)
      return next
    })
  const resultName =
    preview && useSource.has('fullName') ? preview.source.fullName : preview?.target.fullName
  const resultPhoto =
    preview && useSource.has('photoKey') ? preview.source.photo : (preview?.photo ?? null)

  return (
    <Dialog
      title="Se profilen etter sammenslåing"
      description="Forhåndsvisningen bruker lagrede profildata. Lagre eventuelle endringer i skjemaet først. Ingenting endres før du trykker «Bekreft sammenslåing»."
      onClose={onClose}
      busy={busy}
      className="max-w-3xl"
    >
      {!preview && !error && (
        <p role="status" className="py-8 text-center text-sm text-stone-500">
          Laster forhåndsvisning …
        </p>
      )}
      {preview && (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2">
            {(
              [
                ['Beholdes', preview.target],
                ['Slettes etter flytting', preview.source],
              ] as const
            ).map(([label, p]) => (
              <div
                key={p.personId}
                className="rounded-xl bg-stone-50 p-3 ring-1 ring-stone-200 ring-inset"
              >
                <p className="mb-2 text-xs font-semibold text-stone-500">{label}</p>
                <div className="flex items-center gap-3">
                  <Avatar name={p.fullName} photo={p.photo} size="sm" />
                  <div className="min-w-0">
                    <p className="flex items-center gap-1 font-semibold">
                      {p.fullName}
                      <Verified claimed={p.claimed} />
                    </p>
                    <p className="text-xs text-stone-500">
                      {p.claimed ? 'Har konto · kontoen beholdes' : 'Profil uten konto'}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <p className="text-sm text-stone-600">
            {preview.target.claimed ? 'Profilen med konto beholdes alltid. ' : ''}Utfylte felt på
            profilen som beholdes, gjelder, og tomme felt fylles fra duplikatet. Har begge ulike
            verdier, velger du hvilken som skal gjelde.
          </p>
          <section
            aria-labelledby="merged-profile"
            className="overflow-hidden rounded-2xl border border-stone-200"
          >
            <div className="flex items-center gap-4 border-b border-stone-200 bg-stone-50 p-4 sm:p-5">
              <Avatar name={resultName ?? ''} photo={resultPhoto} size="lg" />
              <div>
                <p className="mb-1 flex items-center gap-1 text-xs font-semibold text-stone-500">
                  <ArrowDown className="size-3" aria-hidden /> Resultat etter sammenslåing
                </p>
                <h3 id="merged-profile" className="text-xl font-semibold">
                  {resultName}
                </h3>
                <p className="text-sm text-stone-500">
                  {statuses[preview.status]}{' '}
                  {preview.statusChanged && <Added label="Medlemsstatus endres" />}
                </p>
              </div>
            </div>
            <dl className="divide-y divide-stone-100 px-4 sm:px-5">
              {preview.fields.map((field) => (
                <div key={field.field} className="py-3 sm:grid sm:grid-cols-[9rem_1fr] sm:gap-4">
                  <dt className="mb-1 text-sm font-medium text-stone-500">{labels[field.field]}</dt>
                  <dd className="min-w-0 space-y-2 text-sm">
                    {field.conflict ? (
                      <fieldset className="space-y-2">
                        <legend className="sr-only">
                          Velg {labels[field.field].toLowerCase()}
                        </legend>
                        {(
                          [
                            [false, field.targetValue, preview.target.fullName],
                            [true, field.sourceValue, preview.source.fullName],
                          ] as const
                        ).map(([fromSource, value, owner]) => (
                          <label
                            key={String(fromSource)}
                            className={cx(
                              'flex cursor-pointer items-start gap-3 rounded-lg p-2 ring-1 ring-inset',
                              useSource.has(field.field) === fromSource
                                ? 'bg-white ring-brand-500'
                                : 'ring-stone-200 hover:bg-stone-50',
                            )}
                          >
                            <input
                              type="radio"
                              name={`merge-${field.field}`}
                              checked={useSource.has(field.field) === fromSource}
                              onChange={() => choose(field.field, fromSource)}
                              disabled={busy}
                              className="mt-1 size-4 accent-brand-600"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block text-xs text-stone-500">Fra {owner}</span>
                              <FieldValue field={field.field} value={value} />
                            </span>
                          </label>
                        ))}
                      </fieldset>
                    ) : (
                      <div className="flex flex-wrap items-start gap-2">
                        <FieldValue field={field.field} value={field.value} />
                        {field.origin === 'filled' && <Added />}
                      </div>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
          <section>
            <h3 className="mb-2 font-semibold">Kull etter sammenslåing</h3>
            {preview.cohorts.length ? (
              <ul className="space-y-2 text-sm">
                {preview.cohorts.map((c) => (
                  <li key={c.year} className="rounded-lg border border-stone-200 p-3">
                    <span>
                      ES {c.year} · {relations[c.relation]}
                    </span>{' '}
                    {c.added && <Added />}
                    {c.discardedRelation && (
                      <p className="mt-1 text-xs text-amber-800">
                        Duplikatets tilknytning «{relations[c.discardedRelation]}» tas ikke med.
                        Tilknytningen på profilen som beholdes, gjelder.
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty />
            )}
          </section>
          <section>
            <h3 className="mb-2 font-semibold">Erfaring etter sammenslåing</h3>
            {preview.experience.length ? (
              <ul className="space-y-2 text-sm">
                {preview.experience.map((job) => (
                  <li key={job.id} className="rounded-lg border border-stone-200 p-3">
                    <span className="font-medium">{job.company}</span> {job.added && <Added />}
                    <p className="mt-1 text-stone-500">
                      {[
                        job.title,
                        job.founder ? 'Gründer' : null,
                        job.startYear || job.endYear ? yearSpan(job.startYear, job.endYear) : null,
                      ]
                        .filter(Boolean)
                        .join(' · ') || 'Ingen stilling eller årstall'}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty />
            )}
            {preview.duplicateExperience > 0 && (
              <p className="mt-2 text-xs text-stone-500">
                {preview.duplicateExperience} identiske erfaringer fra duplikatet fjernes.
              </p>
            )}
          </section>
          <section>
            <h3 className="mb-2 font-semibold">Kjente e-postadresser etter sammenslåing</h3>
            <p className="mb-2 text-xs text-stone-500">
              Bare synlig for admins. Brukes til å koble kontoer til riktig profil.
            </p>
            {preview.emails.length ? (
              <ul className="space-y-1 text-sm">
                {preview.emails.map((e) => (
                  <li key={e.email} className="break-words">
                    {e.email} {e.added && <Added />}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty />
            )}
          </section>
          <section>
            <h3 className="mb-2 font-semibold">Kontaktinfo</h3>
            <p className="mb-2 text-xs text-stone-500">
              {preview.target.claimed
                ? 'Personen har konto og bestemmer selv. Kontaktinfo beholdes uendret.'
                : 'Tomme kontaktfelt fylles. Felt som er skjult på en av profilene, forblir skjult.'}{' '}
              Private kontaktverdier vises ikke her.
            </p>
            <ul className="space-y-1 text-sm">
              {preview.contact.map((c) => (
                <li key={c.field}>
                  {c.field === 'phone' ? 'Telefon' : 'Kontakt-e-post'}:{' '}
                  {c.present
                    ? c.visible
                      ? 'Synlig for medlemmer'
                      : 'Skjult for medlemmer'
                    : 'Ikke utfylt'}{' '}
                  {c.changed && <Added label="Endres" />}
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h3 className="mb-2 font-semibold">Innhold og tilknytninger fra duplikatet</h3>
            {preview.transfers.some((t) => t.count > 0) && (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                {preview.transfers
                  .filter((t) => t.count > 0)
                  .map((t) => (
                    <div key={t.label} className="flex justify-between gap-2">
                      <dt>{t.label}</dt>
                      <dd className="font-medium tabular-nums">{t.count}</dd>
                    </div>
                  ))}
              </dl>
            )}
            <p className="mt-2 text-xs leading-relaxed text-stone-500">
              Innhold fra duplikatet flyttes til profilen som beholdes. Identiske stemmer og
              overlappende nåværende verv beholdes én gang; vervet på profilen som beholdes,
              gjelder. Arrangementsdeltakelser kombineres per arrangement; tom rolle og tomt notat
              fylles. Relevante feltkilder, varsler, invitasjoner, forslag og forespørsler følger
              også med.
            </p>
          </section>
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
            <p className="font-semibold">{preview.source.fullName} slettes som egen profil.</p>
            <p className="mt-1">
              Verdiene du ikke velger, og bildet som ikke brukes, fjernes. Sammenslåingen kan ikke
              angres.
            </p>
          </div>
        </div>
      )}
      {error && (
        <div role="alert" className="mt-4">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      <DialogActions>
        <Button variant="secondary" onClick={onClose} disabled={busy} data-autofocus>
          Avbryt
        </Button>
        {(error || needsRefresh) && (
          <Button variant="secondary" onClick={reload} disabled={busy}>
            Last inn på nytt
          </Button>
        )}
        <Button onClick={() => void merge()} disabled={!preview || busy || needsRefresh}>
          <GitMerge className="size-4" aria-hidden />
          {busy ? 'Slår sammen …' : 'Bekreft sammenslåing'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

function FieldValue({ field, value }: { field: MergeChoiceField; value: string | null }) {
  if (field === 'photoKey') {
    return value ? (
      <img src={value} alt="" className="size-14 rounded-full object-cover" />
    ) : (
      <span className="text-stone-400">Ingen bilde</span>
    )
  }
  return (
    <span className="block min-w-0 whitespace-pre-wrap break-words">
      {value ?? <span className="text-stone-400">Ikke utfylt</span>}
    </span>
  )
}

function Added({ label = 'Fra duplikatet' }: { label?: string }) {
  return (
    <span className="inline-block rounded bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-800">
      {label}
    </span>
  )
}
function Empty() {
  return <p className="text-sm text-stone-400">Ingen registrert.</p>
}
