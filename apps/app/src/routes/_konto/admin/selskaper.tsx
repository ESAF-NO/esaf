import type { AdminCompany } from '@esaf/core'
import { createFileRoute, Link, notFound, useNavigate, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import {
  ArrowDown,
  ArrowUp,
  CircleCheck,
  GitMerge,
  ImageOff,
  Pencil,
  Plus,
  Search,
  SearchX,
  Trash2,
} from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { z } from 'zod'
import { Dialog, DialogActions } from '#/components/Dialog.tsx'
import {
  Button,
  buttonClass,
  Card,
  CompanyLogo,
  cx,
  EmptyState,
  ErrorText,
  Field,
  Input,
  Select,
  Textarea,
} from '#/components/ui.tsx'
import { statusLabels, statusOrder, type CompanyStatus } from '#/lib/companies.ts'
import { fetchAdminCompanies, newCompany, removeCompany } from '#/lib/companies.functions.ts'
import { plural } from '#/lib/format.ts'
import { fold } from '#/lib/member-search.ts'

const statusSlugs = {
  active: 'aktiv',
  acquired: 'oppkjopt',
  closed: 'nedlagt',
  unknown: 'ukjent',
} as const satisfies Record<CompanyStatus, string>
const statusBySlug = Object.fromEntries(
  Object.entries(statusSlugs).map(([k, v]) => [v, k as CompanyStatus]),
) as Record<string, CompanyStatus>

const missing = {
  logo: 'Uten logo',
  beskrivelse: 'Uten beskrivelse',
  personer: 'Ingen knyttet til',
  historikk: 'Uten historikk',
} as const

const sorts = {
  navn: 'Navn',
  personer: 'Flest personer',
  nyest: 'Sist opprettet',
  redigert: 'Sist redigert',
} as const

export const Route = createFileRoute('/_konto/admin/selskaper')({
  beforeLoad: ({ context: { viewer } }) => {
    if (!viewer.permissions.includes('profiles.edit')) throw notFound()
  },
  validateSearch: z.object({
    q: z.string().optional().catch(undefined),
    status: z
      .enum(Object.values(statusSlugs) as [string, ...string[]])
      .optional()
      .catch(undefined),
    mangler: z
      .enum(Object.keys(missing) as [keyof typeof missing])
      .optional()
      .catch(undefined),
    es: z.enum(['ja', 'nei']).optional().catch(undefined),
    kull: z.number().int().optional().catch(undefined),
    sorter: z
      .enum(Object.keys(sorts) as [keyof typeof sorts])
      .optional()
      .catch(undefined),
    synkende: z.boolean().optional().catch(undefined),
  }),
  loader: () => fetchAdminCompanies(),
  head: () => ({ meta: [{ title: 'Selskaper – Admin – ESAF' }] }),
  component: Companies,
  errorComponent: ({ error }) => (
    <ErrorText>{error instanceof Error ? error.message : 'Noe gikk galt.'}</ErrorText>
  ),
})

const PAGE = 50
const columns =
  'md:grid md:grid-cols-[minmax(0,1fr)_7rem_6rem_7rem_8.5rem] md:items-center md:gap-4'

function Companies() {
  const companies = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const [shown, setShown] = useState(PAGE)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<AdminCompany | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const years = useMemo(
    () => [...new Set(companies.flatMap((c) => c.cohortYears))].sort((a, b) => b - a),
    [companies],
  )

  const results = useMemo(() => {
    const words = fold(search.q ?? '')
      .split(/\s+/)
      .filter(Boolean)
    const status = search.status ? statusBySlug[search.status] : null
    const sort = search.sorter ?? 'navn'
    const list = companies.filter(
      (c) =>
        words.every((w) => fold(`${c.name} ${c.slug} ${c.website ?? ''}`).includes(w)) &&
        (!status || c.status === status) &&
        (!search.es || (search.es === 'ja') === c.esCompany) &&
        (!search.kull || c.cohortYears.includes(search.kull)) &&
        (!search.mangler ||
          (search.mangler === 'logo' && !c.logo) ||
          (search.mangler === 'beskrivelse' && !c.hasDescription) ||
          (search.mangler === 'personer' && c.people === 0) ||
          (search.mangler === 'historikk' && c.events === 0)),
    )
    const time = (d: Date | string | null) => (d ? new Date(d).getTime() : 0)
    const compare: Record<keyof typeof sorts, (a: AdminCompany, b: AdminCompany) => number> = {
      navn: (a, b) => a.name.localeCompare(b.name, 'nb'),
      personer: (a, b) => b.people - a.people || a.name.localeCompare(b.name, 'nb'),
      nyest: (a, b) => time(b.createdAt) - time(a.createdAt),
      redigert: (a, b) => time(b.editedAt) - time(a.editedAt),
    }
    const sorted = [...list].sort(compare[sort])
    return search.synkende ? sorted.reverse() : sorted
  }, [companies, search])

  const filtered = Boolean(search.q || search.status || search.mangler || search.es || search.kull)
  const setSearch = (patch: Partial<typeof search>) => {
    setShown(PAGE)
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })
  }

  return (
    <>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-stone-500">
          Alle selskaper, også dem ingen er knyttet til. Finn hull, slå sammen duplikater og rydd.
          Oppretting og sletting logges.
        </p>
        <Button variant="brand" onClick={() => setCreating(true)}>
          <Plus className="size-4" aria-hidden /> Nytt selskap
        </Button>
      </div>

      <div className="mb-4 space-y-2">
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400"
            aria-hidden
          />
          <Input
            type="search"
            value={search.q ?? ''}
            onChange={(e) => setSearch({ q: e.target.value || undefined })}
            placeholder="Søk på navn eller nettside"
            aria-label="Søk på navn eller nettside"
            className="pl-9"
          />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <Select
            value={search.status ?? ''}
            onChange={(e) => setSearch({ status: e.target.value || undefined })}
            aria-label="Status"
          >
            <option value="">Alle statuser</option>
            {statusOrder.map((s) => (
              <option key={s} value={statusSlugs[s]}>
                {statusLabels[s]}
              </option>
            ))}
          </Select>
          <Select
            value={search.mangler ?? ''}
            onChange={(e) =>
              setSearch({ mangler: (e.target.value || undefined) as typeof search.mangler })
            }
            aria-label="Mangler"
          >
            <option value="">Alt utfylt eller ikke</option>
            {Object.entries(missing).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          <Select
            value={search.es ?? ''}
            onChange={(e) => setSearch({ es: (e.target.value || undefined) as typeof search.es })}
            aria-label="ES-selskap"
          >
            <option value="">ES-selskap eller ikke</option>
            <option value="ja">ES-selskap</option>
            <option value="nei">Ikke ES-selskap</option>
          </Select>
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
          <div className="flex gap-1">
            <Select
              value={search.sorter ?? 'navn'}
              onChange={(e) =>
                setSearch({
                  sorter:
                    e.target.value === 'navn'
                      ? undefined
                      : (e.target.value as typeof search.sorter),
                })
              }
              aria-label="Sorter"
            >
              {Object.entries(sorts).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
            <Button
              variant="secondary"
              className="h-10 w-10 shrink-0 px-0"
              onClick={() => setSearch({ synkende: search.synkende ? undefined : true })}
              aria-label={search.synkende ? 'Vanlig rekkefølge' : 'Snu rekkefølgen'}
              aria-pressed={Boolean(search.synkende)}
            >
              {search.synkende ? (
                <ArrowUp className="size-4" aria-hidden />
              ) : (
                <ArrowDown className="size-4" aria-hidden />
              )}
            </Button>
          </div>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-sm text-stone-500" aria-live="polite">
          {filtered
            ? plural(results.length, 'treff', 'treff')
            : plural(companies.length, 'selskap', 'selskaper')}
        </p>
        <div role="status">
          {notice && (
            <p className="flex items-center gap-1.5 text-sm font-medium text-emerald-700">
              <CircleCheck className="size-4 shrink-0" aria-hidden /> {notice}
            </p>
          )}
        </div>
      </div>

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
              <span>Selskap</span>
              <span>Status</span>
              <span>Personer</span>
              <span>Kull</span>
            </div>
            <ul aria-label="Selskaper" className="divide-y divide-stone-100">
              {results.slice(0, shown).map((c) => (
                <CompanyRow key={c.id} company={c} onDelete={() => setDeleting(c)} />
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

      {creating && <CreateDialog onClose={() => setCreating(false)} />}
      {deleting && (
        <DeleteDialog
          company={deleting}
          onClose={() => setDeleting(null)}
          onDone={(message) => {
            setDeleting(null)
            setNotice(message)
          }}
        />
      )}
    </>
  )
}

function CompanyRow({ company: c, onDelete }: { company: AdminCompany; onDelete: () => void }) {
  const gaps = [
    !c.logo && 'logo',
    !c.hasDescription && 'beskrivelse',
    c.events === 0 && 'historikk',
  ].filter(Boolean)
  return (
    <li className={cx('flex flex-col gap-2 px-4 py-3', columns)}>
      <div className="flex min-w-0 items-center gap-3">
        <CompanyLogo name={c.name} logo={c.logo} size="sm" />
        <div className="min-w-0">
          <p className="flex min-w-0 items-baseline gap-2 text-sm">
            <Link
              to="/selskaper/$slug"
              params={{ slug: c.slug }}
              className="truncate font-medium text-stone-950 hover:text-brand-600"
            >
              {c.name}
            </Link>
            {c.esCompany && <span className="shrink-0 text-xs text-brand-700">ES-selskap</span>}
            {c.suggestions > 0 && (
              <Link
                to="/selskaper/$slug"
                params={{ slug: c.slug }}
                hash="forslag"
                className="shrink-0 rounded-full bg-amber-100 px-1.5 text-xs font-medium text-amber-800"
              >
                {plural(c.suggestions, 'forslag', 'forslag')}
              </Link>
            )}
          </p>
          <p className="flex items-center gap-1 truncate text-xs text-stone-500">
            {gaps.length > 0 && <ImageOff className="size-3 shrink-0" aria-hidden />}
            {gaps.length ? `Mangler ${gaps.join(', ')}` : (c.tagline ?? 'Utfylt')}
          </p>
        </div>
      </div>
      <p className="pl-12 text-sm text-stone-700 md:pl-0">{statusLabels[c.status]}</p>
      <p className="pl-12 text-sm text-stone-700 tabular-nums md:pl-0">
        {c.people}
        {c.founders > 0 && <span className="text-xs text-stone-500"> ({c.founders} gr.)</span>}
      </p>
      <p className="truncate pl-12 text-xs text-stone-500 md:pl-0">
        {c.cohortYears.length ? `ES ${c.cohortYears.join(', ')}` : '–'}
      </p>
      <div className="flex gap-1 pl-12 md:justify-end md:pl-0">
        <Link
          to="/selskaper/$slug/rediger"
          params={{ slug: c.slug }}
          className={buttonClass({ variant: 'ghost', size: 'sm' }, 'px-2')}
          aria-label={`Rediger ${c.name}`}
          title="Rediger"
        >
          <Pencil className="size-4" aria-hidden />
        </Link>
        <Link
          to="/selskaper/$slug/rediger"
          params={{ slug: c.slug }}
          hash="sla-sammen"
          className={buttonClass({ variant: 'ghost', size: 'sm' }, 'px-2')}
          aria-label={`Slå sammen ${c.name} med et annet selskap`}
          title="Slå sammen"
        >
          <GitMerge className="size-4" aria-hidden />
        </Link>
        <Button
          variant="danger"
          size="sm"
          className="px-2"
          onClick={onDelete}
          aria-label={`Slett ${c.name}`}
          title="Slett"
        >
          <Trash2 className="size-4" aria-hidden />
        </Button>
      </div>
    </li>
  )
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const create = useServerFn(newCompany)
  const [status, setStatus] = useState<CompanyStatus>('active')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const text = (name: string) => String(form.get(name) ?? '')
    setSaving(true)
    setError(null)
    try {
      const { slug } = await create({
        data: {
          name: text('name'),
          tagline: text('tagline'),
          description: '',
          website: text('website'),
          foundedYear: null,
          location: '',
          industries: [],
          status,
        },
      })
      await router.invalidate()
      await router.navigate({ to: '/selskaper/$slug/rediger', params: { slug } })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke opprette selskapet.')
      setSaving(false)
    }
  }

  return (
    <Dialog
      title="Nytt selskap"
      description="Resten fyller du ut på redigeringssiden etterpå. Opprettingen logges."
      onClose={onClose}
      busy={saving}
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Navn">
          <Input name="name" required maxLength={120} data-autofocus />
        </Field>
        <Field label="Kort beskrivelse" hint="Valgfritt.">
          <Input name="tagline" maxLength={140} />
        </Field>
        <Field label="Nettside" hint="Valgfritt.">
          <Input name="website" inputMode="url" maxLength={300} placeholder="syrlig.no" />
        </Field>
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value as CompanyStatus)}>
            {statusOrder.map((s) => (
              <option key={s} value={s}>
                {statusLabels[s]}
              </option>
            ))}
          </Select>
        </Field>
        {error && <ErrorText>{error}</ErrorText>}
        <DialogActions>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Avbryt
          </Button>
          <Button type="submit" variant="brand" disabled={saving}>
            {saving ? 'Oppretter …' : 'Opprett og rediger'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

/**
 * Sletting. Er noen knyttet til selskapet, må admin bekrefte at koblingene fjernes
 * fra profilene og skrive en begrunnelse. Å slå sammen er ofte riktigere.
 */
function DeleteDialog({
  company: c,
  onClose,
  onDone,
}: {
  company: AdminCompany
  onClose: () => void
  onDone: (message: string) => void
}) {
  const router = useRouter()
  const remove = useServerFn(removeCompany)
  const [unlink, setUnlink] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const linked = c.people > 0

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim()
    if (linked && !unlink) return setError('Bekreft at koblingene skal fjernes.')
    if (linked && reason.length < 3)
      return setError('Skriv en kort begrunnelse. Den lagres i loggen.')
    setSaving(true)
    setError(null)
    try {
      await remove({ data: { companyId: c.id, unlink, reason } })
      await router.invalidate()
      onDone(`${c.name} er slettet.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke slette.')
      setSaving(false)
    }
  }

  return (
    <Dialog
      title={`Slette ${c.name}?`}
      description={
        <>
          <p>
            Selskapssiden, historikken ({plural(c.events, 'hendelse', 'hendelser')}), logoen og åpne
            forslag slettes. Sitater beholdes, men uten selskapet. Det kan ikke angres.
          </p>
          {linked && (
            <p className="text-amber-800">
              {plural(c.people, 'person', 'personer')} er knyttet til {c.name}. Er det samme selskap
              som et annet, bør du heller{' '}
              <Link
                to="/selskaper/$slug/rediger"
                params={{ slug: c.slug }}
                hash="sla-sammen"
                className="font-medium underline"
              >
                slå dem sammen
              </Link>
              .
            </p>
          )}
        </>
      }
      onClose={onClose}
      busy={saving}
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        {linked && (
          <label className="flex cursor-pointer items-start gap-2 text-sm text-stone-700">
            <input
              type="checkbox"
              checked={unlink}
              onChange={(e) => setUnlink(e.target.checked)}
              className="mt-0.5 size-4 rounded border-stone-300 accent-red-600"
            />
            Fjern {c.name} fra erfaringen og ES-selskapet til{' '}
            {plural(c.people, 'personen', 'personene')}
          </label>
        )}
        <Field
          label="Begrunnelse"
          hint={linked ? 'Påkrevd. Lagres i loggen.' : 'Valgfritt. Lagres i loggen.'}
        >
          <Textarea name="reason" rows={2} maxLength={500} data-autofocus />
        </Field>
        {error && <ErrorText>{error}</ErrorText>}
        <DialogActions>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Avbryt
          </Button>
          <Button type="submit" variant="destructive" disabled={saving || (linked && !unlink)}>
            {saving ? 'Sletter …' : 'Slett selskapet'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}
