import { createFileRoute, notFound, redirect } from '@tanstack/react-router'
import { fetchEventTypeOf } from '#/lib/events.functions.ts'

/**
 * Den gamle adressen til én helg. Helgene beholdt id-en sin da de ble
 * arrangementer, så lenken sendes til samme arrangement.
 */
export const Route = createFileRoute('/_konto/esaf-helgen/$weekendId')({
  beforeLoad: async ({ params }) => {
    const found = await fetchEventTypeOf({ data: { eventId: params.weekendId } })
    if (!found) throw notFound()
    throw redirect({
      to: '/arrangementer/$typeSlug/$eventId',
      params: { typeSlug: found.typeSlug, eventId: params.weekendId },
      statusCode: 301,
    })
  },
})
