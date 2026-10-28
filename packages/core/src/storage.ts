import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { AwsClient } from 'aws4fetch'

/**
 * Lagring av filer (foreløpig bare profilbilder) bak et lite grensesnitt, så
 * domenet ikke bryr seg om hvor de ligger. Disk brukes i utvikling og
 * S3-kompatibel lagring (Cloudflare R2) i produksjon. Hvilken som brukes, avgjør
 * appen ut fra miljøet (se `env.server.ts`).
 */
export interface ObjectStorage {
  /** Lagrer et objekt, og overskriver det som eventuelt lå på samme nøkkel. */
  put(key: string, body: Uint8Array, contentType: string): Promise<void>
  /** Innholdet, eller `null` hvis objektet ikke finnes. */
  get(key: string): Promise<Uint8Array | null>
  /** Sletter objektet. Det er ingen feil om det allerede er borte. */
  delete(key: string): Promise<void>
}

// Nøklene lages av domenet selv, men sjekkes likevel, så en feil aldri kan peke
// utenfor lagringsmappen (`..`) eller bli tolket som noe annet i en URL.
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/

function assertKey(key: string) {
  if (key.length > 512 || !key.split('/').every((s) => SEGMENT.test(s))) {
    throw new Error(`Ugyldig lagringsnøkkel: ${JSON.stringify(key)}`)
  }
}

/** Filer på disk, for utvikling. Mappen opprettes ved behov. */
export function createDiskStorage(dir: string): ObjectStorage {
  const root = resolve(dir)
  const pathOf = (key: string) => {
    assertKey(key)
    return join(root, ...key.split('/'))
  }
  return {
    async put(key, body) {
      const path = pathOf(key)
      await mkdir(dirname(path), { recursive: true })
      // Skrives ferdig under et midlertidig navn først, så ingen leser en halv fil.
      const temp = `${path}.${randomUUID()}.tmp`
      await writeFile(temp, body)
      await rename(temp, path)
    },
    async get(key) {
      try {
        return await readFile(pathOf(key))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    async delete(key) {
      await rm(pathOf(key), { force: true })
    },
  }
}

export type S3StorageConfig = {
  /** For Cloudflare R2: `https://<konto-id>.r2.cloudflarestorage.com`. */
  endpoint: string
  bucket: string
  /** `auto` for R2. */
  region: string
  accessKeyId: string
  secretAccessKey: string
}

/** Hvor lenge ett kall til lagringen får ta, med nye forsøk, før det gis opp. */
const S3_TIMEOUT_MS = 15_000

/**
 * S3-kompatibel lagring (Cloudflare R2, AWS S3, MinIO) med signerte kall via
 * aws4fetch. Bruker sti-adresser (`<endpoint>/<bøtte>/<nøkkel>`), som R2 og
 * MinIO støtter. Bøtta skal ikke være offentlig: bildene serveres bare gjennom
 * appen, til innloggede medlemmer.
 */
export function createS3Storage(config: S3StorageConfig): ObjectStorage {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: config.region,
    // Nye forsøk ved 5xx og 429. Standarden (ti) kan holde en opplasting i et halvt minutt.
    retries: 2,
  })
  const base = `${config.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(config.bucket)}`

  async function send(method: 'GET' | 'PUT' | 'DELETE', key: string, init: RequestInit = {}) {
    assertKey(key)
    const url = `${base}/${key.split('/').map(encodeURIComponent).join('/')}`
    return client.fetch(url, { ...init, method, signal: AbortSignal.timeout(S3_TIMEOUT_MS) })
  }

  /** Feilen uten hemmeligheter: metode, nøkkel, status og S3-feilkoden hvis den finnes. */
  async function failure(method: string, key: string, response: Response) {
    const text = await response.text().catch(() => '')
    const code = /<Code>([^<]{1,100})<\/Code>/.exec(text)?.[1]
    return new Error(
      `Lagringen svarte ${response.status}${code ? ` (${code})` : ''} på ${method} ${key}.`,
    )
  }

  return {
    async put(key, body, contentType) {
      const response = await send('PUT', key, {
        body: body as Uint8Array<ArrayBuffer>,
        headers: {
          'content-type': contentType,
          // Signert innholdshash, så lagringen avviser alt som er endret underveis.
          'x-amz-content-sha256': createHash('sha256').update(body).digest('hex'),
        },
      })
      if (!response.ok) throw await failure('PUT', key, response)
      await response.body?.cancel()
    },
    async get(key) {
      const response = await send('GET', key)
      if (response.status === 404) {
        await response.body?.cancel()
        return null
      }
      if (!response.ok) throw await failure('GET', key, response)
      return new Uint8Array(await response.arrayBuffer())
    },
    async delete(key) {
      const response = await send('DELETE', key)
      if (!response.ok && response.status !== 404) throw await failure('DELETE', key, response)
      await response.body?.cancel()
    },
  }
}
