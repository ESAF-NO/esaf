import type { AdminBadge, BadgeColor, BadgeIcon, BadgePreview, BadgeRuleKind } from '@esaf/core'
import { createFileRoute, Link, notFound, useNavigate, useRouter } from '@tanstack/react-router'
import { Archive, Award, Gift, Pencil, Plus, Send, Trash2, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { z } from 'zod'
import { BadgeMedal, badgeColorClasses, badgeIconComponents } from '#/components/Badges.tsx'
import { Dialog, DialogActions } from '#/components/Dialog.tsx'
import {
  Button,
  buttonClass,
  Card,
  cx,
  EmptyState,
  ErrorText,
  Field,
  Input,
  Select,
  Textarea,
} from '#/components/ui.tsx'
import {
  changeBadgeStatus,
  fetchAdminBadge,
  fetchAdminBadges,
  fetchAwardCandidates,
  fetchBadgeOptions,
  giveBadge,
  newBadge,
  previewBadge,
  removeBadge,
  saveBadge,
  takeBadge,
} from '#/lib/badges.functions.ts'
import { plural } from '#/lib/format.ts'

export const Route = createFileRoute('/_konto/admin/merker')({
  // `merke` åpner et merke for redigering, f.eks. fra «Endre merket» på merkesiden.
  validateSearch: z.object({ merke: z.uuid().optional().catch(undefined) }),
  beforeLoad: ({ context: { viewer } }) => {
    if (!viewer.permissions.includes('badges.manage')) throw notFound()
  },
  loader: async () => {
    const [badges, options] = await Promise.all([fetchAdminBadges(), fetchBadgeOptions()])
    return { badges, options }
  },
  head: () => ({ meta: [{ title: 'Merker – Admin – ESAF' }] }),
  component: AdminBadgesPage,
})

type Options = Awaited<ReturnType<typeof fetchBadgeOptions>>

const statusLabels = { published: 'Publisert', draft: 'Utkast', archived: 'Arkivert' } as const

function AdminBadgesPage() {
  const { badges, options } = Route.useLoaderData()
  const { merke } = Route.useSearch()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const [awarding, setAwarding] = useState<AdminBadge | null>(null)
  const editing = badges.find((b) => b.id === merke) ?? null
  const close = () => navigate({ to: '/admin/merker', search: {}, replace: true })

  const groups = (['published', 'draft', 'archived'] as const)
    .map((status) => ({ status, badges: badges.filter((b) => b.status === status) }))
    .filter((g) => g.badges.length)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl text-sm text-stone-600">
          <p>
            Merker deles ut av seg selv etter regelen, ut fra det som allerede står i appen:
            arrangementer, kull, styret, selskaper og profilen. Lag dem som utkast, se hvem som får
            dem, og publiser når de er klare. Da dukker de opp på profilene, uten varsler.
          </p>
          <p className="mt-2 text-stone-500">
            Du kan også be Claude om det med MCP: «Lag merker for ESAF-helgen og for gründere».
          </p>
        </div>
        <Button variant="brand" onClick={() => setCreating(true)}>
          <Plus className="size-4" aria-hidden /> Nytt merke
        </Button>
      </div>

      {groups.length === 0 ? (
        <EmptyState icon={Award} title="Ingen merker ennå">
          Lag det første, for eksempel «ESAF-helgen ×3» eller «Startet selskap på ES».
        </EmptyState>
      ) : (
        groups.map((g) => (
          <section key={g.status} aria-labelledby={`merker-${g.status}`}>
            <h2 id={`merker-${g.status}`} className="mb-2 text-sm font-semibold text-stone-950">
              {statusLabels[g.status]}{' '}
              <span className="font-normal text-stone-500 tabular-nums">{g.badges.length}</span>
            </h2>
            <Card className="divide-y divide-stone-100">
              {g.badges.map((b) => (
                <BadgeRow key={b.id} badge={b} onAward={() => setAwarding(b)} />
              ))}
            </Card>
          </section>
        ))
      )}

      {creating && <BadgeEditor options={options} onClose={() => setCreating(false)} />}
      {editing && (
        <BadgeEditor key={editing.id} badge={editing} options={options} onClose={close} />
      )}
      {awarding && <AwardDialog badge={awarding} onClose={() => setAwarding(null)} />}
    </div>
  )
}

