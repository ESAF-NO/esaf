import type { CohortCompany, CohortRepresentatives, MemberListItem } from '@esaf/core'
import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { ArrowLeft, Megaphone, Pencil, Search, Trophy } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'
import { comparePeople, PersonCard } from '#/components/PersonCard.tsx'
import { PostCard } from '#/components/PostCard.tsx'
import { RepresentativeCard } from '#/components/Representatives.tsx'
import { buttonClass, Card, CompanyLogo } from '#/components/ui.tsx'
import { fetchCohortStanding } from '#/lib/badges.functions.ts'
import { fetchCohort } from '#/lib/cohorts.functions.ts'
import { esPeriod, plural, yearSpan } from '#/lib/format.ts'

export const Route = createFileRoute('/_konto/kull/$year')({
  // Kull heter etter uteksamineringsåret: /kull/2024 er ES 2024, som gikk 2022–2024.
  params: {
    parse: ({ year }) => ({ year: Number(year) }),
    stringify: ({ year }) => ({ year: String(year) }),
  },
  loader: async ({ params }) => {
    if (!Number.isInteger(params.year)) throw notFound()
    const [cohort, race] = await Promise.all([
      fetchCohort({ data: { year: params.year } }),
      fetchCohortStanding({ data: { year: params.year } }),
    ])
    return { ...cohort, race }
  },
  head: ({ loaderData }) => ({
    meta: [{ title: loaderData ? `ES ${loaderData.graduationYear} – ESAF` : 'Kull – ESAF' }],
  }),
  component: CohortPage,
  notFoundComponent: CohortNotFound,
})

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold text-stone-950">{title}</h2>
      {children}
    </section>
  )
}

function PeopleGrid({ people }: { people: MemberListItem[] }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {people.map((m) => (
        <li key={m.personId}>
          <PersonCard member={m} />
        </li>
      ))}
    </ul>
  )
}

