import type { AdminPerson } from '@esaf/core'
import { createFileRoute, Link, notFound, useNavigate, useRouter } from '@tanstack/react-router'
import { Pencil, Plus, Search, SearchX, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { z } from 'zod'
import { Dialog, DialogActions } from '#/components/Dialog.tsx'
import { SearchInput } from '#/components/SearchInput.tsx'
import {
  Avatar,
  Button,
  buttonClass,
  Card,
  cx,
  EmptyState,
  ErrorText,
  Field,
  Input,
  Select,
  Verified,
} from '#/components/ui.tsx'
import { kull, plural } from '#/lib/format.ts'
import { fold } from '#/lib/member-search.ts'
import { fetchAdminPeople, fetchSimilarPeople, newProfile } from '#/lib/people.functions.ts'

export const Route = createFileRoute('/_konto/admin/profiler')({
  beforeLoad: ({ context: { viewer } }) => {
    if (!viewer.permissions.includes('profiles.edit')) throw notFound()
  },
  validateSearch: z.object({
    q: z.string().optional().catch(undefined),
    kull: z.number().int().optional().catch(undefined),
    vis: z
      .enum(['konto', 'profil', 'venter', 'deaktivert', 'uten-kull'])
      .optional()
      .catch(undefined),
  }),
  loader: () => fetchAdminPeople(),
  head: () => ({ meta: [{ title: 'Profiler – Admin – ESAF' }] }),
  component: People,
  errorComponent: ({ error }) => (
    <ErrorText>{error instanceof Error ? error.message : 'Noe gikk galt.'}</ErrorText>
  ),
})

const PAGE = 50
const columns = 'md:grid md:grid-cols-[minmax(0,1fr)_8rem_8rem_3rem] md:items-center md:gap-4'

const sourceLabels: Record<AdminPerson['source'], string> = {
  signup: 'Registrerte seg',
  import: 'Fra kullisten',
  admin: 'Lagt inn av admin',
}

function statusText(p: AdminPerson) {
  if (p.status === 'active') return p.claimed ? 'Aktiv, har konto' : 'Aktiv profil'
  if (p.status === 'pending') return 'Venter'
  if (p.status === 'inactive') return 'Deaktivert'
  return 'Uten medlemskap'
}

/**
 * Alle personer ESAF kjenner til, også profiler som venter og deaktiverte, for å
 * rette kull, e-post og erfaring og slå sammen duplikater på redigeringssiden.
 */
function People() {
  const people = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const [shown, setShown] = useState(PAGE)
  const [creating, setCreating] = useState(false)

  const years = useMemo(
    () => [...new Set(people.flatMap((p) => p.cohortYears))].sort((a, b) => b - a),
    [people],
  )
  const results = useMemo(() => {
    const words = fold(search.q ?? '')
      .split(/\s+/)
      .filter(Boolean)
    return people.filter(
      (p) =>
        words.every((w) => fold(p.fullName).includes(w)) &&
        (!search.kull || p.cohortYears.includes(search.kull)) &&
        (!search.vis ||
          (search.vis === 'konto' && p.claimed) ||
          (search.vis === 'profil' && !p.claimed) ||
          (search.vis === 'venter' && p.status === 'pending') ||
          (search.vis === 'deaktivert' && p.status === 'inactive') ||
          (search.vis === 'uten-kull' && p.cohortYears.length === 0)),
    )
  }, [people, search])

  const setSearch = (patch: Partial<typeof search>) => {
    setShown(PAGE)
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })
  }
  const filtered = Boolean(search.q || search.kull || search.vis)

  return (
    <>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-stone-500">
          Alle personer ESAF kjenner til, med og uten konto. Åpne en person for å rette profil,
          kull, kjente e-postadresser og erfaring, eller slå sammen duplikater. Alt logges.
        </p>
        <Button variant="brand" onClick={() => setCreating(true)}>
          <Plus className="size-4" aria-hidden /> Ny profil
        </Button>
      </div>

      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400"
            aria-hidden
          />
          <SearchInput
            query={search.q ?? ''}
            onSearch={(value) => setSearch({ q: value || undefined })}
            placeholder="Søk på navn"
            aria-label="Søk på navn"
            className="pl-9"
          />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <div className="sm:w-36">
            <Select
              value={search.kull ?? ''}
              onChange={(e) =>
                setSearch({ kull: e.target.value ? Number(e.target.value) : undefined })
              }
              aria-label="Kull"
            >
              <option value="">Alle kull</option>
              {years.map((y) => (
                <option key={y} value={y}>
                  ES {y}
                </option>
              ))}
            </Select>
          </div>
          <div className="sm:w-44">
            <Select
              value={search.vis ?? ''}
              onChange={(e) =>
                setSearch({ vis: (e.target.value || undefined) as typeof search.vis })
              }
              aria-label="Vis"
            >
              <option value="">Alle</option>
              <option value="konto">Med konto</option>
              <option value="profil">Uten konto</option>
              <option value="venter">Venter</option>
              <option value="deaktivert">Deaktiverte</option>
              <option value="uten-kull">Uten kull</option>
            </Select>
          </div>
        </div>
      </div>

      <p className="mb-3 text-sm text-stone-500" aria-live="polite">
        {filtered
          ? plural(results.length, 'treff', 'treff')
          : plural(people.length, 'person', 'personer')}
      </p>

      {results.length === 0 ? (
        <EmptyState icon={SearchX} title="Ingen treff">
          Prøv et annet søk, eller fjern filtrene.
        </EmptyState>
      ) : (
        <>
          <Card className="overflow-hidden">
            <div
              aria-hidden
              className={cx(
                'hidden border-b border-stone-200/70 bg-stone-50/70 px-4 py-2.5 text-xs font-medium text-stone-500',
                columns,
              )}
            >
              <span>Navn</span>
              <span>Status</span>
              <span>Kilde</span>
            </div>
            <ul aria-label="Personer" className="divide-y divide-stone-100">
              {results.slice(0, shown).map((p) => (
                <li key={p.personId} className={cx('flex flex-col gap-1.5 px-4 py-3', columns)}>
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar name={p.fullName} photo={p.photo} size="sm" muted={!p.claimed} />
                    <div className="min-w-0">
                      <p className="flex min-w-0 items-center gap-1.5 text-sm">
                        <Link
                          to="/medlemmer/$personId/rediger"
                          params={{ personId: p.personId }}
                          className="truncate font-medium text-stone-950 hover:text-brand-600"
                        >
                          {p.fullName}
                        </Link>
                        <Verified claimed={p.claimed} />
                      </p>
                      <p className="text-xs text-stone-500">{kull(p.cohortYears) ?? 'Uten kull'}</p>
                    </div>
                  </div>
                  <p
                    className={cx(
                      'pl-11 text-sm md:pl-0',
                      p.status === 'active' ? 'text-stone-700' : 'text-amber-800',
                    )}
                  >
                    {statusText(p)}
                  </p>
                  <p className="pl-11 text-xs text-stone-500 md:pl-0">{sourceLabels[p.source]}</p>
                  <div className="pl-11 md:pl-0 md:text-right">
                    <Link
                      to="/medlemmer/$personId/rediger"
                      params={{ personId: p.personId }}
                      className={buttonClass({ variant: 'ghost', size: 'sm' }, 'px-2')}
                      aria-label={`Rediger ${p.fullName}`}
                    >
                      <Pencil className="size-4" aria-hidden />
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
          {shown < results.length && (
            <div className="mt-6 text-center">
              <Button variant="secondary" onClick={() => setShown((n) => n + PAGE)}>
                Vis flere ({results.length - shown} til)
              </Button>
            </div>
          )}
        </>
      )}

      {creating && <CreateProfileDialog onClose={() => setCreating(false)} />}
    </>
  )
}

/**
 * Ny profil, som en fra kullisten. Viser personer med samme navn og nære kull
 * før den lages, så det ikke blir duplikater.
 */
function CreateProfileDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const [fullName, setFullName] = useState('')
  const [year, setYear] = useState('')
  const [emails, setEmails] = useState<string[]>([''])
  const [active, setActive] = useState(true)
  const [similar, setSimilar] = useState<AdminPerson[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const graduationYear = /^\d{4}$/.test(year) ? Number(year) : null

  useEffect(() => {
    const name = fullName.trim()
    if (name.length < 3) return
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const found = await fetchSimilarPeople({
          data: { fullName: name, years: graduationYear ? [graduationYear] : [] },
        })
        if (!cancelled) setSimilar(found)
      } catch {
        if (!cancelled) setSimilar([])
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [fullName, graduationYear])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (year && !graduationYear)
      return setError('Kullet skrives som uteksamineringsår, f.eks. 2024.')
    setSaving(true)
    setError(null)
    try {
      const { personId } = await newProfile({
        data: {
          fullName,
          cohorts: graduationYear ? [{ graduationYear, relation: 'student' }] : [],
          emails: emails.map((e) => e.trim()).filter(Boolean),
          status: active ? 'active' : 'pending',
        },
      })
      await router.invalidate()
      await router.navigate({ to: '/medlemmer/$personId/rediger', params: { personId } })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke lage profilen.')
      setSaving(false)
    }
  }

  return (
    <Dialog
      title="Ny profil"
      description="En person som ikke står i kullisten. Ingen får tilgang til en konto av dette; kontoer kobles til profilen gjennom forespørsler om tilgang."
      onClose={onClose}
      busy={saving}
      className="max-w-lg"
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_7rem]">
          <Field label="Fullt navn">
            <Input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              required
              minLength={2}
              maxLength={120}
              data-autofocus
            />
          </Field>
          <Field label="Kull" hint="Uteksaminert">
            <Input
              value={year}
              onChange={(e) => setYear(e.target.value.replace(/\D/g, '').slice(0, 4))}
              inputMode="numeric"
              placeholder="2024"
            />
          </Field>
        </div>
        {fullName.trim().length >= 3 && similar.length > 0 && (
          <div className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset">
            <p className="font-medium">Finnes personen allerede?</p>
            <ul className="mt-1.5 space-y-1">
              {similar.map((p) => (
                <li key={p.personId}>
                  <Link
                    to="/medlemmer/$personId/rediger"
                    params={{ personId: p.personId }}
                    className="underline-offset-2 hover:underline"
                  >
                    {p.fullName}
                  </Link>{' '}
                  <span className="text-amber-800/80">
                    · {kull(p.cohortYears) ?? 'uten kull'} · {statusText(p).toLocaleLowerCase('nb')}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-stone-800">Kjente e-postadresser</legend>
          <p className="text-xs text-stone-500">
            Valgfritt. En konto med en av adressene kan be om å få profilen. Vises aldri for andre
            medlemmer.
          </p>
          {emails.map((email, i) => (
            <div key={i} className="flex gap-2">
              <Input
                type="email"
                value={email}
                onChange={(e) =>
                  setEmails((list) => list.map((v, j) => (j === i ? e.target.value : v)))
                }
                aria-label={`E-post ${i + 1}`}
                maxLength={200}
              />
              {emails.length > 1 && (
                <Button
                  variant="ghost"
                  className="h-10 w-10 shrink-0 px-0"
                  onClick={() => setEmails((list) => list.filter((_, j) => j !== i))}
                  aria-label={`Fjern e-post ${i + 1}`}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              )}
            </div>
          ))}
          {emails.length < 5 && (
            <Button variant="ghost" size="sm" onClick={() => setEmails((list) => [...list, ''])}>
              <Plus className="size-4" aria-hidden /> Én til
            </Button>
          )}
        </fieldset>
        <label className="flex cursor-pointer items-start gap-2 text-sm text-stone-700">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="mt-0.5 size-4 rounded border-stone-300 accent-brand-600"
          />
          Vis i katalogen med en gang, som profiler fra kullisten
        </label>
        {error && <ErrorText>{error}</ErrorText>}
        <DialogActions>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Avbryt
          </Button>
          <Button type="submit" variant="brand" disabled={saving || fullName.trim().length < 2}>
            {saving ? 'Lager …' : 'Lag profil og rediger'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}
