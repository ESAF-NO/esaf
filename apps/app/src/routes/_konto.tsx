import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'

/**
 * Layout for sider som krever innlogging. Dette er bare en UX-vakt; selve
 * tilgangskontrollen skjer i serverfunksjonene som henter dataene.
 */
export const Route = createFileRoute('/_konto')({
  beforeLoad: ({ context }) => {
    if (context.viewer.level === 'anonymous') throw redirect({ to: '/logg-inn' })
  },
  component: Outlet,
})
