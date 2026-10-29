import type { LinkRequestView, SuggestedValue, SuggestionView } from '@esaf/core'
import { Link, useRouter } from '@tanstack/react-router'
import { ArrowRight, ArrowUpRight, Check, Undo2, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { ArticleMeta } from './CompanyArticles.tsx'
import { Avatar, Button, CompanyLogo, cx, ErrorText, Verified } from './ui.tsx'
import { eventTypeLabels, statusLabels, type CompanyStatus } from '#/lib/companies.ts'
import {
  answerCompanyLink,
  answerSuggestion,
  retractCompanyLink,
  retractSuggestion,
} from '#/lib/contributions.functions.ts'
import { partialDate, timeAgo, yearSpan } from '#/lib/format.ts'
import { companyFieldLabels } from '#/lib/sources.ts'

/** Hva rollen heter i en setning: «som gründer». */
export const linkRoleLabels: Record<LinkRequestView['role'], string> = {
  founder: 'gründer',
  es: 'ES-team',
  employee: 'ansatt',
}

const capitalize = (v: string) => v.charAt(0).toLocaleUpperCase('nb') + v.slice(1)

/** Rollen med stilling og år: «Gründer · Daglig leder · 2016–nå». */
export function linkSummary(l: Pick<LinkRequestView, 'role' | 'title' | 'startYear' | 'endYear'>) {
  const years =
    l.role !== 'es' && (l.startYear || l.endYear) ? yearSpan(l.startYear, l.endYear) : null
  return [capitalize(linkRoleLabels[l.role]), l.title, years].filter(Boolean).join(' · ')
}

/**
 * Kjører en handling, laster siden på nytt og viser feilen om noe gikk galt.
 * Brukes av knappene på forslag, forespørsler og i Gjennomgang.
 */
export function useAction() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function run(action: () => Promise<unknown>, after?: (result: unknown) => unknown) {
    setBusy(true)
    setError(null)
    try {
      const result = await action()
      if (after) await after(result)
      else await router.invalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Noe gikk galt. Prøv igjen.')
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

function show(field: string, value: SuggestedValue): ReactNode {
  if (value === null || value === '' || (Array.isArray(value) && !value.length)) {
    return <span className="text-stone-400 italic">tomt</span>
  }
  if (Array.isArray(value)) return value.join(', ')
  if (field === 'status' && typeof value === 'string' && value in statusLabels) {
    return statusLabels[value as CompanyStatus]
  }
  return String(value)
}

/** Domenet i lenken uten «www.», når saken ikke har utgiver. */
function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

const same = (a: SuggestedValue, b: SuggestedValue) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Et forslag til endring: feltene med verdien nå og den foreslåtte, eller den
 * foreslåtte hendelsen. `canDecide` gir «Godta» og «Avslå»; den som foreslo, kan
 * trekke det.
 */
export function SuggestionCard({
  suggestion: s,
  canDecide,
  showCompany = false,
}: {
  suggestion: SuggestionView
  canDecide: boolean
  /** Vis hvilket selskap det gjelder (i Gjennomgang). */
  showCompany?: boolean
}) {
  const { busy, error, run } = useAction()
  const decide = (decision: 'accept' | 'reject') =>
    run(() => answerSuggestion({ data: { suggestionId: s.id, decision } }))
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        {showCompany ? (
          <CompanyLogo name={s.company.name} logo={s.company.logo} size="sm" />
        ) : (
          <Avatar
            name={s.suggestedBy.fullName}
            photo={s.suggestedBy.photo}
            size="sm"
            muted={!s.suggestedBy.claimed}
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm text-stone-700">
            {showCompany && (
              <>
                <Link
                  to="/selskaper/$slug"
                  params={{ slug: s.company.slug }}
                  className="font-semibold text-stone-950 hover:text-brand-600"
                >
                  {s.company.name}
                </Link>
                {': '}
              </>
            )}
            {s.own ? (
              <span className="font-medium text-stone-900">Du</span>
            ) : (
              <Link
                to="/medlemmer/$personId"
                params={{ personId: s.suggestedBy.personId }}
                className="font-medium text-stone-900 hover:text-brand-600"
              >
                {s.suggestedBy.fullName}
              </Link>
            )}{' '}
            {s.kind === 'info'
              ? 'foreslår endringer i selskapsinfoen'
              : s.kind === 'event'
                ? 'foreslår en ny hendelse'
                : 'foreslår en sak under «I media»'}
          </p>
          <p className="text-xs text-stone-500">{timeAgo(s.createdAt)}</p>
        </div>
      </div>

      {s.kind === 'info' ? (
        <dl className="divide-y divide-stone-100 rounded-xl ring-1 ring-stone-200 ring-inset">
          {s.fields.map((f) => {
            const changedSince = !same(f.from, f.current)
            const alreadyDone = same(f.to, f.current)
            return (
              <div
                key={f.field}
                className="grid gap-1 px-3 py-2.5 sm:grid-cols-[9rem_minmax(0,1fr)]"
              >
                <dt className="text-xs font-medium text-stone-500">
                  {companyFieldLabels[f.field as keyof typeof companyFieldLabels] ?? f.field}
                </dt>
                <dd className="min-w-0 text-sm">
                  <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="break-words text-stone-500 line-through decoration-stone-300">
                      {show(f.field, f.current)}
                    </span>
                    <ArrowRight className="size-3.5 shrink-0 text-stone-400" aria-label="blir" />
                    <span className="break-words font-medium text-stone-900">
                      {show(f.field, f.to)}
                    </span>
                  </span>
                  {alreadyDone ? (
                    <span className="mt-0.5 block text-xs text-emerald-700">
                      Står slik allerede.
                    </span>
                  ) : (
                    changedSince && (
                      <span className="mt-0.5 block text-xs text-amber-700">
                        Endret siden forslaget ble sendt (var {show(f.field, f.from)}).
                      </span>
                    )
                  )}
                </dd>
              </div>
            )
          })}
        </dl>
      ) : s.article ? (
        <div className="rounded-xl px-3 py-2.5 ring-1 ring-stone-200 ring-inset">
          <a
            href={s.article.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-sm font-medium break-words text-stone-900 hover:text-brand-600"
          >
            {s.article.title}
            <ArrowUpRight className="ml-0.5 inline size-3.5 text-stone-400" aria-hidden />
            <span className="sr-only"> (åpnes i ny fane)</span>
          </a>
          <ArticleMeta
            publisher={s.article.publisher ?? hostOf(s.article.url)}
            publishedAt={
              s.article.year === null
                ? null
                : `${s.article.year}-${String(s.article.month ?? 1).padStart(2, '0')}-${String(s.article.day ?? 1).padStart(2, '0')}`
            }
            publishedPrecision={s.article.day ? 'day' : s.article.month ? 'month' : 'year'}
            paywall={s.article.paywall}
            mentionsEs={s.article.mentionsEs}
          />
        </div>
      ) : (
        s.event && (
          <div className="rounded-xl px-3 py-2.5 ring-1 ring-stone-200 ring-inset">
            <p className="text-xs text-stone-500">
              <span className="font-medium text-stone-700 tabular-nums">
                {partialDate(
                  `${s.event.year}-${String(s.event.month ?? 1).padStart(2, '0')}-${String(s.event.day ?? 1).padStart(2, '0')}`,
                  s.event.day ? 'day' : s.event.month ? 'month' : 'year',
                )}
              </span>{' '}
              · {eventTypeLabels[s.event.type]}
            </p>
            <p className="mt-1 text-sm text-stone-800">{s.event.text}</p>
            {s.event.sourceUrl && (
              <a
                href={s.event.sourceUrl}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="mt-1 inline-block text-xs text-stone-500 hover:text-brand-600"
              >
                {s.event.sourceLabel ?? 'Kilde'}
              </a>
            )}
          </div>
        )
      )}

      {s.note && (
        <p className="rounded-lg bg-stone-50 px-3 py-2 text-sm text-stone-600 ring-1 ring-stone-200/70 ring-inset">
          {s.note}
        </p>
      )}
      {error && <ErrorText>{error}</ErrorText>}
      <div className="flex flex-wrap justify-end gap-2">
        {s.own ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => run(() => retractSuggestion({ data: { suggestionId: s.id } }))}
          >
            <Undo2 className="size-4" aria-hidden /> Trekk forslaget
          </Button>
        ) : (
          canDecide && (
            <>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => decide('reject')}
              >
                <X className="size-4" aria-hidden /> Avslå
              </Button>
              <Button variant="brand" size="sm" disabled={busy} onClick={() => decide('accept')}>
                <Check className="size-4" aria-hidden /> Godta
              </Button>
            </>
          )
        )}
      </div>
    </div>
  )
}

/**
 * En forespørsel om at noen var med i et selskap. `as` avgjør knappene: personen
 * selv bekrefter eller avslår, den som spurte kan trekke den, og admins bekrefter
 * for profiler uten konto og avslår.
 */
export function LinkRequestCard({
  request: r,
  as,
}: {
  request: LinkRequestView
  as: 'person' | 'requester' | 'admin'
}) {
  const { busy, error, run } = useAction()
  const answer = (decision: 'accept' | 'reject') =>
    run(() => answerCompanyLink({ data: { requestId: r.id, decision } }))
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-3">
        <CompanyLogo name={r.company.name} logo={r.company.logo} size="sm" />
        <div className="min-w-0 flex-1 text-sm text-stone-700">
          {as === 'person' ? (
            <p>
              <Link
                to="/medlemmer/$personId"
                params={{ personId: r.requestedBy.personId }}
                className="font-medium text-stone-900 hover:text-brand-600"
              >
                {r.requestedBy.fullName}
              </Link>{' '}
              sier at du var med i{' '}
              <Link
                to="/selskaper/$slug"
                params={{ slug: r.company.slug }}
                className="font-medium text-stone-900 hover:text-brand-600"
              >
                {r.company.name}
              </Link>
              . Stemmer det?
            </p>
          ) : (
            <p>
              <span className="inline-flex items-center gap-1 font-medium text-stone-900">
                {r.person.fullName}
                <Verified claimed={r.person.claimed} />
              </span>{' '}
              i{' '}
              <Link
                to="/selskaper/$slug"
                params={{ slug: r.company.slug }}
                className="font-medium text-stone-900 hover:text-brand-600"
              >
                {r.company.name}
              </Link>
              {as === 'admin' && (
                <span className="text-stone-500"> · lagt til av {r.requestedBy.fullName}</span>
              )}
            </p>
          )}
          <p className="text-xs text-stone-500">
            {linkSummary(r)} · {timeAgo(r.createdAt)}
          </p>
          {as === 'requester' && (
            <p className="text-xs text-stone-500">
              Vises når {r.person.fullName.split(/\s+/)[0]} har bekreftet.
            </p>
          )}
        </div>
      </div>
      {error && <ErrorText>{error}</ErrorText>}
      <div className={cx('flex flex-wrap justify-end gap-2')}>
        {as === 'requester' ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => run(() => retractCompanyLink({ data: { requestId: r.id } }))}
          >
            <Undo2 className="size-4" aria-hidden /> Trekk tilbake
          </Button>
        ) : (
          <>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => answer('reject')}>
              <X className="size-4" aria-hidden /> {as === 'person' ? 'Stemmer ikke' : 'Avslå'}
            </Button>
            {(as === 'person' || !r.person.claimed) && (
              <Button variant="brand" size="sm" disabled={busy} onClick={() => answer('accept')}>
                <Check className="size-4" aria-hidden /> {as === 'person' ? 'Stemmer' : 'Bekreft'}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
