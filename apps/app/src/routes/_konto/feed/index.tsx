import type { CohortSummary, CommunityOverview } from '@esaf/core'
import { createFileRoute, Link } from '@tanstack/react-router'
import {
  ArrowRight,
  Flame,
  GraduationCap,
  Inbox,
  PenSquare,
  Sparkles,
  UserPen,
  X,
  type LucideIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { z } from 'zod'
import { PostCard } from '#/components/PostCard.tsx'
import { Avatar, buttonClass, Card, cx, EmptyState } from '#/components/ui.tsx'
import { channelKeys, channelOrder, channels } from '#/lib/channels.ts'
import { fetchCommunity, fetchPosts } from '#/lib/feed.functions.ts'
import { esPeriod, plural } from '#/lib/format.ts'

export const Route = createFileRoute('/_konto/feed/')({
  validateSearch: z.object({
    kanal: z.enum(channelKeys).optional().catch(undefined),
    sort: z.enum(['top', 'new']).optional().catch(undefined),
    q: z.string().optional().catch(undefined),
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const [posts, community] = await Promise.all([
      fetchPosts({ data: { channel: deps.kanal, sort: deps.sort ?? 'top', q: deps.q, limit: 50 } }),
      fetchCommunity(),
    ])
    return { posts, community }
  },
  head: ({ match }) => ({
    meta: [
      { title: `${match.search.kanal ? channels[match.search.kanal].plural : 'Hjem'} – ESAF` },
    ],
  }),
  component: Feed,
})

function ActionTile({
  icon: Icon,
  children,
  link,
}: {
  icon: LucideIcon
  children: ReactNode
  link: ReactNode
}) {
  return (
    <div className="group relative bg-white p-5 transition hover:bg-stone-50">
      <span className="grid size-9 place-items-center rounded-lg bg-stone-100 text-stone-600 group-hover:bg-brand-50 group-hover:text-brand-600">
        <Icon className="size-[18px]" aria-hidden />
      </span>
      <p className="mt-3 flex items-center gap-1 font-medium text-stone-950">
        {link}
        <ArrowRight
          className="size-4 -translate-x-1 opacity-0 transition group-hover:translate-x-0 group-hover:opacity-100"
          aria-hidden
        />
      </p>
      <p className="mt-0.5 text-sm text-stone-500">{children}</p>
    </div>
  )
}

/** Vises når nettverket ikke har innlegg ennå, så første besøk har noe å gjøre. */
function Welcome({
  community,
  personId,
  firstName,
}: {
  community: CommunityOverview
  personId: string | null
  firstName?: string
}) {
  const own = community.ownYears.at(-1)
  const newest = community.cohorts[0]?.graduationYear
  const oldest = community.cohorts.at(-1)?.graduationYear
  // Lenken dekker hele flisen.
  const cover = 'after:absolute after:inset-0 focus-visible:outline-none'
  return (
    <Card className="overflow-hidden">
      <div className="relative overflow-hidden bg-stone-950 px-6 py-8 text-white sm:px-8">
        <div
          className="absolute -top-24 -right-16 size-72 rounded-full bg-brand-600/40 blur-3xl"
          aria-hidden
        />
        <div
          className="absolute -bottom-32 left-1/3 size-72 rounded-full bg-rose-500/20 blur-3xl"
          aria-hidden
        />
        <div className="relative">
          <p className="text-sm font-medium text-brand-300">
            Velkommen{firstName ? `, ${firstName}` : ''}
          </p>
          <h2 className="mt-2 max-w-xl text-2xl font-semibold tracking-tight text-balance sm:text-[28px]">
            {community.members} fra Entreprenørskolen er her allerede, fra ES {oldest} til ES{' '}
            {newest}.
          </h2>
          <p className="mt-3 max-w-lg text-sm leading-relaxed text-white/70">
            Ingen har skrevet noe ennå. Fyll ut profilen din, finn igjen kullet ditt, og still det
            første spørsmålet til nettverket.
          </p>
        </div>
      </div>
      <div className="grid gap-px bg-stone-200/70 sm:grid-cols-3">
        {personId && (
          <ActionTile
            icon={UserPen}
            link={
              <Link to="/medlemmer/$personId/rediger" params={{ personId }} className={cover}>
                Fullfør profilen
              </Link>
            }
          >
            Erfaring, bransjer og hva du kan hjelpe med.
          </ActionTile>
        )}
        <ActionTile
          icon={GraduationCap}
          link={
            own ? (
              <Link to="/kull/$year" params={{ year: own }} className={cover}>
                Se ES {own}
              </Link>
            ) : (
              <Link to="/kull" className={cover}>
                Se alle kull
              </Link>
            )
          }
        >
          {own
            ? 'Finn igjen folk fra ditt eget kull.'
            : `${community.cohorts.length} kull, ett sted.`}
        </ActionTile>
        <ActionTile
          icon={PenSquare}
          link={
            <Link to="/feed/ny" className={cover}>
              Skriv det første innlegget
            </Link>
          }
        >
          Spør om råd, be om en intro eller del en lansering.
        </ActionTile>
      </div>
    </Card>
  )
}

function OwnCohort({ cohort: c }: { cohort: CohortSummary }) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Link
            to="/kull/$year"
            params={{ year: c.graduationYear }}
            className="text-lg font-semibold tracking-tight text-stone-950 hover:text-brand-600"
          >
            ES {c.graduationYear}
          </Link>
          <p className="text-xs text-stone-500">Ditt kull · {esPeriod(c.graduationYear)}</p>
        </div>
        <Link
          to="/kull/$year"
          params={{ year: c.graduationYear }}
          className="text-sm font-medium text-brand-600 hover:underline"
        >
          Se kullet
        </Link>
      </div>
      <div className="mt-3 flex -space-x-1.5">
        {c.preview.map((p) => (
          <Link
            key={p.personId}
            to="/medlemmer/$personId"
            params={{ personId: p.personId }}
            title={p.fullName}
            className="inline-flex rounded-full ring-2 ring-white transition hover:z-10 hover:-translate-y-0.5"
          >
            <Avatar name={p.fullName} photo={p.photo} size="sm" muted={!p.claimed} />
          </Link>
        ))}
      </div>
      <p className="mt-2.5 text-xs text-stone-500">
        {plural(c.members, 'person', 'personer')} · {c.claimed} har tatt i bruk profilen
      </p>
    </Card>
  )
}

