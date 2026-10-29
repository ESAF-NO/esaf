import {
  applyRepresentativeImport,
  assertCan,
  previewRepresentativeImport,
  type RepresentativeDecisions,
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

const step = z.enum(['forhandsvis', 'prov', 'lagre'])

/**
 * Import av kullrepresentanter fra et regneark (POST, multipart), med de samme
 * stegene som importen av deltakelse. Reglene ligger i @esaf/core (rep-import.ts).
 */
export const Route = createFileRoute('/api/import/kullrepresentanter')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const viewer = await getRequestViewer()
          // Før fila leses, så ingen sender 5 MB for å få nei.
          assertCan(viewer, 'members.manage')
          const form = await readImportForm(request)
          const steg = step.safeParse(form.fields.steg)
          if (!steg.success) throw new ImportRequestError(400, 'Ugyldige valg i skjemaet.')
          const input = { data: form.data, fileName: form.fileName }
          if (steg.data === 'forhandsvis') {
            return jsonResponse(await previewRepresentativeImport(db, viewer, input))
          }
          const decisions = jsonField(form.fields, 'beslutninger', { people: {} })
          return jsonResponse(
            await applyRepresentativeImport(db, viewer, {
              ...input,
              // Valideres i @esaf/core.
              decisions: decisions as RepresentativeDecisions,
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