function BadgeRow({ badge: b, onAward }: { badge: AdminBadge; onAward: () => void }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  async function act(action: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      await router.invalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke lagre.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="p-4">
      <div className="flex flex-wrap items-center gap-4">
        <BadgeMedal badge={b} earned={b.status !== 'archived'} />
        <div className="min-w-0 flex-1 basis-60">
          <p className="font-semibold text-stone-950">
            {b.name}
            {b.series && (
              <span className="ml-2 text-xs font-normal text-stone-500">Serie: {b.series}</span>
            )}
          </p>
          <p className="text-sm text-stone-600">{b.ruleText}</p>
          <p className="text-xs text-stone-500">
            {b.status === 'draft'
              ? 'Ikke delt ut'
              : `${plural(b.visible, 'medlem', 'medlemmer')} har det${
                  b.awarded > b.visible ? ` (${b.awarded} med profiler som ikke er aktive)` : ''
                }`}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {b.manual && b.status !== 'archived' && (
            <Button variant="secondary" size="sm" onClick={onAward} disabled={busy}>
              <Gift className="size-3.5" aria-hidden /> Del ut
            </Button>
          )}
          <Link
            to="/admin/merker"
            search={{ merke: b.id }}
            className={buttonClass({ variant: 'secondary', size: 'sm' })}
          >
            <Pencil className="size-3.5" aria-hidden /> Rediger
          </Link>
          {b.status !== 'published' ? (
            <Button
              variant="brand"
              size="sm"
              disabled={busy}
              onClick={() =>
                act(() => changeBadgeStatus({ data: { badgeId: b.id, status: 'published' } }))
              }
            >
              <Send className="size-3.5" aria-hidden /> Publiser
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() =>
                act(() => changeBadgeStatus({ data: { badgeId: b.id, status: 'archived' } }))
              }
            >
              <Archive className="size-3.5" aria-hidden /> Arkiver
            </Button>
          )}
          <Button
            variant="danger"
            size="sm"
            disabled={busy}
            onClick={() => setDeleting(true)}
            aria-label={`Slett ${b.name}`}
          >
            <Trash2 className="size-3.5" aria-hidden />
          </Button>
        </div>
      </div>
      {error && (
        <div className="mt-3">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      {deleting && (
        <Dialog
          title={`Slette «${b.name}»?`}
          description={
            <p>
              {b.awarded
                ? `${plural(b.awarded, 'person', 'personer')} mister merket, og varslene om det forsvinner. `
                : ''}
              Det kan ikke angres. Vil du bare slutte å vise det, kan du arkivere det i stedet.
            </p>
          }
          onClose={() => setDeleting(false)}
          busy={busy}
        >
          <DialogActions>
            <Button variant="secondary" onClick={() => setDeleting(false)} disabled={busy}>
              Avbryt
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => act(() => removeBadge({ data: { badgeId: b.id } }))}
            >
              Slett merket
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Skjemaet: navn, utseende og regel, med forhåndsvisning
// ---------------------------------------------------------------------------

/** Regelen mens den redigeres. Valideres av serveren (`badgeRule` i @esaf/core). */
type RuleDraft = { kind: BadgeRuleKind } & Record<string, unknown>

function defaultRule(kind: BadgeRuleKind, options: Options): RuleDraft {
  const weekend = options.eventTypes.find((t) => t.slug === 'esaf-helgen')?.id ?? null
  switch (kind) {
    case 'event_count':
      return { kind, eventTypeId: weekend, roles: [], count: 3 }
    case 'event_streak':
      return { kind, eventTypeId: weekend, years: 3 }
    case 'event_attended':
      return { kind, eventIds: [], match: 'any' }
    case 'cohort':
      return { kind, relations: ['student'], fromYear: null, toYear: null }
    case 'board':
      return { kind, roles: [], current: false }
    case 'cohort_representative':
      return { kind, current: false }
    case 'company':
      return { kind, link: 'es_company', statuses: [], count: 1 }
    case 'profile':
      return { kind, fields: ['photo', 'bio', 'experience'] }
    case 'community':
      return { kind, metric: 'posts', count: 1 }
    case 'manual':
      return { kind }
  }
}

function BadgeEditor({
  badge,
  options,
  onClose,
}: {
  badge?: AdminBadge
  options: Options
  onClose: () => void
}) {
  const router = useRouter()
  const [name, setName] = useState(badge?.name ?? '')
  const [description, setDescription] = useState(badge?.description ?? '')
  const [icon, setIcon] = useState<BadgeIcon>(badge?.icon ?? 'award')
  const [color, setColor] = useState<BadgeColor>(badge?.color ?? 'brand')
  const [series, setSeries] = useState(badge?.series ?? '')
  const [sortOrder, setSortOrder] = useState(badge?.sortOrder ?? 100)
  const [rule, setRule] = useState<RuleDraft>(
    (badge?.rule as RuleDraft | undefined) ?? defaultRule('event_count', options),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const preview = usePreview(rule)
  // Har noen merket, kan det ikke bytte mellom regel og «for hånd» (se `updateBadge`).
  const lockedKind = badge && badge.awarded > 0 ? (badge.manual ? 'manual' : 'auto') : null

  async function save(publish: boolean) {
    setBusy(true)
    setError(null)
    const values = {
      name,
      description,
      icon,
      color,
      rule,
      series: series.trim() || null,
      sortOrder,
    }
    try {
      if (badge) await saveBadge({ data: { badgeId: badge.id, ...values } })
      else await newBadge({ data: { ...values, publish } })
      await router.invalidate()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke lagre.')
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={badge ? `Rediger «${badge.name}»` : 'Nytt merke'}
      onClose={onClose}
      busy={busy}
      // `sm:` vinner over standardbredden til dialogen.
      className="sm:max-w-3xl"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void save(false)
        }}
        className="space-y-5"
      >
        <div className="flex items-start gap-4">
          <BadgeMedal badge={{ icon, color }} size="lg" />
          <div className="min-w-0 flex-1 space-y-3">
            <Field label="Navn" hint="Kort, som «ESAF-helgen ×5» eller «Ildsjel».">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={40}
                required
                data-autofocus
              />
            </Field>
            <Field label="Hva som skal til" hint="Vises for medlemmene: «Vært på fem ESAF-helger.»">
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={200}
                required
                className="min-h-16"
              />
            </Field>
          </div>
        </div>

        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-stone-800">Ikon</legend>
          <div className="flex flex-wrap gap-1.5">
            {options.icons.map((value) => {
              const Icon = badgeIconComponents[value]
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setIcon(value)}
                  aria-label={value}
                  aria-pressed={icon === value}
                  className={cx(
                    'grid size-9 place-items-center rounded-lg ring-1 transition ring-inset',
                    icon === value
                      ? 'bg-stone-900 text-white ring-stone-900'
                      : 'text-stone-600 ring-stone-200 hover:bg-stone-50',
                  )}
                >
                  <Icon className="size-4" aria-hidden />
                </button>
              )
            })}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-stone-800">Farge</legend>
          <div className="flex flex-wrap gap-2">
            {options.colors.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setColor(value)}
                aria-label={value}
                aria-pressed={color === value}
                className={cx(
                  'size-8 rounded-full ring-2 ring-offset-2 transition',
                  badgeColorClasses[value].medal,
                  color === value ? 'ring-stone-900' : 'ring-transparent',
                )}
              />
            ))}
          </div>
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Serie (valgfritt)"
            hint="Trinn på samme stige, som «ESAF-helgen». Profilen viser bare det høyeste."
          >
            <Input value={series} onChange={(e) => setSeries(e.target.value)} maxLength={40} />
          </Field>
          <Field label="Rekkefølge" hint="Lavest først. I en serie: høyere trinn, høyere tall.">
            <Input
              type="number"
              value={sortOrder}
              onChange={(e) => setSortOrder(Number(e.target.value))}
              min={0}
              max={10000}
            />
          </Field>
        </div>

        <RuleEditor rule={rule} onChange={setRule} options={options} lockedKind={lockedKind} />

        <PreviewBox preview={preview} manual={rule.kind === 'manual'} />

        {error && <ErrorText>{error}</ErrorText>}
        <DialogActions>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Avbryt
          </Button>
          {badge ? (
            <Button type="submit" variant="brand" disabled={busy}>
              {busy ? 'Lagrer …' : 'Lagre'}
            </Button>
          ) : (
            <>
              <Button type="submit" variant="secondary" disabled={busy}>
                Lagre som utkast
              </Button>
              <Button variant="brand" onClick={() => save(true)} disabled={busy}>
                {busy ? 'Lagrer …' : 'Lagre og publiser'}
              </Button>
            </>
          )}
        </DialogActions>
      </form>
    </Dialog>
  )
}

