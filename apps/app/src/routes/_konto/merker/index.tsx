import type { BadgeOverview, BadgeOverviewItem, CohortStanding, LeaderboardEntry } from '@esaf/core'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Award, Pencil, Tent, Trophy, Users } from 'lucide-react'
import { BadgeMedal, BadgeProgressBar, LevelRing, RarityTag } from '#/components/Badges.tsx'
import {
  Avatar,
  buttonClass,
  Card,
  cx,
  EmptyState,
  ErrorText,
  PageHeader,
} from '#/components/ui.tsx'
import { fetchBadges, fetchMissedEvents } from '#/lib/badges.functions.ts'
import { plural } from '#/lib/format.ts'

export const Route = createFileRoute('/_konto/merker/')({
  loader: async () => {
    const [overview, missed] = await Promise.all([fetchBadges(), fetchMissedEvents()])
    return { overview, missed: missed.reduce((n, g) => n + g.events.length, 0) }
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

/** Sjeldne merker først blant dine egne: de er det man vil vise fram. */
const rarityOrder = { legendary: 0, epic: 1, rare: 2, uncommon: 3, common: 4 } as const

/**
 * Trinnene på samme stige (serie) samlet, laveste trinn først. Merker uten
 * trinn står sammen med de andre.
 */
function groupBySeries(badges: BadgeOverviewItem[]) {
  const ladders: { series: string; badges: BadgeOverviewItem[] }[] = []
  for (const b of badges) {
    if (!b.series || !b.step) continue
    const key = b.series.toLocaleLowerCase('nb')
    const ladder = ladders.find((l) => l.series.toLocaleLowerCase('nb') === key)
    if (ladder) ladder.badges.push(b)
    else ladders.push({ series: b.series, badges: [b] })
  }
  for (const l of ladders) l.badges.sort((a, b) => a.step!.index - b.step!.index)
  const inLadder = new Set(ladders.flatMap((l) => l.badges.map((b) => b.id)))
  return { ladders, single: badges.filter((b) => !inLadder.has(b.id)) }
}

function BadgesPage() {
  const { overview, missed } = Route.useLoaderData()
  const { viewer } = Route.useRouteContext()
  const { badges } = overview
  const earned = badges
    .filter((b) => b.own?.earned)
    .sort((a, b) => rarityOrder[a.rarity.tier] - rarityOrder[b.rarity.tier])
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
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Merker"
        description="Samle merker for det du har vært med på i ESAF og på Entreprenørskolen. Jo sjeldnere merke, jo mer XP."
        actions={manage}
      />

      {badges.length === 0 ? (
        <EmptyState icon={Award} title="Ingen merker ennå">
          {viewer.permissions.includes('badges.manage')
            ? 'Lag de første under Admin → Merker, eller be Claude om det med MCP.'
            : 'Styret har ikke laget noen merker ennå.'}
        </EmptyState>
      ) : (
        <>
          <LevelCard overview={overview} total={badges.length} />

          {missed > 0 && (
            <Card className="mt-4 flex flex-wrap items-center gap-4 p-5">
              <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
                <Tent className="size-5" aria-hidden />
              </span>
              <div className="min-w-0 flex-1 basis-64">
                <p className="font-semibold text-stone-950">Var du der?</p>
                <p className="text-sm text-stone-600">
                  {plural(missed, 'arrangement', 'arrangementer')} fra din tid har deg ikke på
                  lista. Hvert av dem kan gi deg merker og XP.
                </p>
              </div>
              <Link to="/var-du-der" className={buttonClass({ variant: 'brand' })}>
                Fyll inn
              </Link>
            </Card>
          )}

          <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="min-w-0 space-y-10">
              <section aria-labelledby="dine-merker">
                <h2 id="dine-merker" className="mb-3 text-sm font-semibold text-stone-950">
                  Dine merker{' '}
                  <span className="font-normal text-stone-500 tabular-nums">
                    {earned.length} av {badges.length}
                  </span>
                </h2>
                {earned.length ? (
                  <ul className="flex flex-wrap gap-x-4 gap-y-5">
                    {earned.map((b) => (
                      <li key={b.id}>
                        <Link
                          to="/merker/$slug"
                          params={{ slug: b.slug }}
                          className="group flex w-24 flex-col items-center gap-2 text-center"
                        >
                          <BadgeMedal
                            badge={b}
                            rarity={b.rarity.tier}
                            step={b.step}
                            className={cx(
                              'transition group-hover:-translate-y-0.5 group-hover:scale-105',
                              b.own?.hidden && 'opacity-50',
                            )}
                          />
                          <span className="text-xs leading-tight font-medium text-stone-800">
                            {b.name}
                            <RarityTag
                              rarity={b.rarity}
                              showShare={false}
                              className="mt-0.5 block text-[11px]"
                            />
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-stone-500">
                    Du har ingen merker ennå. Se hva som skal til under, og fyll inn det du har vært
                    med på.
                  </p>
                )}
              </section>

              {next.length > 0 && (
                <section aria-labelledby="neste">
                  <h2 id="neste" className="mb-3 text-sm font-semibold text-stone-950">
                    Snart dine
                  </h2>
                  <BadgeGrid badges={next} columns={2} />
                </section>
              )}

              <section aria-labelledby="alle" className="space-y-6">
                <h2 id="alle" className="text-sm font-semibold text-stone-950">
                  Alle merker
                </h2>
                {ladders.map((l) => (
                  <div key={l.series}>
                    <h3 className="mb-2 text-xs font-medium tracking-wide text-stone-500 uppercase">
                      {l.series}
                    </h3>
                    <BadgeGrid badges={l.badges} />
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
              </section>
            </div>

            <aside className="space-y-6">
              <Leaderboard entries={overview.leaderboard} me={viewer.personId} />
              <CohortRace cohorts={overview.cohorts} own={overview.ownCohorts} />
            </aside>
          </div>
        </>
      )}
    </div>
  )
}

/** Nivået ditt: ringen, tittelen, XP mot neste nivå og plassen din. */
function LevelCard({ overview, total }: { overview: BadgeOverview; total: number }) {
  const { me } = overview
  const own = overview.cohorts.find((c) => overview.ownCohorts.includes(c.graduationYear))
  const share = (me.xp - me.levelXp) / (me.nextXp - me.levelXp)
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-5 bg-gradient-to-br from-brand-50 via-white to-amber-50 p-5 sm:p-6">
        <LevelRing level={me} />
        <div className="min-w-0 flex-1 basis-60">
          <p className="text-xs font-semibold tracking-wide text-brand-700 uppercase">
            Nivå {me.level}
          </p>
          <p className="text-2xl font-semibold tracking-tight text-stone-950">{me.title}</p>
          <div
            className="mt-2 h-2 overflow-hidden rounded-full bg-stone-200"
            role="progressbar"
            aria-valuemin={me.levelXp}
            aria-valuemax={me.nextXp}
            aria-valuenow={me.xp}
            aria-label="XP mot neste nivå"
          >
            <div
              className="h-full rounded-full bg-gradient-to-r from-brand-500 to-amber-500"
              style={{ width: `${Math.max(4, share * 100)}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-stone-600 tabular-nums">
            <strong className="font-semibold text-stone-900">{me.xp} XP</strong> ·{' '}
            {me.nextXp - me.xp} til nivå {me.level + 1}
          </p>
        </div>
        <dl className="grid grid-cols-3 gap-4 text-center sm:gap-6">
          <Stat label="Merker" value={`${me.badges}/${total}`} />
          <Stat label="Toppliste" value={me.rank ? `#${me.rank}` : '–'} />
          <Stat label="Kullet ditt" value={own ? `#${own.rank}` : '–'} />
        </dl>
      </div>
    </Card>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-stone-500">{label}</dt>
      <dd className="text-xl font-semibold text-stone-950 tabular-nums">{value}</dd>
    </div>
  )
}

function BadgeGrid({ badges, columns = 3 }: { badges: BadgeOverviewItem[]; columns?: 2 | 3 }) {
  return (
    <ul className={cx('grid gap-3 sm:grid-cols-2', columns === 3 && 'xl:grid-cols-3')}>
      {badges.map((b) => (
        <li key={b.id}>
          <BadgeTile badge={b} />
        </li>
      ))}
    </ul>
  )
}

/** Ett merke i oversikten: om du har det, eller hvor langt du har kommet. */
function BadgeTile({ badge: b }: { badge: BadgeOverviewItem }) {
  const earned = b.own?.earned ?? false
  return (
    <Link
      to="/merker/$slug"
      params={{ slug: b.slug }}
      className={cx(
        'flex h-full gap-3.5 rounded-2xl p-4 shadow-card ring-1 transition hover:-translate-y-px hover:shadow-lift',
        earned
          ? 'bg-white ring-stone-200/70 hover:ring-stone-300'
          : 'bg-white/60 ring-stone-200/60 hover:bg-white',
      )}
    >
      <BadgeMedal badge={b} earned={earned} rarity={b.rarity.tier} step={b.step} />
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-stone-950">{b.name}</p>
        <p className="text-sm text-stone-600">{b.description}</p>
        <RarityTag rarity={b.rarity} showXp className="mt-1 block" />
        {!earned && b.own?.progress && (
          <BadgeProgressBar progress={b.own.progress} color={b.color} className="mt-2" />
        )}
        {earned && <p className="mt-1 text-xs font-medium text-emerald-700">Du har dette</p>}
      </div>
    </Link>
  )
}

const medalColors = ['text-amber-500', 'text-slate-400', 'text-orange-700']

function Leaderboard({ entries, me }: { entries: LeaderboardEntry[]; me: string | null }) {
  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-stone-950">
        <Trophy className="size-4 text-amber-500" aria-hidden /> Toppliste
      </h2>
      {entries.length ? (
        <ol className="mt-3 space-y-1">
          {entries.map((e) => (
            <li key={e.personId}>
              <Link
                to="/medlemmer/$personId"
                params={{ personId: e.personId }}
                className={cx(
                  'flex items-center gap-3 rounded-lg px-2 py-1.5 transition hover:bg-stone-50',
                  e.personId === me && 'bg-brand-50 hover:bg-brand-50',
                )}
              >
                <span
                  className={cx(
                    'w-5 text-center text-sm font-bold tabular-nums',
                    medalColors[e.rank - 1] ?? 'text-stone-400',
                  )}
                >
                  {e.rank}
                </span>
                <Avatar name={e.fullName} photo={e.photo} size="sm" muted={!e.claimed} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-stone-900">
                    {e.fullName}
                  </span>
                  <span className="block text-xs text-stone-500">
                    Nivå {e.level} · {e.title}
                  </span>
                </span>
                <span className="text-xs font-semibold text-stone-700 tabular-nums">{e.xp} XP</span>
              </Link>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-2 text-sm text-stone-500">Ingen har merker ennå.</p>
      )}
    </Card>
  )
}

function CohortRace({ cohorts, own }: { cohorts: CohortStanding[]; own: number[] }) {
  const max = Math.max(1, ...cohorts.map((c) => c.xpPerMember))
  const shown = cohorts.slice(0, 8)
  const mine = cohorts.filter((c) => own.includes(c.graduationYear) && !shown.includes(c))
  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-stone-950">
        <Users className="size-4 text-brand-500" aria-hidden /> Kull mot kull
      </h2>
      <p className="mt-1 text-xs text-stone-500">
        XP per aktivt medlem, så små kull kan slå store.
      </p>
      {cohorts.length ? (
        <ol className="mt-3 space-y-2.5">
          {[...shown, ...mine].map((c) => {
            const isOwn = own.includes(c.graduationYear)
            return (
              <li key={c.graduationYear}>
                <Link to="/kull/$year" params={{ year: c.graduationYear }} className="group block">
                  <span className="flex items-baseline justify-between gap-2 text-sm">
                    <span
                      className={cx('font-medium', isOwn ? 'text-brand-700' : 'text-stone-800')}
                    >
                      <span className="mr-1.5 text-stone-400 tabular-nums">{c.rank}</span>
                      ES {c.graduationYear}
                      {isOwn && ' (ditt)'}
                    </span>
                    <span className="text-xs text-stone-500 tabular-nums">
                      {c.xpPerMember.toLocaleString('nb')} XP
                    </span>
                  </span>
                  <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-stone-100">
                    <span
                      className={cx(
                        'block h-full rounded-full transition group-hover:brightness-110',
                        isOwn ? 'bg-brand-500' : 'bg-stone-400',
                      )}
                      style={{ width: `${(c.xpPerMember / max) * 100}%` }}
                    />
                  </span>
                </Link>
              </li>
            )
          })}
        </ol>
      ) : (
        <p className="mt-2 text-sm text-stone-500">
          Ingen kull er med ennå. Et kull trenger minst tre aktive medlemmer.
        </p>
      )}
    </Card>
  )
}
