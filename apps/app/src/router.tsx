import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
    // Private data skal alltid hentes på nytt fra serveren, ikke fra en gammel cache.
    defaultPreloadStaleTime: 0,
    defaultNotFoundComponent: () => (
      <main>
        <h1>Fant ikke siden</h1>
        <p>
          <a href="/">Til forsiden</a>
        </p>
      </main>
    ),
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
