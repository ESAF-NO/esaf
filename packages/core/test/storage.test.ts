import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDiskStorage, createS3Storage, type ObjectStorage } from '../src/index.ts'

const bytes = (text: string) => new TextEncoder().encode(text)
const text = (data: Uint8Array | null) => (data ? new TextDecoder().decode(data) : null)

describe('lagring på disk', () => {
  let dir: string
  let storage: ObjectStorage

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'esaf-lagring-'))
    storage = createDiskStorage(dir)
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('lagrer, leser, overskriver og sletter', async () => {
    expect(await storage.get('profilbilder/a.webp')).toBeNull()
    await storage.put('profilbilder/a.webp', bytes('første'), 'image/webp')
    await storage.put('profilbilder/a.webp', bytes('andre'), 'image/webp')
    expect(text(await storage.get('profilbilder/a.webp'))).toBe('andre')
    // Ingen midlertidige filer blir liggende igjen.
    expect(await readdir(join(dir, 'profilbilder'))).toEqual(['a.webp'])
    await storage.delete('profilbilder/a.webp')
    await storage.delete('profilbilder/a.webp')
    expect(await storage.get('profilbilder/a.webp')).toBeNull()
  })

  it('godtar ikke nøkler som peker ut av mappen', async () => {
    for (const key of ['../a.webp', 'profilbilder/../../a', '/etc/passwd', 'a//b', '', '.skjult']) {
      await expect(storage.put(key, bytes('x'), 'image/webp')).rejects.toThrow('Ugyldig')
      await expect(storage.get(key)).rejects.toThrow('Ugyldig')
    }
  })
})

type Received = { method: string; path: string; headers: IncomingMessage['headers']; body: Buffer }

describe('S3-kompatibel lagring', () => {
  let server: Server
  let endpoint: string
  const objects = new Map<string, Buffer>()
  const received: Received[] = []
  // Svaret serveren skal gi på neste forespørsler, for å teste feil.
  let failWith: { status: number; code: string } | null = null

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = Buffer.concat(chunks)
      const path = decodeURIComponent(new URL(req.url!, 'http://x').pathname)
      received.push({ method: req.method!, path, headers: req.headers, body })
      if (failWith) {
        res.writeHead(failWith.status, { 'content-type': 'application/xml' })
        res.end(`<?xml version="1.0"?><Error><Code>${failWith.code}</Code></Error>`)
        return
      }
      if (req.method === 'PUT') {
        objects.set(path, body)
        res.writeHead(200).end()
      } else if (req.method === 'GET') {
        const object = objects.get(path)
        if (!object) res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>')
        else res.writeHead(200, { 'content-type': 'image/webp' }).end(object)
      } else if (req.method === 'DELETE') {
        objects.delete(path)
        res.writeHead(204).end()
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  })
  afterAll(() => new Promise((resolve) => server.close(resolve)))
  beforeEach(() => {
    objects.clear()
    received.length = 0
    failWith = null
  })

  const storage = () =>
    createS3Storage({
      endpoint,
      bucket: 'esaf-bilder',
      region: 'auto',
      accessKeyId: 'NOKKEL',
      secretAccessKey: 'super-hemmelig',
    })

  it('signerer kall og bruker sti-adresser', async () => {
    const s3 = storage()
    const body = bytes('bildedata')
    await s3.put('profilbilder/abc-192.webp', body, 'image/webp')
    const [put] = received
    expect(put).toMatchObject({ method: 'PUT', path: '/esaf-bilder/profilbilder/abc-192.webp' })
    expect(put!.body.toString()).toBe('bildedata')
    expect(put!.headers['content-type']).toBe('image/webp')
    expect(put!.headers['x-amz-content-sha256']).toBe(
      createHash('sha256').update(body).digest('hex'),
    )
    expect(put!.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=NOKKEL\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=.*x-amz-content-sha256.*, Signature=[0-9a-f]{64}$/,
    )

    expect(text(await s3.get('profilbilder/abc-192.webp'))).toBe('bildedata')
    expect(await s3.get('profilbilder/finnes-ikke.webp')).toBeNull()
    await s3.delete('profilbilder/abc-192.webp')
    expect(objects.size).toBe(0)
  })

  it('prøver igjen ved serverfeil og sier hva som feilet, uten hemmeligheter', async () => {
    const s3 = storage()
    failWith = { status: 503, code: 'SlowDown' }
    const error = await s3.put('profilbilder/a.webp', bytes('x'), 'image/webp').catch((e) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('Lagringen svarte 503 (SlowDown) på PUT profilbilder/a.webp.')
    expect(received).toHaveLength(3)

    // Avvist tilgang er ikke forbigående; da prøves det ikke igjen.
    received.length = 0
    failWith = { status: 403, code: 'AccessDenied' }
    await expect(s3.get('profilbilder/a.webp')).rejects.toThrow('403 (AccessDenied)')
    await expect(s3.delete('profilbilder/a.webp')).rejects.toThrow('403 (AccessDenied)')
    expect(received).toHaveLength(2)
    expect(String(error.message)).not.toContain('super-hemmelig')
  })
})
