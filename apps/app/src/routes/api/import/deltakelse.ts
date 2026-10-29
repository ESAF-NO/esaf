import {
  applyParticipationImport,
  assertCan,
  participationLayouts,
  previewParticipationImport,
  roleChoices,
  type ParticipationDecisions,
} from '@esaf/core'
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { db } from '#/server/db.server.ts'
import {
  ImportRequestError,
  importErrorResponse,
  jsonField,
  jsonResponse,
  readImportForm,
} from '#/server/import.server.ts'
import { getRequestViewer } from '#/server/viewer.server.ts'

const options = z.object({
  layout: z.enum(participationLayouts).optional(),
  sheet: z.string().max(200).optional(),
  roleMap: z.record(z.string().max(200), z.enum(roleChoices)).optional(),
  eventColumns: z.array(z.number().int().min(0).max(400)).max(400).optional(),
  typeId: z.uuid().nullable().optional(),
})

const step = z.enum(['forhandsvis', 'prov', 'lagre'])

/**
 * Import av deltakelse fra et regneark (POST, multipart). `steg` er
 * `forhandsvis` (les og match), `prov` (vis nøyaktig hva som blir lagret) eller
 * `lagre`. Fila sendes hver gang og lagres aldri. Reglene ligger i @esaf/core
 * (event-import.ts).
 */
export const Route = createFileRoute('/api/import/deltakelse')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const viewer = await getRequestViewer()
          // Før fila leses, så ingen sender 5 MB for å få nei.
          assertCan(viewer, 'profiles.edit')
          const form = await readImportForm(request)
          const steg = step.safeParse(form.fields.steg)
          const valg = options.safeParse(jsonField(form.fields, 'valg', {}))
          if (!steg.success || !valg.success) {
            throw new ImportRequestError(400, 'Ugyldige valg i skjemaet.')
          }
          const input = { data: form.data, fileName: form.fileName, options: valg.data }
          if (steg.data === 'forhandsvis') {
            return jsonResponse(await previewParticipationImport(db, viewer, input))
          }
          const decisions = jsonField(form.fields, 'beslutninger', { people: {}, events: {} })
          return jsonResponse(
            await applyParticipationImport(db, viewer, {
              ...input,
              // Valideres i @esaf/core.
              decisions: decisions as ParticipationDecisions,
              dryRun: steg.data === 'prov',
            }),
          )
        } catch (error) {
          return importErrorResponse(error)
        }
      },
    },
  },
})