/** Hvem som ville fått merket, hentet på nytt kort tid etter at regelen er endret. */
function usePreview(rule: RuleDraft) {
  const [state, setState] = useState<
    { ok: true; preview: BadgePreview } | { ok: false; error: string } | null
  >(null)
  const key = JSON.stringify(rule)
  useEffect(() => {
    let current = true
    const timer = setTimeout(async () => {
      try {
        const preview = await previewBadge({ data: { rule: JSON.parse(key) } })
        if (current) setState({ ok: true, preview })
      } catch (e) {
        if (current)
          setState({ ok: false, error: e instanceof Error ? e.message : 'Ugyldig regel.' })
      }
    }, 350)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [key])
  return state
}

function PreviewBox({
  preview,
  manual,
}: {
  preview: ReturnType<typeof usePreview>
  manual: boolean
}) {
  if (manual) {
    return (
      <p className="rounded-xl bg-stone-50 px-4 py-3 text-sm text-stone-600 ring-1 ring-stone-200 ring-inset">
        Merket deles ut for hånd med «Del ut», med en begrunnelse som vises.
      </p>
    )
  }
  return (
    <div
      className="rounded-xl bg-stone-50 px-4 py-3 text-sm ring-1 ring-stone-200 ring-inset"
      aria-live="polite"
    >
      {!preview ? (
        <p className="text-stone-500">Regner ut hvem som får merket …</p>
      ) : !preview.ok ? (
        <p className="text-amber-800">{preview.error}</p>
      ) : (
        <PreviewResult preview={preview.preview} />
      )}
    </div>
  )
}

function PreviewResult({ preview: p }: { preview: BadgePreview }) {
  const others = p.total - p.activeMembers
  const names = p.sample.filter((x) => x.status === 'active').slice(0, 8)
  return (
    <>
      <p className="font-medium text-stone-900">{p.ruleText}</p>
      <p className="mt-0.5 text-stone-600">
        {p.activeMembers === 0
          ? 'Ingen medlemmer ville fått merket nå'
          : `${plural(p.activeMembers, 'medlem', 'medlemmer')} ville fått merket nå`}
        {others > 0 && ` (og ${plural(others, 'profil', 'profiler')} som ikke er aktive)`}.
      </p>
      {names.length > 0 && (
        <p className="mt-1 text-xs text-stone-500">
          Blant annet {names.map((x) => x.fullName).join(', ')}
        </p>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Regelen
// ---------------------------------------------------------------------------

const eventRoleNames = {
  participant: 'Deltaker',
  organizer: 'Arrangør',
  speaker: 'Foredragsholder',
  volunteer: 'Frivillig',
} as const
const relationNames = { student: 'Student', staff: 'Ansatt', mentor: 'Mentor' } as const
const companyStatusNames = {
  active: 'I drift',
  acquired: 'Kjøpt opp',
  closed: 'Lagt ned',
  unknown: 'Ukjent',
} as const
const companyLinkNames = {
  es_company: 'Selskapet de startet på ES',
  founder: 'Grunnlagt (gründer)',
  any: 'Grunnlagt eller jobbet i',
} as const

function RuleEditor({
  rule,
  onChange,
  options,
  lockedKind,
}: {
  rule: RuleDraft
  onChange: (rule: RuleDraft) => void
  options: Options
  lockedKind: 'manual' | 'auto' | null
}) {
  const set = (patch: Record<string, unknown>) => onChange({ ...rule, ...patch })
  const list = (key: string) => (rule[key] as string[] | undefined) ?? []
  const toggleIn = (key: string, value: string) =>
    set({
      [key]: list(key).includes(value)
        ? list(key).filter((v) => v !== value)
        : [...list(key), value],
    })
  const kinds = options.ruleKinds.filter(
    (k) => !lockedKind || (lockedKind === 'manual' ? k.kind === 'manual' : k.kind !== 'manual'),
  )
  const help = options.ruleKinds.find((k) => k.kind === rule.kind)?.help

  const typeSelect = (
    <Field label="Arrangementstype">
      <Select
        value={(rule.eventTypeId as string | null) ?? ''}
        onChange={(e) => set({ eventTypeId: e.target.value || null })}
      >
        <option value="">Alle typer</option>
        {options.eventTypes.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </Select>
    </Field>
  )
  const number = (key: string, label: string, min = 1, max = 1000) => (
    <Field label={label}>
      <Input
        type="number"
        min={min}
        max={max}
        value={(rule[key] as number | null) ?? ''}
        onChange={(e) => set({ [key]: e.target.value === '' ? null : Number(e.target.value) })}
      />
    </Field>
  )

  return (
    <fieldset className="space-y-3 rounded-xl p-4 ring-1 ring-stone-200 ring-inset">
      <legend className="px-1 text-sm font-medium text-stone-800">Hvem får merket</legend>
      <Field label="Regel" hint={help}>
        <Select
          value={rule.kind}
          onChange={(e) => onChange(defaultRule(e.target.value as BadgeRuleKind, options))}
        >
          {kinds.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.label}
            </option>
          ))}
        </Select>
      </Field>

      {rule.kind === 'event_count' && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            {typeSelect}
            {number('count', 'Minst antall ganger', 1, 200)}
          </div>
          <Checks
            label="Som (ingen valgt: alle roller)"
            values={Object.entries(eventRoleNames)}
            selected={list('roles')}
            onToggle={(v) => toggleIn('roles', v)}
          />
        </>
      )}
      {rule.kind === 'event_streak' && (
        <div className="grid gap-3 sm:grid-cols-2">
          {typeSelect}
          {number('years', 'År på rad', 2, 50)}
        </div>
      )}
      {rule.kind === 'event_attended' && (
        <EventPicker
          options={options}
          selected={list('eventIds')}
          onChange={(eventIds) => set({ eventIds })}
          match={(rule.match as 'any' | 'all') ?? 'any'}
          onMatch={(match) => set({ match })}
        />
      )}
      {rule.kind === 'cohort' && (
        <>
          <Checks
            label="Tilknytning"
            values={Object.entries(relationNames)}
            selected={list('relations')}
            onToggle={(v) => toggleIn('relations', v)}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            {number('fromYear', 'Fra kull (valgfritt)', 1990, 2100)}
            {number('toYear', 'Til kull (valgfritt)', 1990, 2100)}
          </div>
        </>
      )}
      {rule.kind === 'board' && (
        <>
          <Checks
            label="Rolle (ingen valgt: alle)"
            values={options.boardRoles.map((r) => [r.role, r.name])}
            selected={list('roles')}
            onToggle={(v) => toggleIn('roles', v)}
          />
          <Check
            label="Bare de som sitter i styret nå"
            checked={rule.current === true}
            onChange={(current) => set({ current })}
          />
        </>
      )}
      {rule.kind === 'cohort_representative' && (
        <Check
          label="Bare de som er kullrepresentant nå"
          checked={rule.current === true}
          onChange={(current) => set({ current })}
        />
      )}
      {rule.kind === 'company' && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Selskaper">
              <Select value={rule.link as string} onChange={(e) => set({ link: e.target.value })}>
                {Object.entries(companyLinkNames).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
            {number('count', 'Minst antall selskaper', 1, 20)}
          </div>
          <Checks
            label="Status (ingen valgt: alle)"
            values={Object.entries(companyStatusNames)}
            selected={list('statuses')}
            onToggle={(v) => toggleIn('statuses', v)}
          />
        </>
      )}
      {rule.kind === 'profile' && (
        <Checks
          label="Feltene som må være fylt ut"
          values={options.profileFields.map((f) => [f.field, f.name])}
          selected={list('fields')}
          onToggle={(v) => toggleIn('fields', v)}
        />
      )}
      {rule.kind === 'community' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Hva">
            <Select value={rule.metric as string} onChange={(e) => set({ metric: e.target.value })}>
              <option value="posts">Innlegg</option>
              <option value="comments">Kommentarer</option>
            </Select>
          </Field>
          {number('count', 'Minst antall', 1, 1000)}
        </div>
      )}
    </fieldset>
  )
}

function Checks({
  label,
  values,
  selected,
  onToggle,
}: {
  label: string
  values: [string, string][]
  selected: string[]
  onToggle: (value: string) => void
}) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium text-stone-800">{label}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {values.map(([value, name]) => (
          <Check
            key={value}
            label={name}
            checked={selected.includes(value)}
            onChange={() => onToggle(value)}
          />
        ))}
      </div>
    </fieldset>
  )
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: ReactNode
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-stone-700">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 accent-brand-600"
      />
      {label}
    </label>
  )
}

