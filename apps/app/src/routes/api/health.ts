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
          return Response.json({ status: 'ok', database: 'ok' }, { headers })
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
