import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import http, { type IncomingMessage } from 'node:http'
import https from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { DomainError, PHOTO_MAX_BYTES } from '@esaf/core'

/**
 * Henter bilder (profilbilder og logoer) fra en adresse på nettet for MCP-
 * verktøyene. Serveren henter, så adressen kan ikke få lov til å peke innover
 * (SSRF): mot localhost, det interne nettet i Coolify, metadata-tjenester i
 * skyen eller andre private adresser. Reglene:
 *
 * - Bare http og https på standardportene, uten brukernavn eller passord.
 * - Alle adressene vertsnavnet slår opp til, må være offentlige. Tilkoblingen
 *   bruker adressen som ble sjekket (egen `lookup`), så svaret kan ikke byttes
 *   mellom sjekken og tilkoblingen (DNS rebinding). IP-adresser i lenken sjekkes
 *   direkte.
 * - Høyst tre videresendinger, og hver ny adresse sjekkes på nytt.
 * - Høyst 10 MB (som en opplasting) og 20 sekunder. Om fila faktisk er et bilde,
 *   avgjør @esaf/core ut fra innholdet, som ved opplasting.
 */

export type ImageFetcher = (url: string) => Promise<Uint8Array>

const MAX_REDIRECTS = 3
const TIMEOUT_MS = 20_000

const blocked = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4')
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6')
}

/** IPv4 inne i en IPv6-adresse (`::ffff:10.0.0.1`), som sjekkes som IPv4. */
function embeddedIpv4(address: string): string | null {
  const match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (match) return match[1]!
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address)
  if (!hex) return null
  const high = parseInt(hex[1]!, 16)
  const low = parseInt(hex[2]!, 16)
  return [high >> 8, high & 255, low >> 8, low & 255].join('.')
}

/** Om adressen er offentlig, og dermed trygg å koble til. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 0) return false
  if (family === 6) {
    const v4 = embeddedIpv4(address)
    if (v4) return isPublicAddress(v4)
    // Andre IPv4-tilordnede former (`::ffff:0:0/96`) sperres helt.
    if (/^::ffff:/i.test(address)) return false
    return !blocked.check(address, 'ipv6')
  }
  return !blocked.check(address, 'ipv4')
}

class ImageFetchError extends DomainError {}

/** Slår opp vertsnavnet og avviser det hvis en av adressene ikke er offentlig. */
const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) return callback(error, '', 0)
    const list = Array.isArray(addresses) ? addresses : []
    if (!list.length || list.some((a) => !isPublicAddress(a.address))) {
      return callback(
        new ImageFetchError(`${hostname} peker til en adresse som ikke er offentlig.`),
        '',
        0,
      )
    }
    if (options.all) return callback(null, list)
    callback(null, list[0]!.address, list[0]!.family)
  })
}

function checkUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ImageFetchError('Ugyldig bildeadresse.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ImageFetchError('Bildeadressen må være http eller https.')
  }
  if (url.username || url.password) {
    throw new ImageFetchError('Bildeadressen kan ikke ha brukernavn eller passord.')
  }
  if (url.port && url.port !== '80' && url.port !== '443') {
    throw new ImageFetchError('Bildeadressen må bruke standardporten.')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) && !isPublicAddress(host)) {
    throw new ImageFetchError('Bildeadressen peker til en adresse som ikke er offentlig.')
  }
  if (!isIP(host) && (!host.includes('.') || /\.(local|internal|localhost)$/i.test(host))) {
    throw new ImageFetchError('Bildeadressen må være et offentlig vertsnavn.')
  }
  return url
}

function request(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  const client = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = client.get(
      url,
      {
        lookup: safeLookup,
        signal,
        headers: {
          accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8',
          'user-agent': 'ESAF-admin/1.0 (+https://esaf.no)',
        },
      },
      resolve,
    )
    req.on('error', reject)
  })
}

async function readBody(response: IncomingMessage): Promise<Uint8Array> {
  const tooLarge = () => new ImageFetchError('Bildet er for stort. Maks 10 MB.')
  if (Number(response.headers['content-length']) > PHOTO_MAX_BYTES) {
    response.destroy()
    throw tooLarge()
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of response as AsyncIterable<Buffer>) {
    size += chunk.byteLength
    if (size > PHOTO_MAX_BYTES) {
      response.destroy()
      throw tooLarge()
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

/** Henter et bilde fra en offentlig adresse, med reglene over. */
export const fetchPublicImage: ImageFetcher = async (raw) => {
  const signal = AbortSignal.timeout(TIMEOUT_MS)
  let url = checkUrl(raw)
  try {
    for (let redirects = 0; ; redirects++) {
      const response = await request(url, signal)
      const status = response.statusCode ?? 0
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume()
        if (redirects >= MAX_REDIRECTS) throw new ImageFetchError('For mange videresendinger.')
        url = checkUrl(new URL(response.headers.location, url).href)
        continue
      }
      if (status !== 200) {
        response.resume()
        throw new ImageFetchError(`Fikk svar ${status} fra ${url.hostname}.`)
      }
      return await readBody(response)
    }
  } catch (error) {
    if (error instanceof DomainError) throw error
    if (signal.aborted) throw new ImageFetchError('Det tok for lang tid å hente bildet.')
    throw new ImageFetchError(
      `Kunne ikke hente bildet fra ${url.hostname}: ${error instanceof Error ? error.message : 'ukjent feil'}.`,
    )
  }
}

/** Et bilde sendt som base64 (eller en `data:`-adresse), med samme grense som en opplasting. */
export function decodeBase64Image(data: string): Uint8Array {
  const payload = data.replace(/^data:[^;,]*;base64,/i, '').replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(payload) || !payload.length) {
    throw new ImageFetchError('Bildet er ikke gyldig base64.')
  }
  if ((payload.length * 3) / 4 > PHOTO_MAX_BYTES + 3) {
    throw new ImageFetchError('Bildet er for stort. Maks 10 MB.')
  }
  return Buffer.from(
    payload,
    payload.includes('-') || payload.includes('_') ? 'base64url' : 'base64',
  )
}
