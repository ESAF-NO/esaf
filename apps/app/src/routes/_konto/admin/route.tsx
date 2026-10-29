import { createFileRoute, Link, notFound, Outlet, redirect } from '@tanstack/react-router'
import { PageHeader } from '#/components/ui.tsx'

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
  component: AdminLayout,
})

const tabs = [
  { to: '/admin', label: 'Forespørsler', permission: 'members.review' },
  { to: '/admin/medlemmer', label: 'Medlemmer', permission: 'members.manage' },
  { to: '/admin/logg', label: 'Logg', permission: 'audit.read' },
] as const

function AdminLayout() {
  const { viewer } = Route.useRouteContext()
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Admin" />
      <nav aria-label="Admin" className="-mt-2 mb-6 border-b border-stone-200">
        <ul className="-mb-px flex gap-6">
          {tabs
            .filter((tab) => viewer.permissions.includes(tab.permission))
            .map((tab) => (
              <li key={tab.to}>
                <Link
                  to={tab.to}
                  // Forespørsler er forsiden av området; ellers ville den vært aktiv overalt.
                  activeOptions={{ exact: true, includeSearch: false }}
                  className="inline-flex h-10 items-center border-b-2 border-transparent text-sm font-medium text-stone-500 transition hover:text-stone-900 data-[status=active]:border-brand-600 data-[status=active]:text-stone-950"
                >
                  {tab.label}
                </Link>
              </li>
            ))}
        </ul>
      </nav>
      <Outlet />
    </div>
  )
}
