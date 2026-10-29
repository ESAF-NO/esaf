import { AccessDeniedError, DomainError, IMPORT_MAX_BYTES, NotFoundError } from '@esaf/core'
import { assertSameOrigin } from './photos.server.ts'

/** En feil med HTTP-status, for det som stoppes før domenet (størrelse, type, skjema). */
export class ImportRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** Plass til skjemafeltene (valg og beslutninger) ved siden av fila. */
const FORM_OVERHEAD = 1024 * 1024
const MAX_BODY = IMPORT_MAX_BYTES + FORM_OVERHEAD

export type ImportForm = {
  data: Uint8Array
  fileName: string
  /** De andre feltene i skjemaet, som tekst. */
  fields: Record<string, string>
}

/**
 * Leser et opplastet regneark med skjemafelt (multipart). Endringer må komme fra
 * appen selv, og forespørselen leses aldri lenger enn grensen: store filer
 * avvises på `content-length` før noe leses, og strømmen avbrytes hvis den er
 * større enn den sa. Fila lagres ikke; den finnes bare i minnet mens den leses.
 */
export async function readImportForm(request: Request): Promise<ImportForm> {
  try {
    assertSameOrigin(request)
  } catch (error) {
    throw new ImportRequestError(403, error instanceof Error ? error.message : 'Ikke tillatt.')
  }
  const type = request.headers.get('content-type') ?? ''
  if (!type.toLowerCase().startsWith('multipart/form-data')) {
    throw new ImportRequestError(415, 'Last opp regnearket som en fil.')
  }
  const tooLarge = () =>
    new ImportRequestError(413, `Fila er for stor. Maks ${IMPORT_MAX_BYTES / 1024 / 1024} MB.`)
  if (Number(request.headers.get('content-length')) > MAX_BODY) throw tooLarge()
  if (!request.body) throw new ImportRequestError(400, 'Fant ingen fil i forespørselen.')

  const chunks: Uint8Array[] = []
  let size = 0
  const reader = request.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY) {
      await reader.cancel()
      throw tooLarge()
    }
    chunks.push(value)
  }

  let form: FormData
  try {
    form = await new Response(Buffer.concat(chunks, size), {
      headers: { 'content-type': type },
    }).formData()
  } catch {
    throw new ImportRequestError(400, 'Kunne ikke lese skjemaet. Prøv igjen.')
  }
  const file = form.get('fil')
  if (!file || typeof file === 'string') {
    throw new ImportRequestError(400, 'Velg et regneark (.xlsx eller .csv).')
  }
  if (file.size > IMPORT_MAX_BYTES) throw tooLarge()
  const fields: Record<string, string> = {}
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') fields[key] = value
  }
  return {
    data: new Uint8Array(await file.arrayBuffer()),
    fileName: (file.name || 'regneark').slice(0, 200),
    fields,
  }
}

/** Leser et JSON-felt fra skjemaet. Tomt felt gir `fallback`. */
export function jsonField(fields: Record<string, string>, key: string, fallback: unknown) {
  const raw = fields[key]
  if (raw === undefined || raw === '') return fallback
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new ImportRequestError(400, 'Ugyldige valg i skjemaet.')
  }
}

const noStore = { 'cache-control': 'no-store' }

/** Domenefeil som JSON med en melding brukeren kan lese, uten å lekke detaljer. */
export function importErrorResponse(error: unknown): Response {
  const reply = (status: number, message: string) =>
    Response.json({ error: message }, { status, headers: noStore })
  if (error instanceof ImportRequestError) return reply(error.status, error.message)
  if (error instanceof AccessDeniedError) {
    if (error.reason === 'unauthenticated') return reply(401, 'Du må logge inn på nytt.')
    if (error.reason === 'strong_auth_required') {
      return reply(403, 'Logg inn med passkey eller slå på tofaktor for å importere.')
    }
    return reply(403, 'Du har ikke tilgang til dette.')
  }
  if (error instanceof NotFoundError) return reply(404, error.message)
  if (error instanceof DomainError) return reply(422, error.message)
  console.error('[esaf/app] Feil i import-API-et:', error)
  return reply(500, 'Noe gikk galt. Prøv igjen om litt.')
}

export const jsonResponse = (body: unknown) => Response.json(body, { headers: noStore })
