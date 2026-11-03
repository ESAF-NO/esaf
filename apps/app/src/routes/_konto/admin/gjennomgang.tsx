import type {
  DuplicateCompany,
  DuplicatePerson,
  ReviewCompanyPair,
  ReviewEvent,
  ReviewKind,
  ReviewPersonPair,
  ReviewQuote,
  ReviewSourceGroup,
} from '@esaf/core'
import { createFileRoute, getRouteApi, Link, notFound, useRouter } from '@tanstack/react-router'
import {
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  CheckCheck,
  CircleCheck,
  GitMerge,
  Pencil,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Dialog, DialogActions } from '#/components/Dialog.tsx'
import { z } from 'zod'
import { LinkRequestCard, SuggestionCard, useAction } from '#/components/Contributions.tsx'
import { PersonMergeDialog } from '#/components/PersonMergeDialog.tsx'
import { EditQuoteDialog } from '#/components/Quotes.tsx'
import {
  Avatar,
  Button,
  buttonClass,
  Card,
  CompanyLogo,
  cx,
  EmptyState,
  ErrorText,
  Verified,
} from '#/components/ui.tsx'
import { eventTypeLabels, statusLabels, type CompanyStatus } from '#/lib/companies.ts'
import { mergeCompany, removeCompanyEvent } from '#/lib/companies.functions.ts'
import { kull, partialDate, plural } from '#/lib/format.ts'
import { removeQuote } from '#/lib/quotes.functions.ts'
import {
  acceptAll,
  approveEvent,
  approveQuote,
  approveSources,
  clearField,
  dismissPair,
  fetchReview,
  fetchReviewCounts,
} from '#/lib/review.functions.ts'
import { companyFieldLabels, confidenceLabels, profileFieldLabels } from '#/lib/sources.ts'

/** Delene av køen, i rekkefølgen de vises, med adressen i URL-en. */
const parts = [
  { kind: 'suggestions', slug: 'forslag', label: 'Forslag' },
  { kind: 'links', slug: 'tilknytninger', label: 'Tilknytninger' },
  { kind: 'events', slug: 'hendelser', label: 'Hendelser' },
  { kind: 'quotes', slug: 'sitater', label: 'Sitater' },
  { kind: 'sources', slug: 'kilder', label: 'Importerte felt' },
  { kind: 'companyDuplicates', slug: 'selskaper', label: 'Like selskaper' },
  { kind: 'personDuplicates', slug: 'personer', label: 'Like personer' },
] as const satisfies readonly { kind: ReviewKind; slug: string; label: string }[]

type Slug = (typeof parts)[number]['slug']
const slugs = parts.map((p) => p.slug) as [Slug, ...Slug[]]
const bySlug = (slug: Slug) => parts.find((p) => p.slug === slug)!

const PAGE_SIZE = 20

export const Route = createFileRoute('/_konto/admin/gjennomgang')({
  beforeLoad: ({ context: { viewer } }) => {
    if (!viewer.permissions.includes('profiles.edit')) throw notFound()
  },
  validateSearch: z.object({
    del: z.enum(slugs).optional().catch(undefined),
    side: z.number().int().min(1).optional().catch(undefined),
  }),
  loaderDeps: ({ search }) => ({ del: search.del, side: search.side ?? 1 }),
  loader: async ({ deps }) => {
    // Uten valgt del: den første som har noe i seg.
    let slug = deps.del
    if (!slug) {
      const counts = await fetchReviewCounts()
      slug = parts.find((p) => counts[p.kind] > 0)?.slug ?? 'forslag'
    }
    const kind = bySlug(slug).kind
    let page = await fetchReview({ data: { kind, page: deps.side } })
    // Siste side ble tom etter at alt der var behandlet: vis den nye siste siden.
    if (!page.items.length && page.total > 0 && deps.side > 1) {
      page = await fetchReview({ data: { kind, page: Math.ceil(page.total / PAGE_SIZE) } })
    }
    return { slug, page, side: page.items.length ? deps.side : 1 }
  },
  head: () => ({ meta: [{ title: 'Gjennomgang – Admin – ESAF' }] }),
  component: Review,
  errorComponent: ({ error }) => (
    <ErrorText>{error instanceof Error ? error.message : 'Noe gikk galt.'}</ErrorText>
  ),
})

