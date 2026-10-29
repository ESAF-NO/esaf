import type { ReactNode } from 'react'
import { createRootRoute, HeadContent, Scripts } from '@tanstack/react-router'
import { getViewerSummary } from '#/lib/members.functions.ts'
import appCss from '../styles.css?url'

export const Route = createRootRoute({
  // Kjøres på serveren ved første last og som serverkall ved hver klientnavigasjon.
  beforeLoad: async () => ({ viewer: await getViewerSummary() }),
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
      { name: 'robots', content: 'noindex' },
      { name: 'theme-color', content: '#fafaf9' },
      { title: 'ESAF' },
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
        {children}
        <Scripts />
      </body>
    </html>
  )
}
