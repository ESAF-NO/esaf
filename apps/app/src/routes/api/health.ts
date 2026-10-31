import { pingDatabase } from '@esaf/db'
import { createFileRoute } from '@tanstack/react-router'
import { db } from '#/server/db.server.ts'

export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: async () => {
        const headers = { 'cache-control': 'no-store' }
        try {
          await pingDatabase(db)
          // Committen bildet ble bygget fra (`APP_VERSION`), så deployen kan se at den nye versjonen svarer.
          const version = process.env.APP_VERSION ?? null
          return Response.json({ status: 'ok', database: 'ok', version }, { headers })
        } catch {
          return Response.json(
            { status: 'degraded', database: 'unreachable' },
            { status: 503, headers },
          )
        }
      },
    },
  },
})