/** Bestemte arrangementer: søk, kryss av, og ett eller alle. */
function EventPicker({
  options,
  selected,
  onChange,
  match,
  onMatch,
}: {
  options: Options
  selected: string[]
  onChange: (ids: string[]) => void
  match: 'any' | 'all'
  onMatch: (match: 'any' | 'all') => void
}) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLocaleLowerCase('nb')
  const shown = options.events
    .filter((e) => selected.includes(e.id) || !q || e.name.toLocaleLowerCase('nb').includes(q))
    .slice(0, 60)
  return (
    <div className="space-y-2">
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <Input
          type="search"
          placeholder="Søk etter arrangement"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Søk etter arrangement"
        />
        <Select
          value={match}
          onChange={(e) => onMatch(e.target.value as 'any' | 'all')}
          aria-label="Ett eller alle"
        >
          <option value="any">Ett av dem</option>
          <option value="all">Alle</option>
        </Select>
      </div>
      <ul className="max-h-56 divide-y divide-stone-100 overflow-y-auto rounded-lg ring-1 ring-stone-200 ring-inset">
        {shown.map((e) => (
          <li key={e.id} className="px-3 py-2">
            <Check
              label={
                <>
                  {e.name}{' '}
                  <span className="text-stone-400 tabular-nums">{e.startDate.slice(0, 4)}</span>
                </>
              }
              checked={selected.includes(e.id)}
              onChange={(on) =>
                onChange(on ? [...selected, e.id] : selected.filter((id) => id !== e.id))
              }
            />
          </li>
        ))}
        {shown.length === 0 && <li className="px-3 py-2 text-sm text-stone-500">Ingen treff.</li>}
      </ul>
      <p className="text-xs text-stone-500">
        {plural(selected.length, 'arrangement', 'arrangementer')} valgt
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Dele ut for hånd
// ---------------------------------------------------------------------------

type Candidate = Awaited<ReturnType<typeof fetchAwardCandidates>>[number]
type Holders = Awaited<ReturnType<typeof fetchAdminBadge>>['awards']

function AwardDialog({ badge, onClose }: { badge: AdminBadge; onClose: () => void }) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Candidate[]>([])
  const [picked, setPicked] = useState<Candidate[]>([])
  const [citation, setCitation] = useState('')
  const [holders, setHolders] = useState<Holders | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [version, setVersion] = useState(0)

  // Hvem som har merket: når dialogen åpnes, og etter hver endring (`version`).
  useEffect(() => {
    let current = true
    void fetchAdminBadge({ data: { badgeId: badge.id } }).then((b) => {
      if (current) setHolders(b.awards)
    })
    return () => {
      current = false
    }
  }, [badge.id, version])

  // Søket kjører når det er minst to tegn; kortere viser ingen treff.
  const searching = query.trim().length >= 2
  useEffect(() => {
    if (!searching) return
    let current = true
    const timer = setTimeout(async () => {
      const found = await fetchAwardCandidates({ data: { query } })
      if (current) setResults(found)
    }, 200)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [query, searching])
  const shown = searching ? results : []

  async function act(action: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      setVersion((v) => v + 1)
      await router.invalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke lagre.')
    } finally {
      setBusy(false)
    }
  }

  const award = () =>
    act(async () => {
      await giveBadge({
        data: {
          badgeId: badge.id,
          personIds: picked.map((p) => p.personId),
          citation: citation.trim() || null,
        },
      })
      setPicked([])
      setQuery('')
      setCitation('')
    })

  return (
    <Dialog
      title={`Del ut «${badge.name}»`}
      description={
        badge.status === 'draft'
          ? 'Merket er et utkast. Det vises på profilene når det publiseres.'
          : 'Merket vises på profilene med en gang, med begrunnelsen.'
      }
      onClose={onClose}
      busy={busy}
      className="max-w-xl"
    >
      <div className="space-y-4">
        <Field label="Person">
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Skriv et navn"
            data-autofocus
          />
        </Field>
        {shown.length > 0 && (
          <ul className="max-h-48 divide-y divide-stone-100 overflow-y-auto rounded-lg ring-1 ring-stone-200 ring-inset">
            {shown
              .filter((r) => !picked.some((p) => p.personId === r.personId))
              .map((r) => (
                <li key={r.personId}>
                  <button
                    type="button"
                    onClick={() => setPicked([...picked, r])}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-stone-50"
                  >
                    <span>
                      {r.fullName}{' '}
                      <span className="text-stone-500">
                        {r.cohortYears.length ? `ES ${r.cohortYears.join(', ')}` : ''}
                        {r.status !== 'active' && ' · ikke aktiv'}
                      </span>
                    </span>
                    <Plus className="size-4 text-stone-400" aria-hidden />
                  </button>
                </li>
              ))}
          </ul>
        )}
        {picked.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {picked.map((p) => (
              <li
                key={p.personId}
                className="inline-flex items-center gap-1 rounded-full bg-stone-100 py-0.5 pr-1 pl-2.5 text-sm text-stone-800"
              >
                {p.fullName}
                <button
                  type="button"
                  onClick={() => setPicked(picked.filter((x) => x.personId !== p.personId))}
                  aria-label={`Fjern ${p.fullName}`}
                  className="grid size-5 place-items-center rounded-full hover:bg-stone-200"
                >
                  <X className="size-3" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        <Field
          label="Begrunnelse (valgfritt)"
          hint="Vises på merket, f.eks. «For innsatsen med ESAF-helgen 2024»."
        >
          <Input value={citation} onChange={(e) => setCitation(e.target.value)} maxLength={200} />
        </Field>
        {error && <ErrorText>{error}</ErrorText>}
        <div className="flex justify-end">
          <Button variant="brand" onClick={award} disabled={busy || picked.length === 0}>
            <Gift className="size-4" aria-hidden />{' '}
            {picked.length > 1 ? `Del ut til ${picked.length}` : 'Del ut'}
          </Button>
        </div>

        <section aria-labelledby="har-det" className="border-t border-stone-100 pt-4">
          <h3 id="har-det" className="mb-2 text-sm font-semibold text-stone-950">
            Har det{holders ? ` (${holders.length})` : ''}
          </h3>
          {!holders ? (
            <p className="text-sm text-stone-500">Henter …</p>
          ) : holders.length === 0 ? (
            <p className="text-sm text-stone-500">Ingen ennå.</p>
          ) : (
            <ul className="max-h-60 divide-y divide-stone-100 overflow-y-auto">
              {holders.map((h) => (
                <li key={h.personId} className="flex items-center justify-between gap-3 py-2">
                  <span className="min-w-0 text-sm">
                    <span className="font-medium text-stone-900">{h.fullName}</span>
                    {h.citation && (
                      <span className="block text-xs text-stone-500 italic">«{h.citation}»</span>
                    )}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      act(() => takeBadge({ data: { badgeId: badge.id, personIds: [h.personId] } }))
                    }
                  >
                    Ta tilbake
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Dialog>
  )
}
