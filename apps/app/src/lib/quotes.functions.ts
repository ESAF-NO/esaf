import {
  deleteQuote,
  getEditableQuote,
  randomQuote,
  sourceConfidences,
  updateQuote,
} from '@esaf/core'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withViewer as run } from '#/server/access.server.ts'
import { db } from '#/server/db.server.ts'

/** Et tilfeldig sitat med sikker taler, til forsiden. `null` når det ikke finnes noen. */
export const fetchRandomQuote = createServerFn({ method: 'GET' }).handler(() =>
  run((viewer) => randomQuote(db, viewer)),
)

/** Bare admins får sitatet her. Andre får 404. */
export const fetchEditableQuote = createServerFn({ method: 'GET' })
  .validator(z.object({ quoteId: z.uuid() }))
  .handler(({ data }) => run((viewer) => getEditableQuote(db, viewer, data.quoteId)))

// Full validering skjer i @esaf/core (quoteInput). Her sjekkes bare formen.
const quoteFields = z.object({
  text: z.string().max(5000),
  speakerName: z.string().max(500),
  speakerRole: z.string().max(500),
  date: z.string().max(20),
  sourceUrl: z.string().max(1000),
  sourceLabel: z.string().max(200),
  confidence: z.enum(sourceConfidences),
})

export type QuoteFormValues = z.infer<typeof quoteFields>

export const saveQuote = createServerFn({ method: 'POST' })
  .validator(z.object({ quoteId: z.uuid(), values: quoteFields }))
  .handler(({ data }) => run((viewer) => updateQuote(db, viewer, data.quoteId, data.values)))

export const removeQuote = createServerFn({ method: 'POST' })
  .validator(z.object({ quoteId: z.uuid() }))
  .handler(({ data }) => run((viewer) => deleteQuote(db, viewer, data.quoteId)))
