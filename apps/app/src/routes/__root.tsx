import type { ReactNode } from 'react'
import {
  createRootRoute,
  HeadContent,
  Link,
  Scripts,
  useRouteContext,
  useRouter,
} from '@tanstack/react-router'
import { authClient } from '#/lib/auth-client.ts'
import { getViewerSummary } from '#/lib/members.functions.ts'
import appCss from '../styles.css?url'

export const Route = createRootRoute({
  // Kjøres på serveren ved første last og som serverkall ved hver klientnavigasjon.
  beforeLoad: async () => ({ viewer: await getViewerSummary() }),
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { name: 'robots', content: 'noindex' },
      { title: 'ESAF-appen' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
    ],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="nb">
      <head>
        <HeadContent />
      </head>
      <body>
        <a className="skip-link" href="#innhold">
          Hopp til innhold
        </a>
        <Header />
        <div id="innhold">{children}</div>
        <Scripts />
      </body>
    </html>
  )
}

function Header() {
  const { viewer } = useRouteContext({ from: '__root__' })
  const router = useRouter()

  async function signOut() {
    await authClient.signOut()
    await router.invalidate()
    await router.navigate({ to: '/' })
  }

  return (
    <header className="site-header">
      <Link to="/" className="brand">
        ESAF
      </Link>
      <nav aria-label="Hovedmeny">
        {viewer.level === 'anonymous' ? (
          <>
            <Link to="/logg-inn">Logg inn</Link>
            <Link to="/registrer">Registrer deg</Link>
          </>
        ) : (
          <>
            {viewer.level === 'pending' && <Link to="/venter">Status</Link>}
            {(viewer.level === 'member' || viewer.level === 'admin') && (
              <Link to="/medlemmer">Medlemmer</Link>
            )}
            {viewer.level === 'admin' && <Link to="/admin">Admin</Link>}
            <button type="button" className="link-button" onClick={signOut}>
              Logg ut
            </button>
          </>
        )}
      </nav>
    </header>
  )
}
