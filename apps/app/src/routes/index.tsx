import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * Appen har ingen egen forside; den offentlige siden er esaf.no (`apps/site`).
 * Rotadressen sender folk dit de hører hjemme.
 */
export const Route = createFileRoute('/')({
  beforeLoad: ({ context: { viewer } }) => {
    if (viewer.level === 'anonymous') throw redirect({ to: '/logg-inn' })
    if (viewer.level === 'pending') {
      throw redirect({ to: viewer.requestStatus === null ? '/velkommen' : '/venter' })
    }
    throw redirect({ to: '/feed' })
  },
})
