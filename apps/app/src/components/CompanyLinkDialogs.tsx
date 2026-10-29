import type { PersonHit } from '@esaf/core'
import { useRouter } from '@tanstack/react-router'
import { Search } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent } from 'react'
import { linkRoleLabels } from './Contributions.tsx'
import { Dialog, DialogActions } from './Dialog.tsx'
import { Avatar, Button, cx, ErrorText, Field, Input, Verified } from './ui.tsx'
import {
  addPersonToCompany,
  findMembers,
  joinCompany,
  type CompanyLinkFormValues,
} from '#/lib/contributions.functions.ts'

const thisYear = new Date().getFullYear()
const roles = ['founder', 'es', 'employee'] as const

const roleHints: Record<(typeof roles)[number], string> = {
  founder: 'Grunnla eller var med å grunnlegge selskapet.',
  es: 'Hadde selskapet som ES-selskap på Entreprenørskolen.',
  employee: 'Jobber eller har jobbet der.',
}

type Draft = {
  role: CompanyLinkFormValues['role']
  title: string
  startYear: string
  endYear: string
  current: boolean
}

/** Gjør skjemaet om til det serveren tar imot, med samme årstallsjekk som profilen. */
function toValues(d: Draft): CompanyLinkFormValues {
  for (const y of [d.startYear, d.current ? '' : d.endYear]) {
    if (y && (Number(y) < 1950 || Number(y) > thisYear + 1)) {
      throw new Error(`«${y}» er ikke et gyldig årstall.`)
    }
  }
  if (d.role === 'employee' && !d.current && !d.endYear) {
    throw new Error('Fyll inn sluttår, eller kryss av for «Er der fortsatt».')
  }
  const year = (v: string) => (v ? Number(v) : null)
  return {
    role: d.role,
    title: d.role === 'es' ? '' : d.title,
    startYear: d.role === 'es' ? null : year(d.startYear),
    endYear: d.role === 'es' || d.current ? null : year(d.endYear),
  }
}