const admin = getRouteApi('/_konto/admin')

function Review() {
  const { slug, page, side } = Route.useLoaderData()
  const counts = admin.useLoaderData()
  const pages = Math.max(1, Math.ceil(page.total / PAGE_SIZE))

  return (
    <div className="max-w-4xl">
      <p className="mb-5 text-sm text-stone-500">
        Alt som er usikkert, samlet ett sted: forslag fra medlemmer, usikre hendelser og sitater fra
        import, importerte felt ingen har sett over, og mulige duplikater. Handlingene logges.
      </p>

      <nav aria-label="Deler av gjennomgangen" className="mb-6 flex flex-wrap gap-1.5">
        {parts.map((p) => {
          const n = counts?.[p.kind] ?? 0
          return (
            <Link
              key={p.slug}
              to="/admin/gjennomgang"
              search={{ del: p.slug }}
              aria-current={slug === p.slug ? 'page' : undefined}
              className={cx(
                'inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition',
                slug === p.slug
                  ? 'bg-stone-900 text-white'
                  : 'bg-white text-stone-600 ring-1 ring-stone-200 hover:text-stone-900',
              )}
            >
              {p.label}
              <span
                className={cx(
                  'tabular-nums',
                  slug === p.slug ? 'text-stone-300' : n ? 'text-amber-700' : 'text-stone-400',
                )}
              >
                {n}
              </span>
            </Link>
          )
        })}
      </nav>

      {page.items.length === 0 ? (
        <EmptyState icon={CircleCheck} title="Ingenting å se på her">
          Alt i «{bySlug(slug).label.toLocaleLowerCase('nb')}» er gått gjennom.
        </EmptyState>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-stone-500" aria-live="polite">
              {plural(page.total, 'sak', 'saker')}
              {pages > 1 && ` · side ${side} av ${pages}`}
            </p>
            {page.kind === 'sources' && <AcceptAllButton kind={page.kind} total={page.total} />}
          </div>
          <ul className="space-y-3">
            {page.kind === 'suggestions' &&
              page.items.map((s) => (
                <Item key={s.id}>
                  <SuggestionCard suggestion={s} canDecide showCompany />
                </Item>
              ))}
            {page.kind === 'links' &&
              page.items.map((r) => (
                <Item key={r.id}>
                  <LinkRequestCard request={r} as="admin" />
                </Item>
              ))}
            {page.kind === 'events' &&
              page.items.map((e) => (
                <Item key={e.id}>
                  <EventItem event={e} />
                </Item>
              ))}
            {page.kind === 'quotes' &&
              page.items.map((q) => (
                <Item key={q.id}>
                  <QuoteItem quote={q} />
                </Item>
              ))}
            {page.kind === 'sources' &&
              page.items.map((g) => (
                <Item key={`${g.entityType}:${g.entityId}`}>
                  <SourceGroup group={g} />
                </Item>
              ))}
            {page.kind === 'companyDuplicates' &&
              page.items.map((pair) => (
                <Item key={`${pair.first.id}:${pair.second.id}`}>
                  <CompanyPair pair={pair} />
                </Item>
              ))}
            {page.kind === 'personDuplicates' &&
              page.items.map((pair) => (
                <Item key={`${pair.first.personId}:${pair.second.personId}`}>
                  <PersonPair pair={pair} />
                </Item>
              ))}
          </ul>
          {pages > 1 && (
            <nav aria-label="Sider" className="mt-6 flex items-center justify-center gap-2">
              <Link
                to="/admin/gjennomgang"
                search={{ del: slug, side: side - 1 }}
                disabled={side <= 1}
                className={buttonClass(
                  { variant: 'secondary', size: 'sm' },
                  side <= 1 ? 'pointer-events-none opacity-50' : undefined,
                )}
              >
                <ChevronLeft className="size-4" aria-hidden /> Forrige
              </Link>
              <span className="px-2 text-sm text-stone-500 tabular-nums">
                {side} / {pages}
              </span>
              <Link
                to="/admin/gjennomgang"
                search={{ del: slug, side: side + 1 }}
                disabled={side >= pages}
                className={buttonClass(
                  { variant: 'secondary', size: 'sm' },
                  side >= pages ? 'pointer-events-none opacity-50' : undefined,
                )}
              >
                Neste <ChevronRight className="size-4" aria-hidden />
              </Link>
            </nav>
          )}
        </>
      )}
    </div>
  )
}

