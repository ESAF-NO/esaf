import {
  createFileRoute,
  Link,
  notFound,
  Outlet,
  redirect,
  useLocation,
} from '@tanstack/react-router'
import {
  Award,
  Bot,
  Building2,
  CalendarDays,
  ChevronDown,
  ClipboardCheck,
  GraduationCap,
  History,
  IdCard,
  Inbox,
  Landmark,
  Mail,
  MailPlus,
  Users,
} from 'lucide-react'
import { PageHeader } from '#/components/ui.tsx'
import { fetchReviewCounts } from '#/lib/review.functions.ts'

/**
 * Adminområdet: menyen og vakten for alle adminsider. Hver side vises bare for
 * dem som har rettigheten den krever, og hver underside sjekker den på nytt.
 * Serverfunksjonene håndhever rettighetene uansett; vaktene her er for
 * brukervennligheten.
 *
 * Menyen er gruppert. På brede skjermer står den til venstre for innholdet; på
 * smalere er den en knapp med siden man er på, som åpner den samme lista.
 */
export const Route = createFileRoute('/_konto/admin')({
  beforeLoad: ({ context: { viewer } }) => {
    // Uten adminrolle får man samme svar som om siden ikke fantes.
    if (!viewer.adminArea) throw notFound()
    if (viewer.strongAuthMissing) {
      throw redirect({ to: '/konto', search: { krav: 'sterk-innlogging' } })
    }
  },
  // Antallet i «Gjennomgang» hentes på nytt ved hver navigering og etter hver handling.
  loader: ({ context: { viewer } }) =>
    viewer.permissions.includes('profiles.edit') ? fetchReviewCounts() : null,
  component: AdminLayout,
})

const groups = [
  {
    label: 'Medlemmer',
    items: [
      { to: '/admin', label: 'Forespørsler', icon: Inbox, permission: 'members.review' },
      {
        to: '/admin/invitasjoner',
        label: 'Invitasjoner',
        icon: MailPlus,
        permission: 'members.review',
      },
      { to: '/admin/medlemmer', label: 'Medlemmer', icon: Users, permission: 'members.manage' },
      { to: '/admin/styret', label: 'Styret', icon: Landmark, permission: 'members.manage' },
      {
        to: '/admin/kullrepresentanter',
        label: 'Kullrepresentanter',
        icon: GraduationCap,
        permission: 'members.manage',
      },
    ],
  },
  {
    label: 'Innhold',
    items: [
      {
        to: '/admin/gjennomgang',
        label: 'Gjennomgang',
        icon: ClipboardCheck,
        permission: 'profiles.edit',
      },
      { to: '/admin/profiler', label: 'Profiler', icon: IdCard, permission: 'profiles.edit' },
      {
        to: '/admin/arrangementer',
        label: 'Arrangementer',
        icon: CalendarDays,
        permission: 'profiles.edit',
      },
      { to: '/admin/selskaper', label: 'Selskaper', icon: Building2, permission: 'profiles.edit' },
      { to: '/admin/merker', label: 'Merker', icon: Award, permission: 'badges.manage' },
    ],
  },
  {
    label: 'Drift',
    items: [
      { to: '/admin/e-post', label: 'E-post', icon: Mail, permission: 'audit.read' },
      { to: '/admin/logg', label: 'Logg', icon: History, permission: 'audit.read' },
      { to: '/admin/mcp', label: 'MCP', icon: Bot, permission: 'mcp.access' },
    ],
  },
] as const

type Item = (typeof groups)[number]['items'][number]

function AdminLayout() {
  const { viewer } = Route.useRouteContext()
  const counts = Route.useLoaderData()
  const { pathname } = useLocation()
  const visible = groups
    .map((g) => ({
      label: g.label,
      items: (g.items as readonly Item[]).filter((i) => viewer.permissions.includes(i.permission)),
    }))
    .filter((g) => g.items.length > 0)
  // Siden man er på: den lengste adressen som passer, så /admin ikke vinner over undersidene.
  const current = visible
    .flatMap((g) => g.items)
    .filter((i) => pathname === i.to || pathname.startsWith(`${i.to}/`))
    .sort((a, b) => b.to.length - a.to.length)[0]
  const review = counts && counts.total > 0 ? (counts.total > 999 ? '999+' : counts.total) : null

  const menu = (
    <div className="space-y-5">
      {visible.map((g) => (
        <div key={g.label}>
          <p className="mb-1 px-2.5 text-xs font-medium tracking-wide text-stone-400 uppercase">
            {g.label}
          </p>
          <ul className="space-y-0.5">
            {g.items.map((item) => (
              <li key={item.to}>
                <Link
                  to={item.to}
                  // Forespørsler er forsiden av området; ellers ville den vært aktiv overalt.
                  activeOptions={{ exact: item.to === '/admin', includeSearch: false }}
                  className="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium text-stone-600 transition hover:bg-stone-100 hover:text-stone-900 data-[status=active]:bg-white data-[status=active]:text-stone-950 data-[status=active]:shadow-card data-[status=active]:ring-1 data-[status=active]:ring-stone-200/70"
                >
                  <item.icon className="size-4 shrink-0 text-stone-400" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.to === '/admin/gjennomgang' && review !== null && (
                    <span className="rounded-full bg-amber-100 px-1.5 py-px text-xs font-medium text-amber-800 tabular-nums">
                      <span className="sr-only">, </span>
                      {review}
                      <span className="sr-only"> til gjennomgang</span>
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )

  return (
    <div className="xl:grid xl:grid-cols-[13rem_minmax(0,1fr)] xl:gap-10">
      <nav aria-label="Admin" className="hidden xl:block">
        <div className="sticky top-24">
          <h1 className="mb-5 px-2.5 text-2xl font-semibold tracking-tight text-stone-950">
            Admin
          </h1>
          {menu}
        </div>
      </nav>

      <div className="min-w-0">
        <div className="xl:hidden">
          <PageHeader title="Admin" />
          {/* Lukkes når man har valgt en side: `key` lager den på nytt for hver adresse. */}
          <details key={pathname} className="group relative -mt-2 mb-6">
            <summary className="flex h-11 w-full cursor-pointer list-none items-center gap-2.5 rounded-xl bg-white px-3.5 text-sm font-medium text-stone-900 shadow-card ring-1 ring-stone-200/70 sm:w-80 [&::-webkit-details-marker]:hidden">
              {current && <current.icon className="size-4 shrink-0 text-stone-400" aria-hidden />}
              <span className="min-w-0 flex-1 truncate">
                <span className="sr-only">Adminmeny, du er på </span>
                {current?.label ?? 'Velg side'}
              </span>
              {review !== null && current?.to !== '/admin/gjennomgang' && (
                <span className="rounded-full bg-amber-100 px-1.5 py-px text-xs font-medium text-amber-800 tabular-nums">
                  {review}
                  <span className="sr-only"> til gjennomgang</span>
                </span>
              )}
              <ChevronDown
                className="size-4 shrink-0 text-stone-400 transition group-open:rotate-180"
                aria-hidden
              />
            </summary>
            <div className="absolute inset-x-0 top-full z-20 mt-2 rounded-2xl bg-stone-50 p-3 shadow-lg ring-1 ring-stone-200 sm:right-auto sm:w-80">
              <nav aria-label="Admin">{menu}</nav>
            </div>
          </details>
        </div>
        <Outlet />
      </div>
    </div>
  )
}
