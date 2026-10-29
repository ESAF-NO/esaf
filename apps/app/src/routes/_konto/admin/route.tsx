import { createFileRoute, Link, notFound, Outlet, redirect } from '@tanstack/react-router'
import { PageHeader } from '#/components/ui.tsx'
import { fetchReviewCounts } from '#/lib/review.functions.ts'

/**
 * Adminområdet: fanene og vakten for alle adminsider. Hver fane vises bare for
 * dem som har rettigheten den krever, og hver underside sjekker den på nytt.
 * Serverfunksjonene håndhever rettighetene uansett; vaktene her er for
 * brukervennligheten.
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

const tabs = [
  { to: '/admin', label: 'Forespørsler', permission: 'members.review' },
  { to: '/admin/gjennomgang', label: 'Gjennomgang', permission: 'profiles.edit' },
  { to: '/admin/medlemmer', label: 'Medlemmer', permission: 'members.manage' },
  { to: '/admin/kullrepresentanter', label: 'Kullrepresentanter', permission: 'members.manage' },
  { to: '/admin/profiler', label: 'Profiler', permission: 'profiles.edit' },
  { to: '/admin/selskaper', label: 'Selskaper', permission: 'profiles.edit' },
  { to: '/admin/logg', label: 'Logg', permission: 'audit.read' },
] as const

function AdminLayout() {
  const { viewer } = Route.useRouteContext()
  const counts = Route.useLoaderData()
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Admin" />
      <nav aria-label="Admin" className="-mt-2 mb-6 border-b border-stone-200">
        <ul className="-mb-px flex gap-6 overflow-x-auto">
          {tabs
            .filter((tab) => viewer.permissions.includes(tab.permission))
            .map((tab) => (
              <li key={tab.to}>
                <Link
                  to={tab.to}
                  // Forespørsler er forsiden av området; ellers ville den vært aktiv overalt.
                  activeOptions={{ exact: tab.to === '/admin', includeSearch: false }}
                  className="inline-flex h-10 items-center gap-1.5 border-b-2 border-transparent text-sm font-medium whitespace-nowrap text-stone-500 transition hover:text-stone-900 data-[status=active]:border-brand-600 data-[status=active]:text-stone-950"
                >
                  {tab.label}
                  {tab.to === '/admin/gjennomgang' && counts && counts.total > 0 && (
                    <span className="rounded-full bg-amber-100 px-1.5 py-px text-xs font-medium text-amber-800 tabular-nums">
                      <span className="sr-only">, </span>
                      {counts.total > 999 ? '999+' : counts.total}
                      <span className="sr-only"> til gjennomgang</span>
                    </span>
                  )}
                </Link>
              </li>
            ))}
        </ul>
      </nav>
      <Outlet />
    </div>
  )
}
