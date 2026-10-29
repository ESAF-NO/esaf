import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { sql } from '@esaf/db'
import type { createAuth } from '../src/server/auth-config.server.ts'

/**
 * Felles for integrasjonstestene mot Better Auth: en programvare-autentikator i
 * stedet for nettleserens passkeys, og en «nettleser» som holder på cookiene.
 */

type Auth = ReturnType<typeof createAuth>

export const origin = 'http://localhost:3000'
export const password = 'korrekt-hest-batteri'
export const b64url = (data: Uint8Array) => Buffer.from(data).toString('base64url')
export const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest()
/** `column = value`, uten å dra inn drizzle-orm som egen avhengighet i appen. */
export const eq = (column: unknown, value: string) => sql`${column} = ${value}`

/** Flagg i autentikatordataene: brukeren til stede (UP), bekreftet (UV), med nøkkel (AT). */
export const UP = 0x01
export const UV = 0x04
const AT = 0x40

/** En passkey slik en telefon eller passordhåndterer ville hatt den. */
export class SoftwareAuthenticator {
  readonly credentialId = b64url(randomBytes(16))
  private readonly privateKey: KeyObject
  private readonly cose: Buffer

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    this.privateKey = privateKey
    const jwk = publicKey.export({ format: 'jwk' })
    // COSE_Key for ES256 i CBOR: {1: 2, 3: -7, -1: 1, -2: x, -3: y}.
    this.cose = Buffer.concat([
      Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
      Buffer.from(jwk.x!, 'base64url'),
      Buffer.from([0x22, 0x58, 0x20]),
      Buffer.from(jwk.y!, 'base64url'),
    ])
  }

  private authData(flags: number, attested = false) {
    const parts: Buffer[] = [sha256('localhost'), Buffer.from([flags]), Buffer.alloc(4)]
    if (attested) {
      const id = Buffer.from(this.credentialId, 'base64url')
      const length = Buffer.alloc(2)
      length.writeUInt16BE(id.length)
      parts.push(Buffer.alloc(16), length, id, this.cose)
    }
    return Buffer.concat(parts)
  }

  private clientData(type: string, challenge: string, from = origin) {
    return Buffer.from(JSON.stringify({ type, challenge, origin: from, crossOrigin: false }))
  }

  /** Svar på `navigator.credentials.create()` med attestasjon «none». */
  register(challenge: string, flags = UP | UV) {
    const authData = this.authData(flags | AT, true)
    // CBOR: {"fmt": "none", "attStmt": {}, "authData": bytes}
    const length = Buffer.alloc(2)
    length.writeUInt16BE(authData.length)
    const attestationObject = Buffer.concat([
      Buffer.from([0xa3, 0x63]),
      Buffer.from('fmt'),
      Buffer.from([0x64]),
      Buffer.from('none'),
      Buffer.from([0x67]),
      Buffer.from('attStmt'),
      Buffer.from([0xa0, 0x68]),
      Buffer.from('authData'),
      Buffer.from([0x59]),
      length,
      authData,
    ])
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(this.clientData('webauthn.create', challenge)),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    }
  }

  /** Svar på `navigator.credentials.get()`. */
  assert(challenge: string, { flags = UP | UV, from = origin } = {}) {
    const authData = this.authData(flags)
    const clientData = this.clientData('webauthn.get', challenge, from)
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientData)]), this.privateKey)
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
      },
      clientExtensionResults: {},
    }
  }

  /** Raden pluginen ville lagret ved registrering. */
  row(userId: string) {
    return {
      id: b64url(randomBytes(12)),
      userId,
      name: 'Testnøkkel',
      publicKey: this.cose.toString('base64'),
      credentialID: this.credentialId,
      counter: 0,
      deviceType: 'multiDevice',
      backedUp: true,
      transports: 'internal',
    }
  }
}

/** En nettleser: holder på cookiene og sender dem med. */
export function browser(auth: Auth) {
  const jar = new Map<string, string>()
  async function call(path: string, init: { method?: string; body?: unknown; from?: string } = {}) {
    const headers = new Headers({ origin: init.from ?? origin })
    if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '))
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    const response = await auth.handler(
      new Request(`${origin}/api/auth${path}`, {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
    )
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';')
      const [name, ...value] = pair!.split('=')
      if (/max-age=0/i.test(cookie)) jar.delete(name!)
      else jar.set(name!, value.join('='))
    }
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }
  return {
    call,
    headers: () => new Headers({ cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') }),
    async signInWithPassword(email: string) {
      return call('/sign-in/email', { body: { email, password } })
    },
    async signInWithPasskey(
      key: SoftwareAuthenticator,
      options?: Parameters<typeof key.assert>[1],
    ) {
      const { body: challenge } = await call('/passkey/generate-authenticate-options')
      return call('/passkey/verify-authentication', {
        body: { response: key.assert(challenge.challenge, options) },
        from: options?.from,
      })
    },
    async session() {
      return auth.api.getSession({ headers: this.headers() })
    },
  }
}
