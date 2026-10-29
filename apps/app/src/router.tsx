import { createRouter } from '@tanstack/react-router'
import { ErrorPage, NotFoundPage } from './components/ErrorPage.tsx'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
    // Private data skal alltid hentes på nytt fra serveren, ikke fra en gammel cache.
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: ErrorPage,
    defaultNotFoundComponent: NotFoundPage,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
