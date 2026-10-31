import type { CompanyDetails, CompanySourceField } from '@esaf/core'
import { createFileRoute, Link, redirect, useRouter } from '@tanstack/react-router'
import {
  ArrowLeft,
  ArrowUpRight,
  CalendarDays,
  Globe,
  Hand,
  History,
  LogOut,
  MapPin,
  MessageSquarePlus,
  Pencil,
  Rocket,
  UserPlus,
  GitMerge,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { DocumentsCard } from '#/components/Attachments.tsx'
import { AddPersonDialog, JoinCompanyDialog } from '#/components/CompanyLinkDialogs.tsx'
import { CompanyArticles } from '#/components/CompanyArticles.tsx'
import { CompanyTimeline } from '#/components/CompanyTimeline.tsx'
import { LinkRequestCard, SuggestionCard, useAction } from '#/components/Contributions.tsx'
import { QuoteList } from '#/components/Quotes.tsx'
import {
  Avatar,
  Button,
  buttonClass,
  Card,
  CompanyLogo,
  cx,
  ErrorText,
  Verified,
} from '#/components/ui.tsx'
import { statusLabels } from '#/lib/companies.ts'
import { fetchCompany } from '#/lib/companies.functions.ts'
import { leaveCompany } from '#/lib/contributions.functions.ts'
import { longDay, yearSpan } from '#/lib/format.ts'
import { companyFieldLabels, confidenceLabels } from '#/lib/sources.ts'

export const Route = createFileRoute('/_konto/selskaper/$slug/')({
  loader: async ({ params }) => {
    const company = await fetchCompany({ data: { slug: params.slug } })
    // Nytt navn eller slått sammen med et annet selskap: gamle lenker skal virke.
    if ('movedTo' in company) {
      throw redirect({ to: '/selskaper/$slug', params: { slug: company.movedTo }, replace: true })
    }
    return company
  },
  head: ({ loaderData }) => ({ meta: [{ title: `${loaderData?.name ?? 'Selskap'} – ESAF` }] }),
  component: CompanyPage,
})

type Member = CompanyDetails['people'][number]

const groups: { role: Member['role']; title: string }[] = [
  { role: 'founder', title: 'Gründere' },
  { role: 'es', title: 'ES-team' },
  { role: 'current', title: 'Jobber der nå' },
  { role: 'past', title: 'Har jobbet der' },
]

function Fact({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof MapPin
  label: string
  children: ReactNode
}) {
  return (
    <div className="flex gap-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-stone-100 text-stone-500">
        <Icon className="size-4" aria-hidden />
      </span>
      <div className="min-w-0">
        <dt className="text-xs text-stone-500">{label}</dt>
        <dd className="text-sm font-medium break-words text-stone-900">{children}</dd>
      </div>
    </div>
  )
}

function PersonRow({ person: p }: { person: Member }) {
  const years = p.startYear || p.endYear ? yearSpan(p.startYear, p.endYear) : null
  const detail = [p.title, years].filter(Boolean).join(' · ')
  return (
    <li>
      <Link
        to="/medlemmer/$personId"
        params={{ personId: p.personId }}
        className="-mx-2 flex items-center gap-3 rounded-xl px-2 py-2.5 transition hover:bg-stone-50"
      >
        <Avatar name={p.fullName} photo={p.photo} muted={!p.claimed} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1 font-medium text-stone-900">
            <span className="truncate">{p.fullName}</span>
            <Verified claimed={p.claimed} />
          </span>
          {detail && <span className="block truncate text-sm text-stone-500">{detail}</span>}
        </span>
        {p.cohortYears.length > 0 && (
          <span className="shrink-0 text-xs font-medium text-stone-500 tabular-nums">
            ES {p.cohortYears.join(', ')}
          </span>
        )}
      </Link>
    </li>
  )
}

function CompanyPage() {
  const c = Route.useLoaderData()
  const facts = Boolean(c.foundedYear || c.location || c.website)
  const bare = !c.tagline && !c.description && !c.website && !c.location && !c.industries.length

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        to="/selskaper"
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-900"
      >
        <ArrowLeft className="size-4" aria-hidden /> Selskaper
      </Link>

      <Card className="p-5 sm:p-8">
        <div className="flex flex-wrap items-start gap-x-5 gap-y-4">
          <CompanyLogo name={c.name} logo={c.logo} size="xl" />
          <div className="min-w-0 flex-1 basis-60">
            <h1 className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xl font-semibold tracking-tight text-stone-950 sm:text-3xl">
              <span className="break-words">{c.name}</span>
              {c.status !== 'active' && (
                <span className="rounded-full bg-stone-100 px-2.5 py-0.5 text-xs font-medium text-stone-600 ring-1 ring-stone-200 ring-inset">
                  {statusLabels[c.status]}
                </span>
              )}
            </h1>
            {c.tagline && <p className="mt-1 text-base text-stone-600">{c.tagline}</p>}
            {c.formerNames.length > 0 && (
              <p className="mt-1 text-sm text-stone-500">Tidligere {c.formerNames.join(', ')}</p>
            )}
            {c.status === 'unknown' && c.lastSeenOnEsSite && (
              <p className="mt-2 inline-flex items-center gap-1.5 text-sm text-stone-500">
                <History className="size-4" aria-hidden />
                Sist nevnt på ES-siden {c.lastSeenOnEsSite.slice(0, 4)}
              </p>
            )}
            {c.startedByAlumni && (
              <p className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-brand-700">
                <Rocket className="size-4" aria-hidden />
                {c.esCompany ? 'Startet på Entreprenørskolen' : 'Grunnlagt av ES-alumni'}
                {c.cohortYears.length > 0 && (
                  <span className="font-normal text-stone-500">
                    · ES {c.cohortYears.join(', ')}
                  </span>
                )}
              </p>
            )}
          </div>
          <div className="flex w-full flex-wrap gap-2 sm:w-auto">
            {c.website && (
              <a
                href={c.website}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonClass({ variant: 'secondary' })}
              >
                <Globe className="size-4 text-stone-500" aria-hidden /> Nettside
                <ArrowUpRight className="size-3.5 text-stone-400" aria-hidden />
              </a>
            )}
            {c.canEdit ? (
              <Link
                to="/selskaper/$slug/rediger"
                params={{ slug: c.slug }}
                className={buttonClass({ variant: 'secondary' })}
              >
                <Pencil className="size-4" aria-hidden /> Rediger
              </Link>
            ) : (
              <Link
                to="/selskaper/$slug/foresla"
                params={{ slug: c.slug }}
                className={buttonClass({ variant: 'secondary' })}
              >
                <MessageSquarePlus className="size-4" aria-hidden /> Foreslå endring
              </Link>
            )}
            {c.canMerge && (
              <Link
                to="/selskaper/$slug/rediger"
                params={{ slug: c.slug }}
                hash="sla-sammen"
                className={buttonClass({ variant: 'secondary' })}
                title="Finnes selskapet to ganger, eller har det byttet navn? Slå dem sammen."
              >
                <GitMerge className="size-4" aria-hidden /> Slå sammen
              </Link>
            )}
          </div>
        </div>
      </Card>

      {c.linkRequests.length > 0 && (
        <Card className="mt-4 space-y-4 p-5 ring-brand-200">
          {c.linkRequests.map((r) => (
            <LinkRequestCard key={r.id} request={r} as="person" />
          ))}
        </Card>
      )}

      {c.canEdit && bare && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-brand-50 p-4 text-sm text-brand-900 ring-1 ring-brand-200 ring-inset">
          <p>
            {c.connected
              ? `Fortell andre ES-ere hva ${c.name} driver med: en linje om selskapet, nettside og bransje.`
              : `${c.name} har ingen info ennå. Som admin kan du fylle den ut.`}
          </p>
          <Link
            to="/selskaper/$slug/rediger"
            params={{ slug: c.slug }}
            className={buttonClass({ variant: 'brand', size: 'sm' })}
          >
            Fyll ut
          </Link>
        </div>
      )}

      <div
        className={cx(
          'mt-6 grid gap-6',
          (facts || c.industries.length > 0 || c.sources.length > 0) &&
            'lg:grid-cols-[minmax(0,1fr)_280px]',
        )}
      >
        <div className="min-w-0 space-y-6">
          {c.suggestions.length > 0 && (
            <Card id="forslag" className="scroll-mt-20 p-5 sm:p-6">
              <h2 className="text-sm font-semibold text-stone-950">
                {c.canEdit ? 'Forslag til endringer' : 'Forslagene dine'}{' '}
                <span className="font-normal text-stone-500 tabular-nums">
                  {c.suggestions.length}
                </span>
              </h2>
              <p className="mt-1 text-sm text-stone-500">
                {c.canEdit
                  ? 'Fra medlemmer som ikke kan redigere selskapet selv. Den som foreslo, får varsel når du har godtatt eller avslått.'
                  : 'Venter på at noen som kan redigere selskapet, ser over dem.'}
              </p>
              <ul className="mt-4 divide-y divide-stone-100">
                {c.suggestions.map((s) => (
                  <li key={s.id} className="py-4 first:pt-0 last:pb-0">
                    <SuggestionCard suggestion={s} canDecide={c.canEdit} />
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card className="p-5 sm:p-6">
            <h2 className="text-sm font-semibold text-stone-950">Om selskapet</h2>
            {c.description ? (
              <p className="mt-2 text-[15px] leading-relaxed whitespace-pre-line text-stone-700">
                {c.description}
              </p>
            ) : (
              <p className="mt-2 text-sm text-stone-500">
                Ingen har skrevet om {c.name} ennå.
                {!c.canEdit && ' Gründerne, ES-teamet og de som jobber der nå, kan fylle ut siden.'}
              </p>
            )}
          </Card>

          <CompanyTimeline
            companyId={c.id}
            name={c.name}
            events={c.events}
            canEdit={c.canEdit}
            adminEdit={c.canEdit && !c.connected}
          />

          <CompanyArticles
            companyId={c.id}
            name={c.name}
            articles={c.articles}
            canEdit={c.canEdit}
            adminEdit={c.canEdit && !c.connected}
          />

          <People company={c} />

          <QuoteList quotes={c.quotes} showSpeaker />
        </div>

        <aside className="space-y-4 empty:hidden">
          {facts && (
            <Card className="p-5">
              <h2 className="mb-4 text-sm font-semibold text-stone-950">Fakta</h2>
              <dl className="space-y-4">
                {c.foundedYear && (
                  <Fact icon={CalendarDays} label="Grunnlagt">
                    {c.foundedYear}
                  </Fact>
                )}
                {c.location && (
                  <Fact icon={MapPin} label="Sted">
                    {c.location}
                  </Fact>
                )}
                {c.website && (
                  <Fact icon={Globe} label="Nettside">
                    <a
                      href={c.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-brand-600"
                    >
                      {c.websiteLabel ?? c.website}
                    </a>
                  </Fact>
                )}
              </dl>
            </Card>
          )}
          {c.industries.length > 0 && (
            <Card className="p-5">
              <h2 className="text-sm font-semibold text-stone-950">Bransjer</h2>
              <ul className="mt-3 flex flex-wrap gap-2">
                {c.industries.map((tag) => (
                  <li key={tag}>
                    <Link
                      to="/selskaper"
                      search={{ vis: 'alle', bransje: tag }}
                      className="inline-flex rounded-full bg-stone-100 px-3 py-1 text-sm font-medium text-stone-700 transition hover:bg-stone-900 hover:text-white"
                    >
                      {tag}
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <DocumentsCard
            target={{ til: 'selskap', id: c.id }}
            documents={c.documents}
            canUpload={c.canEdit}
            max={30}
            emptyText="Ingen dokumenter ennå. Legg ut pitch deck, pressemateriale eller annet medlemmene kan ha nytte av."
            uploadHint={
              c.canEdit && !c.connected
                ? 'Du laster opp som admin, og det logges. PDF, Word, Excel, PowerPoint, tekst, CSV eller bilder, maks 25 MB.'
                : 'Alle medlemmer kan laste ned. PDF, Word, Excel, PowerPoint, tekst, CSV eller bilder, maks 25 MB.'
            }
          />
          {c.sources.length > 0 && <Sources sources={c.sources} />}
        </aside>
      </div>
    </div>
  )
}

/**
 * Hvor de importerte feltene kom fra, lukket til man åpner den. Medlemmer ser
 * kilden og om noen knyttet til selskapet har bekreftet feltet; admins ser også
 * hvor sikker kilden er.
 */
function Sources({ sources }: { sources: CompanyDetails['sources'] }) {
  const fields = [...new Set(sources.map((s) => s.field))] as CompanySourceField[]
  return (
    <Card className="p-5">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-semibold text-stone-950">
          Kilder
          <span className="text-xs font-normal text-stone-500 group-open:hidden">Vis</span>
          <span className="hidden text-xs font-normal text-stone-500 group-open:inline">Skjul</span>
        </summary>
        <p className="mt-2 text-xs leading-relaxed text-stone-500">
          Hvor informasjonen på siden er hentet fra. Bekreftet betyr at noen som er knyttet til
          selskapet, har sett over eller endret feltet.
        </p>
        <dl className="mt-3 space-y-3">
          {fields.map((field) => (
            <div key={field}>
              <dt className="text-xs font-medium text-stone-700">{companyFieldLabels[field]}</dt>
              {sources
                .filter((s) => s.field === field)
                .map((s) => (
                  <dd key={s.label} className="text-xs leading-relaxed text-stone-500">
                    {s.url ? (
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-0.5 font-medium text-stone-700 hover:text-brand-600"
                      >
                        {s.label}
                        <ArrowUpRight className="size-3" aria-hidden />
                      </a>
                    ) : (
                      <span className="font-medium text-stone-700">{s.label}</span>
                    )}
                    {' · '}
                    {s.confirmed ? 'bekreftet' : 'ikke bekreftet'}
                    {s.confidence && ` · ${confidenceLabels[s.confidence]}`}
                    {s.fetchedAt && (
                      <span className="block text-stone-400">Hentet {longDay(s.fetchedAt)}</span>
                    )}
                  </dd>
                ))}
            </div>
          ))}
        </dl>
      </details>
    </Card>
  )
}

/**
 * «Fra ES»: personene, «Jeg var med her» og «Legg til en person». Andre personer
 * vises ikke før de selv har bekreftet.
 */
function People({ company: c }: { company: CompanyDetails }) {
  const router = useRouter()
  const { viewer } = Route.useRouteContext()
  const [dialog, setDialog] = useState<'join' | 'add' | null>(null)
  const { busy, error, run } = useAction()
  const linked = c.viewerRoles.founder || c.viewerRoles.employee || c.viewerRoles.es

  function leave() {
    const question = `Fjerne ${c.name} fra profilen din? All erfaring derfra${c.viewerRoles.es ? ' og ES-selskapet' : ''} fjernes.`
    if (!confirm(question)) return
    void run(
      () => leaveCompany({ data: { companyId: c.id } }),
      async (result) => {
        await router.invalidate()
        // Et selskap ingen lenger er knyttet til og som bare fantes fra et navn, er borte.
        if ((result as { companyDeleted: boolean }).companyDeleted) {
          await router.navigate({ to: '/selskaper' })
        }
      },
    )
  }

  return (
    <Card className="p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-stone-950">
          Fra ES
          {c.people.length > 0 && (
            <span className="font-normal text-stone-500 tabular-nums">{c.people.length}</span>
          )}
        </h2>
        <div className="flex flex-wrap gap-2">
          {linked ? (
            <Button variant="ghost" size="sm" onClick={leave} disabled={busy}>
              <LogOut className="size-4" aria-hidden /> Fjern meg herfra
            </Button>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => setDialog('join')}>
              <Hand className="size-4" aria-hidden /> Jeg var med her
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => setDialog('add')}>
            <UserPlus className="size-4" aria-hidden /> Legg til en person
          </Button>
        </div>
      </div>
      {error && (
        <div className="mt-2">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      {c.people.length === 0 ? (
        <p className="mt-2 text-sm text-stone-500">
          Ingen fra ES er knyttet til {c.name} ennå. Var du med, trykk «Jeg var med her».
        </p>
      ) : (
        groups.map(({ role, title }) => {
          const people = c.people.filter((p) => p.role === role)
          if (!people.length) return null
          return (
            <section key={role} className="mt-4 first-of-type:mt-3">
              <h3 className="text-xs font-medium text-stone-500">{title}</h3>
              <ul className="mt-1 divide-y divide-stone-100">
                {people.map((p) => (
                  <PersonRow key={p.personId} person={p} />
                ))}
              </ul>
            </section>
          )
        })
      )}
      {c.requestedLinks.length > 0 && (
        <section className="mt-5 rounded-xl bg-stone-50 p-4 ring-1 ring-stone-200 ring-inset">
          <h3 className="text-xs font-medium text-stone-500">Venter på bekreftelse</h3>
          <ul className="mt-3 space-y-4">
            {c.requestedLinks.map((r) => (
              <li key={r.id}>
                <LinkRequestCard request={r} as="requester" />
              </li>
            ))}
          </ul>
        </section>
      )}
      {dialog === 'join' && (
        <JoinCompanyDialog companyId={c.id} name={c.name} onClose={() => setDialog(null)} />
      )}
      {dialog === 'add' && viewer.personId && (
        <AddPersonDialog
          companyId={c.id}
          name={c.name}
          viewerId={viewer.personId}
          onClose={() => setDialog(null)}
        />
      )}
    </Card>
  )
}
