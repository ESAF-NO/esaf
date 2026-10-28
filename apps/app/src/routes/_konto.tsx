import { createFileRoute, Outlet, redirect, useLocation, useRouter } from '@tanstack/react-router'
import { AppShell } from '#/components/AppShell.tsx'
import { AuthShell } from '#/components/AuthLayout.tsx'
import { authClient } from '#/lib/auth-client.ts'

/**
 * Layout og rutevakter for alt bak innlogging. Vaktene er bare for
 * brukervennligheten: de sender folk til riktig steg på veien inn. Selve
 * tilgangskontrollen skjer i serverfunksjonene som henter dataene.
 *
 * - Ikke godkjent ennå: «Hvem er du?» (/velkommen), så venting (/venter).
 * - Nylig godkjent: velkomststegene (/kom-i-gang) før resten av appen.
 */
export const Route = createFileRoute('/_konto')({
  beforeLoad: ({ context: { viewer }, location }) => {
    const path = location.pathname
    if (viewer.level === 'anonymous') throw redirect({ to: '/logg-inn' })
    if (viewer.level === 'pending') {
      const step = viewer.requestStatus === null ? '/velkommen' : '/venter'
      // En åpen forespørsel kan endres.
      const editing = path === '/velkommen' && viewer.requestStatus === 'open'
      if (path !== step && !editing) throw redirect({ to: step })
      return
    }
    if (path === '/velkommen' || path === '/venter') throw redirect({ to: '/feed' })
    if (!viewer.onboarded && path !== '/kom-i-gang') {
      throw redirect({ to: '/kom-i-gang', search: { til: location.href } })
    }
  },
  component: AccountLayout,
})

function AccountLayout() {
  const { viewer } = Route.useRouteContext()
  const router = useRouter()
  const { pathname } = useLocation()

  if (viewer.level === 'member' && pathname !== '/kom-i-gang') {
    return (
      <AppShell>
        <Outlet />
      </AppShell>
    )
  }

  async function signOut() {
    await authClient.signOut()
    await router.invalidate()
    await router.navigate({ to: '/' })
  }

  return (
    <AuthShell
      wide
      action={
        <button
          type="button"
          onClick={signOut}
          className="text-sm font-medium text-stone-500 hover:text-stone-900"
        >
          Logg ut
        </button>
      }
    >
      <Outlet />
    </AuthShell>
  )
}
