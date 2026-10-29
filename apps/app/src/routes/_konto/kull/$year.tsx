import type { CohortCompany, MemberListItem } from '@esaf/core'
import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { ArrowLeft, Search } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'
import { comparePeople, PersonCard } from '#/components/PersonCard.tsx'
import { PostCard } from '#/components/PostCard.tsx'
import { buttonClass, Card, CompanyLogo } from '#/components/ui.tsx'
import { fetchCohort } from '#/lib/cohorts.functions.ts'
import { esPeriod, plural } from '#/lib/format.ts'

export const Route = createFileRoute('/_konto/kull/$year')({
  // Kull heter etter uteksamineringsåret: /kull/2024 er ES 2024, som gikk 2022–2024.
  params: {
    parse: ({ year }) => ({ year: Number(year) }),
    stringify: ({ year }) => ({ year: String(year) }),
  },
  loader: ({ params }) => {
    if (!Number.isInteger(params.year)) throw notFound()
    return fetchCohort({ data: { year: params.year } })
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
