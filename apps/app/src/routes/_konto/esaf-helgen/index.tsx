import { createFileRoute, redirect } from '@tanstack/react-router'

/** Den gamle adressen til ESAF-helgen. Helgene er nå arrangementer av typen ESAF-helgen. */
export const Route = createFileRoute('/_konto/esaf-helgen/')({
  beforeLoad: () => {
    throw redirect({
      to: '/arrangementer/$typeSlug',
      params: { typeSlug: 'esaf-helgen' },
      statusCode: 301,
    })
  },
})
