import {
  AccessDeniedError,
  createDiskStorage,
  createS3Storage,
  DomainError,
  NotFoundError,
  PHOTO_MAX_BYTES,
  type ObjectStorage,
} from '@esaf/core'
import { env, storageConfig } from './env.server.ts'

const globalForStorage = globalThis as unknown as { esafStorage?: ObjectStorage }

// Gjenbrukes ved hot reload i utvikling, som databasetilkoblingen.
export const storage = (globalForStorage.esafStorage ??=
  storageConfig.driver === 's3'
    ? createS3Storage(storageConfig)
    : createDiskStorage(storageConfig.dir))

/** En feil med HTTP-status, for det som stoppes før domenet (størrelse, type, opprinnelse). */
class UploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const appOrigin = new URL(env.BETTER_AUTH_URL).origin

/**
 * Endringer må komme fra appen selv. Innloggingscookien er `SameSite=Lax`, og
 * bildetypen i `content-type` krever CORS-klarering, så dette er et ekstra lag
 * mot forespørsler fra andre nettsteder (CSRF).
 */
export function assertSameOrigin(request: Request) {
  const origin = request.headers.get('origin')
  const site = request.headers.get('sec-fetch-site')
  if ((origin !== null && origin !== appOrigin) || (site !== null && site !== 'same-origin')) {
    throw new UploadError(403, 'Forespørselen kom ikke fra ESAF-appen.')
  }
}

/**
 * Leser bildet fra forespørselen, men aldri mer enn grensen: store filer avvises
 * på `content-length` før noe leses, og strømmen avbrytes hvis den er større enn
 * den sa. Om fila faktisk er et bilde, avgjør @esaf/core ut fra innholdet.
 */
export async function readUpload(request: Request): Promise<Uint8Array> {
  const type = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
  if (!type.startsWith('image/') && type !== 'application/octet-stream') {
    throw new UploadError(415, 'Last opp bildet som en fil (JPEG, PNG eller WebP).')
  }
  const tooLarge = () => new UploadError(413, 'Bildet er for stort. Maks 10 MB.')
  if (Number(request.headers.get('content-length')) > PHOTO_MAX_BYTES) throw tooLarge()
  if (!request.body) throw new UploadError(400, 'Fant ikke noe bilde i forespørselen.')

  const chunks: Uint8Array[] = []
  let size = 0
  const reader = request.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > PHOTO_MAX_BYTES) {
      await reader.cancel()
      throw tooLarge()
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks, size)
}

const noStore = { 'cache-control': 'no-store' }

/** Domenefeil som JSON med en melding brukeren kan lese, uten å lekke detaljer. */
export function photoErrorResponse(error: unknown): Response {
  const reply = (status: number, message: string) =>
    Response.json({ error: message }, { status, headers: noStore })
  if (error instanceof UploadError) return reply(error.status, error.message)
  if (error instanceof AccessDeniedError) {
    return reply(error.reason === 'unauthenticated' ? 401 : 403, error.message)
  }
  if (error instanceof NotFoundError) return reply(404, error.message)
  if (error instanceof DomainError) return reply(422, error.message)
  console.error('[esaf/app] Feil i bilde-API-et:', error)
  return reply(500, 'Noe gikk galt. Prøv igjen om litt.')
}
