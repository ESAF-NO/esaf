import type { Experience } from '@esaf/core'
import { createFileRoute, Link } from '@tanstack/react-router'
import {
  ArrowLeft,
  BriefcaseBusiness,
  GraduationCap,
  Info,
  Mail,
  MapPin,
  Pencil,
  Phone,
  Plus,
  Rocket,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { PostCard } from '#/components/PostCard.tsx'
import {
  Avatar,
  buttonClass,
  Card,
  CompanyMark,
  LinkedInIcon,
  ProfileStatus,
  Verified,
} from '#/components/ui.tsx'
import { fetchPosts } from '#/lib/feed.functions.ts'
import { esPeriod, yearSpan } from '#/lib/format.ts'
import { fetchProfile } from '#/lib/profiles.functions.ts'

export const Route = createFileRoute('/_konto/medlemmer/$personId/')({
  loader: async ({ params }) => {
    const [profile, posts] = await Promise.all([
      fetchProfile({ data: { personId: params.personId } }),
      fetchPosts({ data: { authorPersonId: params.personId, sort: 'new', limit: 10 } }),
    ])
    return { profile, posts }
  },
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.profile.fullName ?? 'Profil'} – ESAF` }],
  }),
  component: ProfilePage,
})

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
        <dd className="text-sm font-medium text-stone-900">{children}</dd>
      </div>
    </div>
  )
}

function TagLinks({ tags }: { tags: string[] }) {
  return (
    <ul className="mt-3 flex flex-wrap gap-2">
      {tags.map((tag) => (
        <li key={tag}>
          <Link
            to="/medlemmer"
            search={{ q: tag }}
            className="inline-flex rounded-full bg-stone-100 px-3 py-1 text-sm font-medium text-stone-700 transition hover:bg-stone-900 hover:text-white"
          >
            {tag}
          </Link>
        </li>
      ))}
    </ul>
  )
}

function ExperienceList({ items }: { items: Experience[] }) {
  return (
    <ol className="mt-4 space-y-5">
      {items.map((e) => (
        <li key={e.id} className="flex gap-3.5">
          <CompanyMark name={e.company} />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-stone-950">
              {e.title ?? (e.founder ? 'Gründer' : e.company)}
            </p>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-stone-600">
              <Link
                to="/selskaper"
                search={{ q: e.company, vis: 'alle' }}
                className="hover:text-brand-600"
              >
                {e.company}
              </Link>
              {e.founder && e.title && (
                <span className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700 ring-1 ring-brand-600/15 ring-inset">
                  <Rocket className="size-3" aria-hidden /> Gründer
                </span>
              )}
            </p>
            <p className="mt-0.5 text-xs text-stone-500 tabular-nums">
              {yearSpan(e.startYear, e.endYear)}
            </p>
          </div>
        </li>
      ))}
    </ol>
  )
}

function ProfilePage() {
  const { profile: p, posts } = Route.useLoaderData()
  const headline = [p.jobTitle, p.currentCompany].filter(Boolean).join(' · ')
  const empty =
    !p.bio && p.experience.length === 0 && p.expertise.length === 0 && p.industries.length === 0

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        to="/medlemmer"
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-900"
      >
        <ArrowLeft className="size-4" aria-hidden /> Personer
      </Link>

      <Card className="overflow-hidden">
        <div
          className={
            p.claimed
              ? 'h-28 bg-gradient-to-br from-brand-400 via-brand-600 to-rose-600 sm:h-36'
              : 'h-28 bg-gradient-to-br from-stone-200 to-stone-300 sm:h-36'
          }
          aria-hidden
        />
        <div className="px-5 pb-6 sm:px-8">
          <div className="-mt-12 flex flex-wrap items-end justify-between gap-4 sm:-mt-14">
            <Avatar
              name={p.fullName}
              photo={p.photo}
              size="xl"
              muted={!p.claimed}
              className="ring-4 ring-white"
            />
            <div className="flex flex-wrap gap-2 pb-1">
              {p.linkedinUrl && (
                <a
                  href={p.linkedinUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonClass({ variant: 'secondary' })}
                >
                  <LinkedInIcon className="size-4 text-[#0A66C2]" /> LinkedIn
                </a>
              )}
              {p.contactEmail && (
                <a
                  href={`mailto:${p.contactEmail}`}
                  className={buttonClass({ variant: 'primary' })}
                >
                  <Mail className="size-4" aria-hidden /> Send e-post
                </a>
              )}
              {p.canEdit && (
                <Link
                  to="/medlemmer/$personId/rediger"
                  params={{ personId: p.personId }}
                  className={buttonClass({ variant: 'secondary' })}
                >
                  <Pencil className="size-4" aria-hidden /> {p.isOwn ? 'Rediger profil' : 'Rediger'}
                </Link>
              )}
            </div>
          </div>

          <div className="mt-4">
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-stone-950 sm:text-3xl">
              {p.fullName}
              <Verified claimed={p.claimed} className="size-6" />
            </h1>
            {headline && <p className="mt-1 text-base text-stone-600">{headline}</p>}
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-stone-500">
              {p.cohorts.map((c) => (
                <Link
                  key={c.graduationYear}
                  to="/kull/$year"
                  params={{ year: c.graduationYear }}
                  className="inline-flex items-center gap-1.5 font-medium text-stone-700 hover:text-brand-600"
                >
                  <GraduationCap className="size-4" aria-hidden /> ES {c.graduationYear}
                  {c.relation !== 'student' &&
                    ` (${c.relation === 'mentor' ? 'mentor' : 'ansatt'})`}
                </Link>
              ))}
              {p.city && (
                <span className="inline-flex items-center gap-1.5">
                  <MapPin className="size-4" aria-hidden /> {p.city}
                </span>
              )}
              <ProfileStatus claimed={p.claimed} />
            </div>
          </div>
        </div>
      </Card>

      {!p.claimed && (
        <div className="mt-4 flex gap-3 rounded-2xl bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>
            Profilen er lagt inn av ESAF fra kullisten. {p.fullName.split(' ')[0]} har ikke tatt den
            i bruk ennå, så informasjonen kan være utdatert.
          </p>
        </div>
      )}
      {p.isOwn && empty && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-brand-50 p-4 text-sm text-brand-900 ring-1 ring-brand-200 ring-inset">
          <p>
            Fyll ut profilen din: hvor du jobber og har jobbet, bransjer og hva du kan hjelpe med.
            Da finner andre ES-ere deg.
          </p>
          <Link
            to="/medlemmer/$personId/rediger"
            params={{ personId: p.personId }}
            className={buttonClass({ variant: 'brand', size: 'sm' })}
          >
            Fyll ut profilen
          </Link>
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="space-y-6">
          {p.bio && (
            <Card className="p-5 sm:p-6">
              <h2 className="text-sm font-semibold text-stone-950">Om</h2>
              <p className="mt-2 text-[15px] leading-relaxed whitespace-pre-line text-stone-700">
                {p.bio}
              </p>
            </Card>
          )}
          {p.experience.length > 0 ? (
            <Card className="p-5 sm:p-6">
              <h2 className="text-sm font-semibold text-stone-950">Erfaring</h2>
              <ExperienceList items={p.experience} />
            </Card>
          ) : (
            p.canEdit && (
              <Link
                to="/medlemmer/$personId/rediger"
                params={{ personId: p.personId }}
                className="flex items-center gap-3 rounded-2xl border border-dashed border-stone-300 p-5 text-sm text-stone-500 transition hover:border-stone-400 hover:text-stone-800"
              >
                <span className="grid size-10 place-items-center rounded-xl bg-stone-100">
                  <BriefcaseBusiness className="size-5" aria-hidden />
                </span>
                <span className="flex-1">
                  <span className="block font-medium text-stone-800">Legg til erfaring</span>
                  Selskaper {p.isOwn ? 'du' : p.fullName.split(' ')[0]} har startet eller jobbet i,
                  nå og tidligere.
                </span>
                <Plus className="size-4" aria-hidden />
              </Link>
            )
          )}
          {p.expertise.length > 0 && (
            <Card className="p-5 sm:p-6">
              <h2 className="text-sm font-semibold text-stone-950">Kan hjelpe med</h2>
              <TagLinks tags={p.expertise} />
            </Card>
          )}
          {p.industries.length > 0 && (
            <Card className="p-5 sm:p-6">
              <h2 className="text-sm font-semibold text-stone-950">Bransjer</h2>
              <TagLinks tags={p.industries} />
            </Card>
          )}

          <section>
            <h2 className="mb-3 text-sm font-semibold text-stone-950">Innlegg</h2>
            {posts.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-stone-300 px-4 py-8 text-center text-sm text-stone-500">
                {p.isOwn ? 'Du har ikke skrevet noe ennå.' : 'Ingen innlegg ennå.'}
              </p>
            ) : (
              <div className="space-y-3">
                {posts.map((post) => (
                  <PostCard key={post.id} post={post} />
                ))}
              </div>
            )}
          </section>
        </div>

        <aside className="space-y-4">
          <Card className="p-5">
            <h2 className="mb-4 text-sm font-semibold text-stone-950">Bakgrunn</h2>
            <dl className="space-y-4">
              {p.cohorts.map((c) => (
                <Fact key={c.graduationYear} icon={GraduationCap} label="Entreprenørskolen">
                  <Link
                    to="/kull/$year"
                    params={{ year: c.graduationYear }}
                    className="hover:text-brand-600"
                  >
                    ES {c.graduationYear}
                  </Link>{' '}
                  <span className="font-normal text-stone-500">({esPeriod(c.graduationYear)})</span>
                </Fact>
              ))}
              {p.esCompany && (
                <Fact icon={Rocket} label="Selskap på ES">
                  <Link
                    to="/selskaper"
                    search={{ q: p.esCompany }}
                    className="hover:text-brand-600"
                  >
                    {p.esCompany}
                  </Link>
                </Fact>
              )}
              {p.studyBackground && (
                <Fact icon={GraduationCap} label="Studieretning før ES">
                  {p.studyBackground}
                </Fact>
              )}
              {p.city && (
                <Fact icon={MapPin} label="Bor i">
                  {p.city}
                </Fact>
              )}
            </dl>
          </Card>

          <Card className="p-5">
            <h2 className="mb-3 text-sm font-semibold text-stone-950">Kontakt</h2>
            {p.linkedinUrl || p.contactEmail || p.phone ? (
              <ul className="space-y-2.5 text-sm">
                {p.linkedinUrl && (
                  <li>
                    <a
                      href={p.linkedinUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 text-stone-700 hover:text-brand-600"
                    >
                      <LinkedInIcon className="size-4 text-[#0A66C2]" /> LinkedIn-profil
                    </a>
                  </li>
                )}
                {p.contactEmail && (
                  <li>
                    <a
                      href={`mailto:${p.contactEmail}`}
                      className="inline-flex items-center gap-2 break-all text-stone-700 hover:text-brand-600"
                    >
                      <Mail className="size-4 shrink-0 text-stone-400" aria-hidden />{' '}
                      {p.contactEmail}
                    </a>
                  </li>
                )}
                {p.phone && (
                  <li>
                    <a
                      href={`tel:${p.phone.replace(/[^+0-9]/g, '')}`}
                      className="inline-flex items-center gap-2 text-stone-700 hover:text-brand-600"
                    >
                      <Phone className="size-4 text-stone-400" aria-hidden /> {p.phone}
                    </a>
                  </li>
                )}
              </ul>
            ) : (
              <p className="text-sm text-stone-500">
                {p.isOwn
                  ? 'Du deler ingen kontaktinfo. Legg det til under «Rediger profil».'
                  : 'Ingen kontaktinfo delt.'}
              </p>
            )}
          </Card>
        </aside>
      </div>
    </div>
  )
}