function Feed() {
  const { posts, community } = Route.useLoaderData()
  const { kanal, sort = 'top', q } = Route.useSearch()
  const { viewer } = Route.useRouteContext()
  const channel = kanal ? channels[kanal] : null
  const firstName = viewer.fullName?.split(' ')[0]
  const ownCohort = community.cohorts.find((c) => c.graduationYear === community.ownYears.at(-1))

  return (
    <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0">
        <div className="mb-6">
          {channel ? (
            <div className="flex items-center gap-3">
              <span
                className={cx(
                  'grid size-10 place-items-center rounded-xl ring-1 ring-inset',
                  channel.tone,
                )}
              >
                <channel.icon className="size-5" aria-hidden />
              </span>
              <div>
                <h1 className="text-2xl font-semibold tracking-tight text-stone-950">
                  {channel.plural}
                </h1>
                <p className="text-sm text-stone-500">{channel.hint}</p>
              </div>
            </div>
          ) : (
            <>
              <h1 className="text-2xl font-semibold tracking-tight text-stone-950 sm:text-[28px]">
                {firstName ? `Hei, ${firstName}` : 'Hjem'}
              </h1>
              <p className="mt-1 text-sm text-stone-500">Hva skjer i ES-nettverket.</p>
            </>
          )}
        </div>

        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div
            className="inline-flex rounded-xl bg-stone-200/60 p-1"
            role="tablist"
            aria-label="Sortering"
          >
            {(
              [
                ['top', 'Populært', Flame],
                ['new', 'Nyeste', Sparkles],
              ] as const
            ).map(([value, label, Icon]) => (
              <Link
                key={value}
                to="/feed"
                search={(prev) => ({ ...prev, sort: value === 'top' ? undefined : value })}
                role="tab"
                aria-selected={sort === value}
                className={cx(
                  'inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition',
                  sort === value
                    ? 'bg-white text-stone-950 shadow-card'
                    : 'text-stone-600 hover:text-stone-900',
                )}
              >
                <Icon className="size-4" aria-hidden /> {label}
              </Link>
            ))}
          </div>
          {q && (
            <Link
              to="/feed"
              search={(prev) => ({ ...prev, q: undefined })}
              className="inline-flex items-center gap-1.5 rounded-full bg-stone-900 px-3 py-1 text-sm text-white"
            >
              Søk: {q} <X className="size-3.5" aria-label="Fjern søk" />
            </Link>
          )}
        </div>

        <div className="-mx-1 mb-5 flex gap-2 overflow-x-auto px-1 pb-1 xl:hidden">
          <Link
            to="/feed"
            search={(prev) => ({ ...prev, kanal: undefined })}
            className={cx(
              'shrink-0 rounded-full px-3 py-1.5 text-sm font-medium ring-1 ring-inset',
              !kanal
                ? 'bg-stone-900 text-white ring-stone-900'
                : 'bg-white text-stone-600 ring-stone-200',
            )}
          >
            Alle
          </Link>
          {channelOrder.map((key) => (
            <Link
              key={key}
              to="/feed"
              search={(prev) => ({ ...prev, kanal: key })}
              className={cx(
                'shrink-0 rounded-full px-3 py-1.5 text-sm font-medium ring-1 ring-inset',
                kanal === key
                  ? 'bg-stone-900 text-white ring-stone-900'
                  : 'bg-white text-stone-600 ring-stone-200',
              )}
            >
              {channels[key].plural}
            </Link>
          ))}
        </div>

        {posts.length === 0 && !kanal && !q ? (
          <Welcome community={community} personId={viewer.personId} firstName={firstName} />
        ) : posts.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title={q ? 'Ingen innlegg matcher søket' : 'Ingen innlegg her ennå'}
          >
            <Link
              to="/feed/ny"
              search={{ kanal }}
              className="font-medium text-brand-600 hover:underline"
            >
              Bli den første som skriver noe
            </Link>
          </EmptyState>
        ) : (
          <div className="space-y-3">
            {posts.map((post) => (
              <PostCard key={post.id} post={post} />
            ))}
          </div>
        )}
      </div>

      <aside className="hidden space-y-4 xl:block">
        <Card className="overflow-hidden">
          <div className="bg-gradient-to-br from-brand-500 via-brand-600 to-rose-600 p-5 text-white">
            <p className="text-sm font-medium text-white/80">Nettverket svarer</p>
            <p className="mt-1 text-lg leading-snug font-semibold">
              Trenger du råd, en intro eller en ny ansatt? Spør ES-fellesskapet.
            </p>
          </div>
          <div className="p-4">
            <Link
              to="/feed/ny"
              search={{ kanal }}
              className={buttonClass({ variant: 'primary' }, 'w-full')}
            >
              <PenSquare className="size-4" aria-hidden /> Skriv et innlegg
            </Link>
          </div>
        </Card>

        {ownCohort && <OwnCohort cohort={ownCohort} />}

        <Card className="p-2">
          <p className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wider text-stone-400 uppercase">
            Kanaler
          </p>
          {channelOrder.map((key) => {
            const c = channels[key]
            return (
              <Link
                key={key}
                to="/feed"
                search={{ kanal: key }}
                className={cx(
                  'flex items-center gap-3 rounded-xl px-3 py-2 transition hover:bg-stone-50',
                  kanal === key && 'bg-stone-100',
                )}
              >
                <span
                  className={cx(
                    'grid size-8 place-items-center rounded-lg ring-1 ring-inset',
                    c.tone,
                  )}
                >
                  <c.icon className="size-4" aria-hidden />
                </span>
                <span>
                  <span className="block text-sm font-medium text-stone-900">{c.plural}</span>
                  <span className="block text-xs text-stone-500">{c.hint}</span>
                </span>
              </Link>
            )
          })}
        </Card>
      </aside>
    </div>
  )
}
