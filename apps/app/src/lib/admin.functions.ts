import {
  changeRole,
  listAccounts,
  listAuditEvents,
  removePasskeys,
  roles,
  setMemberAccess,
} from '@esaf/core'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withViewer as run } from '#/server/access.server.ts'
import { db } from '#/server/db.server.ts'

// Rettighetene sjekkes i @esaf/core for hvert kall. Her sjekkes bare formen.

export const fetchAccounts = createServerFn({ method: 'GET' }).handler(() =>
  run((viewer) => listAccounts(db, viewer)),
)

export const updateRole = createServerFn({ method: 'POST' })
  .validator(
    z.object({ personId: z.uuid(), role: z.enum(roles), reason: z.string().max(500).optional() }),
  )
  .handler(({ data }) => run((viewer) => changeRole(db, viewer, data)))

export const updateAccess = createServerFn({ method: 'POST' })
  .validator(z.object({ personId: z.uuid(), active: z.boolean(), reason: z.string().max(500) }))
  .handler(({ data }) => run((viewer) => setMemberAccess(db, viewer, data)))

export const resetPasskeys = createServerFn({ method: 'POST' })
  .validator(z.object({ personId: z.uuid(), reason: z.string().max(500) }))
  .handler(({ data }) => run((viewer) => removePasskeys(db, viewer, data)))

/** Hendelser per side i loggen. Kortere side enn dette betyr at det ikke finnes flere. */
export const auditPageSize = 50

export const fetchAuditLog = createServerFn({ method: 'GET' })
  .validator(z.object({ beforeId: z.uuid().optional() }))
  .handler(({ data }) =>
    run(async (viewer) => {
      const entries = await listAuditEvents(db, viewer, {
        beforeId: data.beforeId,
        limit: auditPageSize,
      })
      // Detaljene er JSON fra databasen; gi dem en type klienten kan serialisere.
      return entries.map((e) => ({
        ...e,
        details: e.details as Record<string, string | number | boolean | null>,
      }))
    }),
  )