function CohortPage() {
  const c = Route.useLoaderData()
  const { viewer } = Route.useRouteContext()
  const year = c.graduationYear
  // Mentorer og ansatte hører til kullet, men er ikke en del av klassen.
  const isStudent = (m: MemberListItem) =>
    m.cohorts.some((x) => x.graduationYear === year && x.relation === 'student')
  const students = c.people.filter(isStudent).sort(comparePeople)
  const others = c.people.filter((m) => !isStudent(m)).sort(comparePeople)

  return (
    <>
      <Link
        to="/kull"
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-900"
      >
        <ArrowLeft className="size-4" aria-hidden /> Kull
      </Link>

      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-stone-950 tabular-nums sm:text-[28px]">
            ES {year}
            {c.name && <span className="font-normal text-stone-500"> · {c.name}</span>}
          </h1>
          <p className="mt-1 text-sm text-stone-500 tabular-nums">
            {[
              c.isOwn && 'Ditt kull',
              esPeriod(year),
              plural(c.members, 'person', 'personer'),
              `${c.claimed} har tatt i bruk profilen`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        {c.members > 0 && (
          <Link
            to="/medlemmer"
            search={{ kull: year }}
            className={buttonClass({ variant: 'secondary', size: 'sm' })}
          >
            <Search className="size-4" aria-hidden /> Søk i kullet
          </Link>
        )}
      </div>

      <Representatives
        year={year}
        reps={c.representatives}
        canManage={viewer.permissions.includes('members.manage')}
      />

      {c.race.standing && (
        <Link
          to="/merker"
          className="mb-8 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-2xl bg-gradient-to-br from-brand-50 via-white to-amber-50 p-4 shadow-card ring-1 ring-stone-200/70 transition hover:ring-stone-300"
        >
          <span className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-full bg-white text-amber-500 shadow-sm ring-1 ring-amber-200">
              <Trophy className="size-5" aria-hidden />
            </span>
            <span>
              <span className="block text-xs font-semibold tracking-wide text-brand-700 uppercase">
                Kull mot kull
              </span>
              <span className="block text-lg font-semibold text-stone-950 tabular-nums">
                #{c.race.standing.rank} av {c.race.cohorts}
              </span>
            </span>
          </span>
          <span className="text-sm text-stone-600 tabular-nums">
            {c.race.standing.xpPerMember.toLocaleString('nb')} XP per medlem ·{' '}
            {c.race.standing.badgesPerMember.toLocaleString('nb')} merker per medlem ·{' '}
            {Math.round(c.race.standing.collectors * 100)} % har minst ett
          </span>
        </Link>
      )}

      {c.members === 0 ? (
        <p className="text-sm text-stone-500">Ingen fra ES {year} er med i ESAF-appen ennå.</p>
      ) : (
        <div className="space-y-10">
          <Section title="Personer">
            {students.length > 0 ? (
              <PeopleGrid people={students} />
            ) : (
              <p className="text-sm text-stone-500">Ingen studenter fra kullet er med ennå.</p>
            )}
          </Section>

          {others.length > 0 && (
            <Section title="Mentorer og ansatte">
              <PeopleGrid people={others} />
            </Section>
          )}

          <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div className="xl:col-start-2 xl:row-start-1">
              <Section title="Selskaper fra kullet">
                {c.companies.length > 0 ? (
                  <Card className="divide-y divide-stone-100 px-4">
                    {c.companies.map((company) => (
                      <CompanyRow key={company.slug} company={company} />
                    ))}
                  </Card>
                ) : (
                  <p className="text-sm text-stone-500">
                    Ingen i kullet har lagt inn selskaper de har startet ennå.
                  </p>
                )}
              </Section>
            </div>
            <div className="min-w-0 xl:col-start-1 xl:row-start-1">
              <Section title="Siste innlegg fra kullet">
                {c.posts.length > 0 ? (
                  <div className="space-y-3">
                    {c.posts.map((post) => (
                      <PostCard key={post.id} post={post} />
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-stone-500">Ingen fra kullet har skrevet noe ennå.</p>
                )}
              </Section>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/**
 * Kullrepresentantene øverst på kullsiden: dem styret snakker med. Tidligere
 * representanter står under, i en roligere stil.
 */
function Representatives({
  year,
  reps,
  canManage,
}: {
  year: number
  reps: CohortRepresentatives
  canManage: boolean
}) {
  const edit = canManage && (
    <Link
      to="/admin/kullrepresentanter"
      hash={`es-${year}`}
      className={buttonClass({ variant: 'ghost', size: 'sm' })}
    >
      <Pencil className="size-3.5" aria-hidden /> Endre
    </Link>
  )
  if (!reps.current.length && !reps.past.length) {
    return (
      <p className="mb-8 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-stone-500">
        <Megaphone className="size-4 text-stone-400" aria-hidden />
        Kullet har ingen kullrepresentant registrert.
        {edit}
      </p>
    )
  }
  return (
    <section aria-labelledby="kullrepresentanter" className="mb-10">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="kullrepresentanter" className="text-sm font-semibold text-stone-950">
          {reps.current.length === 1 ? 'Kullrepresentant' : 'Kullrepresentanter'}
        </h2>
        {edit}
      </div>
      {reps.current.length > 0 ? (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {reps.current.map((r) => (
            <li key={r.id}>
              <RepresentativeCard rep={r} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-stone-500">Kullet har ingen kullrepresentant nå.</p>
      )}
      {reps.past.length > 0 && (
        <p className="mt-3 text-sm text-stone-500">
          <span className="font-medium text-stone-600">Tidligere kullrepresentanter:</span>{' '}
          {reps.past.map((r, i) => (
            <Fragment key={r.id}>
              {i > 0 && ', '}
              <Link
                to="/medlemmer/$personId"
                params={{ personId: r.personId }}
                className="text-stone-700 hover:text-brand-600"
              >
                {r.fullName}
              </Link>{' '}
              <span className="tabular-nums">({yearSpan(r.startYear, r.endYear)})</span>
            </Fragment>
          ))}
        </p>
      )}
    </section>
  )
}

function CompanyRow({ company: c }: { company: CohortCompany }) {
  return (
    <div className="flex gap-3 py-3.5">
      <CompanyLogo name={c.name} logo={c.logo} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline justify-between gap-2">
          <Link
            to="/selskaper"
            search={{ q: c.name }}
            className="truncate font-medium text-stone-950 hover:text-brand-600"
          >
            {c.name}
          </Link>
          <span className="shrink-0 text-xs text-stone-500">
            {c.esCompany ? 'ES-selskap' : 'Gründerselskap'}
          </span>
        </p>
        <p className="mt-0.5 text-sm text-stone-600">
          {c.people.map((p, i) => (
            <Fragment key={p.personId}>
              {i > 0 && ', '}
              <Link
                to="/medlemmer/$personId"
                params={{ personId: p.personId }}
                className="hover:text-brand-600"
              >
                {p.fullName}
              </Link>
            </Fragment>
          ))}
        </p>
      </div>
    </div>
  )
}

function CohortNotFound() {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-xl font-semibold tracking-tight text-stone-950">Fant ikke kullet</h1>
      <p className="mt-2 text-sm text-stone-500">Det finnes ikke noe ES-kull med det årstallet.</p>
      <Link to="/kull" className={buttonClass({ variant: 'secondary', size: 'sm' }, 'mt-6')}>
        Se alle kull
      </Link>
    </div>
  )
}
