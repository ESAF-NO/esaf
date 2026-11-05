import type { FieldSource, ProfileSourceField } from '@esaf/core'
import { useRouter } from '@tanstack/react-router'
import { Check, X } from 'lucide-react'
import { Fragment, useState } from 'react'
import { confirmProfile } from '#/lib/profiles.functions.ts'
import { removeSource } from '#/lib/review.functions.ts'
import { confidenceLabels, unconfirmed } from '#/lib/sources.ts'
import { cx } from './ui.tsx'

/** «kullisten og entreprenorskolen.no», med lenke til kilder som har en adresse. */
export function SourceNames({ sources }: { sources: FieldSource[] }) {
  // Samme kilde kan stå flere ganger (f.eks. nettsiden og arkivet med samme navn).
  const unique = sources.filter((s, i) => sources.findIndex((o) => o.label === s.label) === i)
  return (
    <>
      {unique.map((s, i) => (
        <Fragment key={s.label}>
          {i > 0 && (i === unique.length - 1 ? ' og ' : ', ')}
          {s.url ? (
            <a
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-stone-300 underline-offset-2 hover:text-stone-700"
            >
              {s.label}
            </a>
          ) : (
            s.label
          )}
        </Fragment>
      ))}
    </>
  )
}

/**
 * Fjerner én kilde som ikke stemmer, for admins. Verdien i feltet står. Bare
 * admins får vite hvor sikker kilden er, så `confidence` sier om knappen skal vises.
 */
export function RemoveSourceButton({
  entityType,
  entityId,
  field,
  source,
}: {
  entityType: 'person' | 'company'
  entityId: string
  field: string
  source: { label: string; url: string | null }
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const name = source.url ? `${source.label} (${source.url})` : source.label

  async function remove() {
    if (!window.confirm(`Fjerne kilden ${name}? Feltet står som før, og det logges.`)) return
    setBusy(true)
    setError(false)
    try {
      await removeSource({ data: { entityType, entityId, field, ...source } })
      await router.invalidate()
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={remove}
        disabled={busy}
        title={`Fjern kilden ${name}`}
        aria-label={`Fjern kilden ${source.label}`}
        className="inline-flex size-4 items-center justify-center rounded-full align-middle text-stone-400 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
      >
        <X className="size-3" aria-hidden />
      </button>
      {error && <span className="text-red-600">Kunne ikke fjerne kilden.</span>}
    </>
  )
}

/**
 * Diskret merke under et importert felt som ingen har bekreftet: «Fra
 * entreprenorskolen.no · ikke bekreftet». Admins ser også hvor sikker kilden er.
 * Eieren av profilen kan bekrefte feltet med «Stemmer».
 */
export function SourceNote({
  sources,
  personId,
  field,
  canConfirm,
  label,
  className,
}: {
  sources: FieldSource[]
  personId: string
  field: ProfileSourceField
  canConfirm: boolean
  /** Hva merket gjelder, når det ikke står rett under feltet, f.eks. «Bildet». */
  label?: string
  className?: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  if (!unconfirmed(sources)) return null
  // Den sikreste kilden først; den sier mest om feltet.
  const confidence = sources[0]?.confidence

  async function confirm() {
    setBusy(true)
    setError(false)
    try {
      await confirmProfile({ data: { personId, fields: [field] } })
      await router.invalidate()
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <p
      className={cx(
        'flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-stone-400',
        className,
      )}
    >
      <span>
        {label ? `${label} fra ` : 'Fra '}
        <SourceNames sources={sources} /> · ikke bekreftet
        {confidence && ` · ${confidenceLabels[confidence]}`}
      </span>
      {canConfirm && (
        <button
          type="button"
          onClick={confirm}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium text-brand-700 ring-1 ring-brand-600/20 transition ring-inset hover:bg-brand-50 disabled:opacity-50"
        >
          <Check className="size-3" aria-hidden /> Stemmer
        </button>
      )}
      {confidence &&
        sources.map((s) => (
          <RemoveSourceButton
            key={`${s.label}|${s.url}`}
            entityType="person"
            entityId={personId}
            field={field}
            source={s}
          />
        ))}
      {error && <span className="text-red-600">Kunne ikke bekrefte. Prøv igjen.</span>}
    </p>
  )
}