function Item({ children }: { children: ReactNode }) {
  return (
    <li>
      <Card className="p-4 sm:p-5">{children}</Card>
    </li>
  )
}

function Actions({ error, children }: { error: string | null; children: ReactNode }) {
  return (
    <>
      {error && (
        <div className="mt-3">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      <div className="mt-3 flex flex-wrap justify-end gap-2">{children}</div>
    </>
  )
}

function SourceLink({ source }: { source: { label: string; url: string | null } | null }) {
  if (!source) return null
  return source.url ? (
    <a
      href={source.url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-0.5 hover:text-brand-600"
    >
      {source.label}
      <ArrowUpRight className="size-3" aria-hidden />
    </a>
  ) : (
    <span>{source.label}</span>
  )
}

function EventItem({ event: e }: { event: ReviewEvent }) {
  const { busy, error, run } = useAction()
  return (
    <>
      <div className="flex items-start gap-3">
        <CompanyLogo name={e.company.name} logo={e.company.logo} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-stone-500">
            <Link
              to="/selskaper/$slug"
              params={{ slug: e.company.slug }}
              className="text-sm font-semibold text-stone-950 hover:text-brand-600"
            >
              {e.company.name}
            </Link>
            <span className="font-medium text-stone-700 tabular-nums">
              {partialDate(e.date, e.datePrecision)}
            </span>
            <span>{eventTypeLabels[e.type]}</span>
          </p>
          <p className="mt-1 text-sm leading-relaxed text-stone-800">{e.text}</p>
          <p className="mt-1 text-xs text-stone-500">
            <SourceLink source={e.source} />
          </p>
        </div>
      </div>
      <Actions error={error}>
        <Button
          variant="danger"
          size="sm"
          disabled={busy}
          onClick={() =>
            confirm('Slette hendelsen? Det kan ikke angres.') &&
            run(() => removeCompanyEvent({ data: { eventId: e.id } }))
          }
        >
          <Trash2 className="size-4" aria-hidden /> Slett
        </Button>
        <Link
          to="/selskaper/$slug"
          params={{ slug: e.company.slug }}
          className={buttonClass({ variant: 'ghost', size: 'sm' })}
        >
          <Pencil className="size-4" aria-hidden /> Rediger på siden
        </Link>
        <Button
          variant="brand"
          size="sm"
          disabled={busy}
          onClick={() => run(() => approveEvent({ data: { eventId: e.id } }))}
        >
          <Check className="size-4" aria-hidden /> Stemmer
        </Button>
      </Actions>
    </>
  )
}

function QuoteItem({ quote: q }: { quote: ReviewQuote }) {
  const { busy, error, run } = useAction()
  const [editing, setEditing] = useState(false)
  return (
    <>
      <blockquote className="border-l-2 border-amber-300 pl-3 text-sm leading-relaxed text-stone-800">
        «{q.text}»
      </blockquote>
      <p className="mt-2 text-sm text-stone-600">
        — {q.speakerName}
        {q.speakerRole && `, ${q.speakerRole}`}
      </p>
      <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-stone-500">
        {q.person ? (
          q.person.active ? (
            <Link
              to="/medlemmer/$personId"
              params={{ personId: q.person.personId }}
              className="hover:text-brand-600"
            >
              Koblet til {q.person.fullName}
            </Link>
          ) : (
            <span>Koblet til {q.person.fullName} (ikke aktiv)</span>
          )
        ) : (
          <span>Ikke koblet til en person</span>
        )}
        {q.company && (
          <Link
            to="/selskaper/$slug"
            params={{ slug: q.company.slug }}
            className="hover:text-brand-600"
          >
            {q.company.name}
          </Link>
        )}
        {q.date && <span>{q.date}</span>}
        <SourceLink source={q.source} />
        <span className="text-amber-700">{confidenceLabels[q.confidence]} på taleren</span>
      </p>
      <Actions error={error}>
        <Button
          variant="danger"
          size="sm"
          disabled={busy}
          onClick={() =>
            confirm('Slette sitatet? Det kan ikke angres.') &&
            run(() => removeQuote({ data: { quoteId: q.id } }))
          }
        >
          <Trash2 className="size-4" aria-hidden /> Slett
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(true)}>
          <Pencil className="size-4" aria-hidden /> Rediger
        </Button>
        <Button
          variant="brand"
          size="sm"
          disabled={busy}
          onClick={() => run(() => approveQuote({ data: { quoteId: q.id } }))}
        >
          <Check className="size-4" aria-hidden /> Riktig taler
        </Button>
      </Actions>
      {editing && <EditQuoteDialog quoteId={q.id} onClose={() => setEditing(false)} />}
    </>
  )
}

function fieldLabel(group: ReviewSourceGroup, field: string) {
  const labels: Record<string, string> =
    group.entityType === 'person' ? profileFieldLabels : companyFieldLabels
  return labels[field] ?? field
}

function SourceGroup({ group: g }: { group: ReviewSourceGroup }) {
  const { busy, error, run } = useAction()
  const entity = { entityType: g.entityType, entityId: g.entityId }
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="flex items-center gap-1.5 text-sm">
          {g.entityType === 'company' && g.slug ? (
            <Link
              to="/selskaper/$slug"
              params={{ slug: g.slug }}
              className="font-semibold text-stone-950 hover:text-brand-600"
            >
              {g.name}
            </Link>
          ) : (
            <Link
              to="/medlemmer/$personId/rediger"
              params={{ personId: g.entityId }}
              className="font-semibold text-stone-950 hover:text-brand-600"
            >
              {g.name}
            </Link>
          )}
          {g.entityType === 'person' && <Verified claimed={g.claimed} />}
          <span className="text-xs text-stone-500">
            {g.entityType === 'company'
              ? 'Selskap'
              : g.claimed
                ? 'Har konto, kan bekrefte selv'
                : g.status === 'active'
                  ? 'Profil'
                  : 'Profil, ikke aktiv'}
          </span>
        </p>
        <Link
          {...(g.entityType === 'company' && g.slug
            ? { to: '/selskaper/$slug/rediger', params: { slug: g.slug } }
            : { to: '/medlemmer/$personId/rediger', params: { personId: g.entityId } })}
          className="text-xs font-medium text-stone-500 hover:text-brand-600"
        >
          Rediger
        </Link>
      </div>
      <dl className="mt-3 divide-y divide-stone-100 rounded-xl ring-1 ring-stone-200 ring-inset">
        {g.fields.map((f) => (
          <div
            key={f.field}
            className="grid gap-2 px-3 py-2.5 sm:grid-cols-[9rem_minmax(0,1fr)_auto]"
          >
            <dt className="text-xs font-medium text-stone-500">{fieldLabel(g, f.field)}</dt>
            <dd className="min-w-0 text-sm">
              <p className="break-words text-stone-800">
                {f.value === null ? (
                  <span className="text-stone-400 italic">tomt</span>
                ) : f.field === 'status' && f.value in statusLabels ? (
                  statusLabels[f.value as CompanyStatus]
                ) : (
                  f.value
                )}
              </p>
              <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-stone-500">
                {f.sources.map((s) => (
                  <span key={s.label}>
                    <SourceLink source={s} /> · {confidenceLabels[s.confidence]}
                  </span>
                ))}
              </p>
            </dd>
            <dd className="flex gap-1 sm:justify-end">
              {f.clearable && f.value !== null && (
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy}
                  aria-label={`Fjern ${fieldLabel(g, f.field).toLocaleLowerCase('nb')}`}
                  onClick={() =>
                    confirm(
                      `Fjerne «${fieldLabel(g, f.field)}» fra ${g.name}? Feltet tømmes, og det logges.`,
                    ) && run(() => clearField({ data: { ...entity, field: f.field } }))
                  }
                >
                  <Trash2 className="size-3.5" aria-hidden /> Fjern
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                aria-label={`${fieldLabel(g, f.field)} ser riktig ut`}
                onClick={() =>
                  run(() => approveSources({ data: { ...entity, fields: [f.field] } }))
                }
              >
                <Check className="size-3.5" aria-hidden /> Ser riktig ut
              </Button>
            </dd>
          </div>
        ))}
      </dl>
      <Actions error={error}>
        <Button
          variant="brand"
          size="sm"
          disabled={busy}
          onClick={() => run(() => approveSources({ data: entity }))}
        >
          <Check className="size-4" aria-hidden /> Alt ser riktig ut
        </Button>
      </Actions>
    </>
  )
}

const companyReasons = {
  name: 'Samme navn uten selskapsform',
  similar: 'Nesten likt navn',
  website: 'Samme nettside',
}

function CompanyCard({ company: c }: { company: DuplicateCompany }) {
  return (
    <div className="flex min-w-0 items-start gap-3 rounded-xl p-3 ring-1 ring-stone-200 ring-inset">
      <CompanyLogo name={c.name} logo={c.logo} size="sm" />
      <div className="min-w-0">
        <Link
          to="/selskaper/$slug"
          params={{ slug: c.slug }}
          className="block truncate text-sm font-semibold text-stone-950 hover:text-brand-600"
        >
          {c.name}
        </Link>
        <p className="text-xs text-stone-500">
          {statusLabels[c.status]} · {plural(c.people, 'person', 'personer')}
        </p>
        {c.website && <p className="truncate text-xs text-stone-500">{c.website}</p>}
      </div>
    </div>
  )
}

function CompanyPair({ pair }: { pair: ReviewCompanyPair }) {
  const { busy, error, run } = useAction()
  const merge = (source: DuplicateCompany, target: DuplicateCompany) =>
    confirm(
      `Slå sammen «${source.name}» med «${target.name}»? Alle som er knyttet til «${source.name}», flyttes, og «${source.name}» forsvinner. Det kan ikke angres.`,
    ) && run(() => mergeCompany({ data: { sourceId: source.id, targetId: target.id } }))
  return (
    <>
      <p className="mb-3 flex items-center gap-1.5 text-xs font-medium text-amber-800">
        <ShieldAlert className="size-3.5" aria-hidden />
        {pair.reasons.map((r) => companyReasons[r]).join(' · ')}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <CompanyCard company={pair.first} />
        <CompanyCard company={pair.second} />
      </div>
      <Actions error={error}>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() =>
            run(() =>
              dismissPair({
                data: {
                  kind: 'company_duplicate',
                  firstId: pair.first.id,
                  secondId: pair.second.id,
                },
              }),
            )
          }
        >
          <X className="size-4" aria-hidden /> Ikke samme selskap
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => merge(pair.second, pair.first)}
        >
          <GitMerge className="size-4" aria-hidden /> Behold «{pair.first.name}»
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => merge(pair.first, pair.second)}
        >
          <GitMerge className="size-4" aria-hidden /> Behold «{pair.second.name}»
        </Button>
      </Actions>
    </>
  )
}

