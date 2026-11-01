import type { BadgeOverviewItem } from '@esaf/core'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Award, Pencil, Tent } from 'lucide-react'
import { BadgeMedal, BadgeProgressBar } from '#/components/Badges.tsx'
import { buttonClass, Card, cx, EmptyState, ErrorText, PageHeader } from '#/components/ui.tsx'
import { fetchBadges, fetchMissedEvents } from '#/lib/badges.functions.ts'
import { plural } from '#/lib/format.ts'

export const Route = createFileRoute('/_konto/merker/')({
  loader: async () => {
    const [badges, missed] = await Promise.all([fetchBadges(), fetchMissedEvents()])
    return { badges, missed: missed.reduce((n, g) => n + g.events.length, 0) }
  },
  head: () => ({ meta: [{ title: 'Merker – ESAF' }] }),
  component: BadgesPage,
  errorComponent: ({ error }) => (
    <ErrorText>{error instanceof Error ? error.message : 'Noe gikk galt.'}</ErrorText>
  ),
})

/** Hvor nær den innloggede er et merke, fra 0 til 1. */
const closeness = (b: BadgeOverviewItem) =>
  b.own?.progress ? b.own.progress.current / b.own.progress.target : 0

/**
 * Trinnene på samme stige (serie) samlet, i rekkefølgen admins har satt. En
 * serie med bare ett merke står sammen med de andre.
 */
function groupBySeries(badges: BadgeOverviewItem[]) {
  const ladders: { series: string; badges: BadgeOverviewItem[] }[] = []
  for (const b of badges) {
    if (!b.series) continue
    const key = b.series.toLocaleLowerCase('nb')
    const ladder = ladders.find((l) => l.series.toLocaleLowerCase('nb') === key)
    if (ladder) ladder.badges.push(b)
    else ladders.push({ series: b.series, badges: [b] })
  }
  const kept = ladders.filter((l) => l.badges.length > 1)
  const inLadder = new Set(kept.flatMap((l) => l.badges.map((b) => b.id)))
  return { ladders: kept, single: badges.filter((b) => !inLadder.has(b.id)) }
}

function BadgeGrid({ badges }: { badges: BadgeOverviewItem[] }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {badges.map((b) => (
        <li key={b.id}>
          <BadgeTile badge={b} />
        </li>
      ))}
    </ul>
  )
}

function BadgesPage() {
  const { badges, missed } = Route.useLoaderData()
  const { viewer } = Route.useRouteContext()
  const earned = badges.filter((b) => b.own?.earned)
  const next = badges
    .filter((b) => !b.own?.earned && b.own?.progress && b.own.progress.current > 0)
    .sort((a, b) => closeness(b) - closeness(a))
    .slice(0, 4)
  const { ladders, single } = groupBySeries(badges)
  const manage = viewer.permissions.includes('badges.manage') && (
    <Link to="/admin/merker" className={buttonClass({ variant: 'secondary', size: 'sm' })}>
      <Pencil className="size-3.5" aria-hidden /> Lag merker
    </Link>
  )

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Merker"
        description="For det du har vært med på i ESAF og på Entreprenørskolen. Merkene kommer av seg selv når historikken din er fylt inn."
        actions={manage}
      />

      {missed > 0 && (
        <Card className="mb-6 flex flex-wrap items-center gap-4 p-5">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
            <Tent className="size-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1 basis-64">
            <p className="font-semibold text-stone-950">Var du der?</p>
            <p className="text-sm text-stone-600">
              {plural(missed, 'arrangement', 'arrangementer')} fra din tid har deg ikke på lista.
              Kryss av for dem du var på, så får du merkene som hører til.
            </p>
          </div>
          <Link to="/var-du-der" className={buttonClass({ variant: 'brand' })}>
            Fyll inn
          </Link>
        </Card>
      )}

      {badges.length === 0 ? (
        <EmptyState icon={Award} title="Ingen merker ennå">
          {viewer.permissions.includes('badges.manage')
            ? 'Lag de første under Admin → Merker, eller be Claude om det med MCP.'
            : 'Styret har ikke laget noen merker ennå.'}
        </EmptyState>
      ) : (
        <div className="space-y-10">
          <section aria-labelledby="dine-merker">
            <h2 id="dine-merker" className="mb-3 text-sm font-semibold text-stone-950">
              Dine merker{' '}
              <span className="font-normal text-stone-500 tabular-nums">
                {earned.length} av {badges.length}
              </span>
            </h2>
            {earned.length ? (
              <ul className="flex flex-wrap gap-x-5 gap-y-4">
                {earned.map((b) => (
                  <li key={b.id}>
                    <Link
                      to="/merker/$slug"
                      params={{ slug: b.slug }}
                      className="group flex w-24 flex-col items-center gap-2 text-center"
                    >
                      <BadgeMedal
                        badge={b}
                        className={cx(
                          'transition group-hover:scale-105',
                          b.own?.hidden && 'opacity-50',
                        )}
                      />
                      <span className="text-xs leading-tight font-medium text-stone-800">
                        {b.name}
                        {b.own?.hidden && (
                          <span className="block font-normal text-stone-400">Skjult</span>
                        )}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-stone-500">
                Du har ingen merker ennå. Se hva som skal til under, og fyll inn det du har vært med
                på.
              </p>
            )}
          </section>

          {next.length > 0 && (
            <section aria-labelledby="neste">
              <h2 id="neste" className="mb-3 text-sm font-semibold text-stone-950">
                Snart dine
              </h2>
              <ul className="grid gap-3 sm:grid-cols-2">
                {next.map((b) => (
                  <li key={b.id}>
                    <BadgeTile badge={b} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section aria-labelledby="alle">
            <h2 id="alle" className="mb-3 text-sm font-semibold text-stone-950">
              Alle merker
            </h2>
            <div className="space-y-6">
              {ladders.map((g) => (
                <div key={g.series}>
                  <h3 className="mb-2 text-xs font-medium tracking-wide text-stone-500 uppercase">
                    {g.series}
                  </h3>
                  <BadgeGrid badges={g.badges} />
                </div>
              ))}
              {single.length > 0 && (
                <div>
                  {ladders.length > 0 && (
                    <h3 className="mb-2 text-xs font-medium tracking-wide text-stone-500 uppercase">
                      Andre merker
                    </h3>
                  )}
                  <BadgeGrid badges={single} />
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

/** Ett merke i oversikten: om du har det, eller hvor langt du har kommet. */
function BadgeTile({ badge: b }: { badge: BadgeOverviewItem }) {
  const earned = b.own?.earned ?? false
  return (
    <Link
      to="/merker/$slug"
      params={{ slug: b.slug }}
      className="flex h-full gap-3.5 rounded-2xl bg-white p-4 shadow-card ring-1 ring-stone-200/70 transition hover:-translate-y-px hover:shadow-lift hover:ring-stone-300"
    >
      <BadgeMedal badge={b} earned={earned} />
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-stone-950">{b.name}</p>
        <p className="text-sm text-stone-600">{b.description}</p>
        {!earned && b.own?.progress ? (
          <BadgeProgressBar progress={b.own.progress} color={b.color} className="mt-2" />
        ) : (
          <p className="mt-1 text-xs text-stone-500">
            {earned ? 'Du har dette · ' : ''}
            {b.holders === 0
              ? 'Ingen har det ennå'
              : `${plural(b.holders, 'medlem', 'medlemmer')} har det`}
          </p>
        )}
      </div>
    </Link>
  )
}