/** Rolle, stilling og år, felles for «Jeg var med her» og «Legg til en person». */
function LinkFields({
  draft,
  onChange,
}: {
  draft: Draft
  onChange: (patch: Partial<Draft>) => void
}) {
  const labelId = useId()
  return (
    <>
      <fieldset>
        <legend id={labelId} className="text-sm font-medium text-stone-800">
          Som
        </legend>
        <div className="mt-1.5 grid gap-2 sm:grid-cols-3">
          {roles.map((role) => (
            <label
              key={role}
              className={cx(
                'cursor-pointer rounded-xl px-3 py-2.5 text-sm ring-1 transition ring-inset has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-500',
                draft.role === role
                  ? 'bg-white ring-brand-500'
                  : 'text-stone-600 ring-stone-200 hover:bg-stone-50',
              )}
            >
              <input
                type="radio"
                name="role"
                value={role}
                checked={draft.role === role}
                onChange={() => onChange({ role })}
                className="sr-only"
              />
              <span className="block font-medium text-stone-900">
                {linkRoleLabels[role].charAt(0).toLocaleUpperCase('nb') +
                  linkRoleLabels[role].slice(1)}
              </span>
              <span className="mt-0.5 block text-xs text-stone-500">{roleHints[role]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {draft.role !== 'es' && (
        <>
          <Field label="Stilling" hint="Valgfritt.">
            <Input
              value={draft.title}
              onChange={(e) => onChange({ title: e.target.value })}
              maxLength={120}
              placeholder={draft.role === 'founder' ? 'Daglig leder' : 'Utvikler'}
            />
          </Field>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Fra" className="w-24">
              <Input
                value={draft.startYear}
                onChange={(e) => onChange({ startYear: e.target.value.replace(/\D/g, '') })}
                inputMode="numeric"
                maxLength={4}
                placeholder="2019"
              />
            </Field>
            <Field label="Til" className="w-24">
              <Input
                value={draft.current ? '' : draft.endYear}
                onChange={(e) => onChange({ endYear: e.target.value.replace(/\D/g, '') })}
                inputMode="numeric"
                maxLength={4}
                placeholder={draft.current ? 'nå' : String(thisYear)}
                disabled={draft.current}
              />
            </Field>
            <label className="inline-flex cursor-pointer items-center gap-2 pb-2.5 text-sm text-stone-700">
              <input
                type="checkbox"
                checked={draft.current}
                onChange={(e) => onChange({ current: e.target.checked })}
                className="size-4 rounded border-stone-300 accent-brand-600"
              />
              Er der fortsatt
            </label>
          </div>
        </>
      )}
    </>
  )
}

const blank = (): Draft => ({
  role: 'founder',
  title: '',
  startYear: '',
  endYear: '',
  current: true,
})

/** «Jeg var med her»: gjelder den innloggede selv, så det lagres med en gang. */
export function JoinCompanyDialog({
  companyId,
  name,
  onClose,
}: {
  companyId: string
  name: string
  onClose: () => void
}) {
  const router = useRouter()
  const [draft, setDraft] = useState(blank)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await joinCompany({ data: { companyId, ...toValues(draft) } })
      await router.invalidate()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke lagre.')
      setSaving(false)
    }
  }

  return (
    <Dialog
      title={`Jeg var med i ${name}`}
      description="Det legges til på profilen din med en gang. Som gründer, ES-team eller ansatt nå kan du også redigere selskapssiden."
      onClose={onClose}
      busy={saving}
      className="max-w-lg"
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        <LinkFields draft={draft} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} />
        {error && <ErrorText>{error}</ErrorText>}
        <DialogActions>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Avbryt
          </Button>
          <Button type="submit" variant="brand" disabled={saving}>
            {saving ? 'Lagrer …' : 'Legg til på profilen min'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

/**
 * Legg til en annen person. Personen får spørsmål om det stemmer, og vises ikke
 * på selskapssiden før de har bekreftet.
 */
export function AddPersonDialog({
  companyId,
  name,
  viewerId,
  onClose,
}: {
  companyId: string
  name: string
  viewerId: string
  onClose: () => void
}) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<PersonHit[]>([])
  const [chosen, setChosen] = useState<PersonHit | null>(null)
  const [draft, setDraft] = useState(blank)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const listId = useId()
  const term = query.trim()

  useEffect(() => {
    if (chosen || term.length < 2) return
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const found = await findMembers({ data: { q: term } })
        if (!cancelled) setHits(found.filter((p) => p.personId !== viewerId))
      } catch {
        if (!cancelled) setHits([])
      }
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [term, chosen, viewerId])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!chosen) return setError('Velg hvem som var med.')
    setSaving(true)
    setError(null)
    try {
      await addPersonToCompany({
        data: { companyId, personId: chosen.personId, ...toValues(draft) },
      })
      await router.invalidate()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke lagre.')
      setSaving(false)
    }
  }

  return (
    <Dialog
      title={`Legg til en person i ${name}`}
      description="Personen får spørsmål om det stemmer, og vises ikke på selskapssiden før de har bekreftet."
      onClose={onClose}
      busy={saving}
      className="max-w-lg"
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        {chosen ? (
          <div className="flex items-center gap-3 rounded-xl px-3 py-2.5 ring-1 ring-brand-500 ring-inset">
            <Avatar name={chosen.fullName} photo={chosen.photo} size="sm" muted={!chosen.claimed} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1 text-sm font-medium text-stone-950">
                <span className="truncate">{chosen.fullName}</span>
                <Verified claimed={chosen.claimed} />
              </span>
              {chosen.currentCompany && (
                <span className="block truncate text-xs text-stone-500">
                  {[chosen.jobTitle, chosen.currentCompany].filter(Boolean).join(', ')}
                </span>
              )}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setChosen(null)}>
              Bytt
            </Button>
          </div>
        ) : (
          <div>
            <Field label="Hvem">
              <span className="relative block">
                <Search
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400"
                  aria-hidden
                />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Søk etter navn"
                  aria-controls={listId}
                  className="pl-9"
                  data-autofocus
                />
              </span>
            </Field>
            <ul id={listId} className="mt-2 max-h-56 space-y-1 overflow-y-auto">
              {term.length >= 2 &&
                hits.map((p) => (
                  <li key={p.personId}>
                    <button
                      type="button"
                      onClick={() => setChosen(p)}
                      className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition hover:bg-stone-50"
                    >
                      <Avatar name={p.fullName} photo={p.photo} size="sm" muted={!p.claimed} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1 text-sm font-medium text-stone-900">
                          <span className="truncate">{p.fullName}</span>
                          <Verified claimed={p.claimed} />
                        </span>
                        {p.currentCompany && (
                          <span className="block truncate text-xs text-stone-500">
                            {[p.jobTitle, p.currentCompany].filter(Boolean).join(', ')}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              {term.length >= 2 && hits.length === 0 && (
                <li className="px-3 py-2 text-sm text-stone-500">Ingen treff blant medlemmene.</li>
              )}
            </ul>
          </div>
        )}
        <LinkFields draft={draft} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} />
        {error && <ErrorText>{error}</ErrorText>}
        <DialogActions>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Avbryt
          </Button>
          <Button type="submit" variant="brand" disabled={saving || !chosen}>
            {saving ? 'Sender …' : 'Send til bekreftelse'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}