const personReasons = {
  name: 'Samme navn, nære kull',
  firstLast: 'Samme fornavn og etternavn',
  similarName: 'Nesten likt navn, nære kull',
  company: 'Samme fornavn, samme selskap',
  email: 'Samme e-post',
  linkedin: 'Samme LinkedIn',
}

function PersonCard({ person: p }: { person: DuplicatePerson }) {
  const years = kull(p.cohortYears)
  return (
    <div className="flex min-w-0 items-start gap-3 rounded-xl p-3 ring-1 ring-stone-200 ring-inset">
      <Avatar name={p.fullName} photo={p.photo} size="sm" muted={!p.claimed} />
      <div className="min-w-0">
        <Link
          to="/medlemmer/$personId/rediger"
          params={{ personId: p.personId }}
          className="flex items-center gap-1 text-sm font-semibold text-stone-950 hover:text-brand-600"
        >
          <span className="truncate">{p.fullName}</span>
          <Verified claimed={p.claimed} />
        </Link>
        <p className="text-xs text-stone-500">
          {[
            years ?? 'Uten kull',
            p.claimed ? 'har konto' : 'profil',
            p.status === 'active' ? null : p.status === 'pending' ? 'venter' : 'ikke aktiv',
            plural(p.experience, 'erfaring', 'erfaringer'),
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>
    </div>
  )
}

function PersonPair({ pair }: { pair: ReviewPersonPair }) {
  const router = useRouter()
  const { busy, error, run } = useAction()
  const { first, second } = pair
  // Har én av dem konto, beholdes den; ellers velger admin.
  const keepers = pair.bothClaimed
    ? []
    : first.claimed
      ? [first]
      : second.claimed
        ? [second]
        : [first, second]
  const [mergeTarget, setMergeTarget] = useState<DuplicatePerson | null>(null)

  return (
    <>
      <p className="mb-3 flex items-center gap-1.5 text-xs font-medium text-amber-800">
        <ShieldAlert className="size-3.5" aria-hidden />
        {pair.reasons.map((r) => personReasons[r]).join(' · ')}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <PersonCard person={first} />
        <PersonCard person={second} />
      </div>
      {pair.bothClaimed && (
        <p className="mt-3 text-xs text-stone-500">
          Begge har egen konto og kan ikke slås sammen. Be den ene om å slutte å bruke sin, og
          deaktiver den.
        </p>
      )}
      <Actions error={error}>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() =>
            run(() =>
              dismissPair({
                data: {
                  kind: 'person_duplicate',
                  firstId: first.personId,
                  secondId: second.personId,
                },
              }),
            )
          }
        >
          <X className="size-4" aria-hidden /> Ikke samme person
        </Button>
        {keepers.map((keep) => (
          <Button
            key={keep.personId}
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => setMergeTarget(keep)}
          >
            <GitMerge className="size-4" aria-hidden />
            {keepers.length === 1 ? 'Se sammenslåing' : `Se resultat med ${keep.fullName}`}
          </Button>
        ))}
      </Actions>
      {mergeTarget && (
        <PersonMergeDialog
          sourceId={(mergeTarget === first ? second : first).personId}
          targetId={mergeTarget.personId}
          onClose={() => setMergeTarget(null)}
          onMerged={async () => {
            setMergeTarget(null)
            await router.invalidate()
          }}
        />
      )}
    </>
  )
}

/** Hva «Godta alle» gjør, for hver del av køen den finnes i. */
const acceptAllText = {
  sources: {
    button: 'Godta alle',
    title: 'Sette alle importerte felt som sett over?',
    body: [
      'Feltene tas ut av køen. Medlemmene ser dem allerede; ingenting endres på profilene.',
      'Profilen viser fortsatt «ikke bekreftet» til personen selv bekrefter.',
    ],
  },
} as const

function AcceptAllButton({ kind, total }: { kind: 'sources'; total: number }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const text = acceptAllText[kind]

  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      const result = await acceptAll({ data: { kind } })
      setDone(`${plural(result.accepted, 'felt', 'felt')} satt som sett over.`)
      setOpen(false)
      await router.invalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Noe gikk galt.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="flex items-center gap-3">
        <p role="status" className="text-sm text-emerald-700">
          {done}
        </p>
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          <CheckCheck className="size-4" aria-hidden /> {text.button} ({total})
        </Button>
      </div>
      {open && (
        <Dialog title={text.title} onClose={() => setOpen(false)} busy={busy}>
          <div className="space-y-2 text-sm text-stone-600">
            {text.body.map((line) => (
              <p key={line}>{line}</p>
            ))}
            <p>Det står i loggen.</p>
          </div>
          {error && (
            <div className="mt-3">
              <ErrorText>{error}</ErrorText>
            </div>
          )}
          <DialogActions>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
              Avbryt
            </Button>
            <Button variant="brand" onClick={confirm} disabled={busy} data-autofocus>
              {busy ? 'Godtar …' : `Godta alle ${total}`}
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </>
  )
}
