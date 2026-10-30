import { describe, expect, it, vi } from 'vitest'
import {
  createMailer,
  describeEmail,
  emailConfigFromEnv,
  emailEnvIssues,
  EmailError,
  parseMailbox,
  type EmailConfig,
} from '../src/index.ts'

const accountId = '0123456789abcdef0123456789abcdef'
const apiToken = 'hemmelig-nokkel-som-aldri-skal-logges'
const config: EmailConfig = {
  provider: 'cloudflare',
  accountId,
  apiToken,
  from: { address: 'post@example.test', name: 'ESAF' },
}
const message = {
  to: 'kari.nordmann@example.test',
  subject: 'Nytt passord til ESAF',
  text: 'Lenke: https://app.example.test/nytt-passord/hemmelig-token',
  html: '<p>Lenke</p>',
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const ok = (result: Record<string, string[]> = { delivered: [message.to] }) =>
  json(200, {
    success: true,
    errors: [],
    result: { delivered: [], permanent_bounces: [], queued: [], ...result },
  })

/** En mailer mot en falsk Cloudflare, med loggen samlet opp. */
function setup(respond: (request: Request) => Response | Promise<Response>, timeoutMs?: number) {
  const requests: { url: string; init: RequestInit }[] = []
  const logged: string[] = []
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init! })
    return respond(new Request(String(url), init))
  }) as unknown as typeof globalThis.fetch
  const log = {
    info: (...args: unknown[]) => logged.push(args.join(' ')),
    error: (...args: unknown[]) => logged.push(args.join(' ')),
  }
  return { mailer: createMailer(config, { fetch, log, timeoutMs }), requests, logged }
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    if (error instanceof EmailError) return error
    throw error
  }
  throw new Error('Forventet EmailError')
}

describe('Cloudflare Email Service', () => {
  it('sender til REST-API-et med nøkkelen, avsenderen og begge formatene', async () => {
    const { mailer, requests } = setup(() => ok())
    await mailer.send(message)
    expect(requests).toHaveLength(1)
    const { url, init } = requests[0]!
    expect(url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/email/sending/send`,
    )
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${apiToken}`)
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(String(init.body))).toEqual({
      to: message.to,
      from: { address: 'post@example.test', name: 'ESAF' },
      subject: message.subject,
      text: message.text,
      html: message.html,
    })
  })

  it('tar med svaradressen når den er satt', async () => {
    const requests: string[] = []
    const mailer = createMailer(
      { ...config, replyTo: 'styret@example.test' },
      {
        fetch: (async (_url: string, init: RequestInit) => {
          requests.push(String(init.body))
          return ok()
        }) as unknown as typeof globalThis.fetch,
      },
    )
    await mailer.send(message)
    expect(JSON.parse(requests[0]!)).toMatchObject({ reply_to: 'styret@example.test' })
  })

  it('godtar e-post som står i kø', async () => {
    const { mailer, logged } = setup(() => ok({ queued: [message.to] }))
    await mailer.send(message)
    expect(logged).toEqual([])
  })

  it('en permanent avvisning er en feil', async () => {
    const { mailer, logged } = setup(() =>
      ok({ permanent_bounces: ['Kari.Nordmann@example.test'] }),
    )
    const error = await failure(mailer.send(message))
    expect(error.reason).toBe('bounced')
    expect(error.message).toMatch(/tar ikke imot e-post/)
    expect(logged.join('\n')).toMatch(/permanent avvisning/)
  })

  it.each([
    [403, 10203, 'sending_disabled', 'rejected'],
    [403, 10105, 'not entitled', 'rejected'],
    [401, 10000, 'Authentication error', 'rejected'],
    [400, 10001, 'invalid recipient kari.nordmann@example.test', 'rejected'],
    [429, 10004, 'throttled', 'throttled'],
    [400, 10004, 'throttled', 'throttled'],
    [503, 10500, 'internal error', 'unavailable'],
  ] as const)('HTTP %i med kode %i gir %s', async (status, code, text, reason) => {
    const { mailer, logged } = setup(() =>
      json(status, { success: false, errors: [{ code, message: text }], result: null }),
    )
    const error = await failure(mailer.send(message))
    expect(error).toMatchObject({ reason, providerCode: code, status })
    const log = logged.join('\n')
    expect(log).toContain(`HTTP ${status}`)
    expect(log).toContain(`kode ${code}`)
  })

  it('et svar som ikke er JSON, eller uten success, er en feil', async () => {
    const html = setup(() => new Response('<html>Bad gateway</html>', { status: 502 }))
    expect((await failure(html.mailer.send(message))).reason).toBe('unavailable')
    const odd = setup(() => json(200, { success: false, errors: [], result: null }))
    expect((await failure(odd.mailer.send(message))).reason).toBe('rejected')
  })

  it('gir opp etter tidsgrensen', async () => {
    const { mailer, logged } = setup(
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason))
        }),
      20,
    )
    const error = await failure(mailer.send(message))
    expect(error.reason).toBe('unavailable')
    expect(logged.join('\n')).toMatch(/svarte ikke innen/)
  })

  it('nettverksfeil gir «svarte ikke»', async () => {
    const { mailer } = setup(() => {
      throw new TypeError('fetch failed')
    })
    const error = await failure(mailer.send(message))
    expect(error.reason).toBe('unavailable')
    expect(error.message).toMatch(/svarte ikke/)
  })

  it('logger aldri nøkkelen, mottakeren, emnet eller lenken', async () => {
    const { mailer, logged } = setup(() =>
      json(400, {
        success: false,
        errors: [{ code: 10001, message: `invalid recipient <${message.to}>` }],
        result: null,
      }),
    )
    const error = await failure(mailer.send(message))
    const log = logged.join('\n')
    for (const secret of [apiToken, message.to, 'hemmelig-token', message.subject]) {
      expect(log).not.toContain(secret)
      expect(error.message).not.toContain(secret)
    }
    expect(log).toContain('[adresse]')
  })

  it('avviser mottakere med linjeskift eller uten gyldig adresse, uten å sende', async () => {
    const { mailer, requests } = setup(() => ok())
    await expect(
      mailer.send({ ...message, to: 'a@example.test\r\nBcc: b@example.test' }),
    ).rejects.toThrow()
    await expect(mailer.send({ ...message, to: 'ikke en adresse' })).rejects.toThrow()
    expect(requests).toEqual([])
  })
})

describe('console', () => {
  it('skriver e-posten i loggen og sender ingenting', async () => {
    const info: string[] = []
    const fetch = vi.fn()
    const mailer = createMailer(
      { provider: 'console', from: { address: 'post@example.test' } },
      {
        fetch: fetch as unknown as typeof globalThis.fetch,
        log: { info: (text: string) => info.push(text), error: () => undefined },
      },
    )
    await mailer.send(message)
    expect(fetch).not.toHaveBeenCalled()
    expect(info.join('\n')).toContain(message.text)
  })
})

describe('miljøvariablene', () => {
  const production = { production: true }
  const development = { production: false }
  const variables = (env: Record<string, string>, options = production) =>
    emailEnvIssues(env, options).map((i) => i.variable)

  it('uten leverandør er e-post av, og ingenting er påkrevd', () => {
    expect(emailEnvIssues({}, production)).toEqual([])
    expect(emailEnvIssues({ EMAIL_PROVIDER: '' }, production)).toEqual([])
    expect(emailConfigFromEnv({ EMAIL_PROVIDER: '' })).toBeNull()
    expect(describeEmail(null)).toMatch(/bare invitasjoner/)
  })

  it('console er bare lov utenfor produksjon', () => {
    expect(variables({ EMAIL_PROVIDER: 'console' })).toEqual(['EMAIL_PROVIDER'])
    expect(variables({ EMAIL_PROVIDER: 'console' }, development)).toEqual([])
  })

  it('ukjente leverandører avvises', () => {
    expect(variables({ EMAIL_PROVIDER: 'smtp' }, development)).toEqual(['EMAIL_PROVIDER'])
  })

  it('cloudflare krever konto-ID og nøkkel, og konto-ID-en må se riktig ut', () => {
    expect(variables({ EMAIL_PROVIDER: 'cloudflare' })).toEqual([
      'CLOUDFLARE_ACCOUNT_ID',
      'CLOUDFLARE_EMAIL_API_TOKEN',
    ])
    expect(
      variables({
        EMAIL_PROVIDER: 'cloudflare',
        CLOUDFLARE_ACCOUNT_ID: ' ',
        CLOUDFLARE_EMAIL_API_TOKEN: apiToken,
      }),
    ).toEqual(['CLOUDFLARE_ACCOUNT_ID'])
    expect(
      variables({
        EMAIL_PROVIDER: 'cloudflare',
        CLOUDFLARE_ACCOUNT_ID: 'ikke-en-konto',
        CLOUDFLARE_EMAIL_API_TOKEN: apiToken,
      }),
    ).toEqual(['CLOUDFLARE_ACCOUNT_ID'])
    expect(
      variables({
        EMAIL_PROVIDER: 'cloudflare',
        CLOUDFLARE_ACCOUNT_ID: accountId,
        CLOUDFLARE_EMAIL_API_TOKEN: apiToken,
      }),
    ).toEqual([])
  })

  it('avsenderen er ESAF <post@esaf.no> som standard, og kan settes', () => {
    const base = {
      EMAIL_PROVIDER: 'cloudflare',
      CLOUDFLARE_ACCOUNT_ID: accountId,
      CLOUDFLARE_EMAIL_API_TOKEN: apiToken,
    }
    expect(emailConfigFromEnv(base)).toEqual({
      provider: 'cloudflare',
      accountId,
      apiToken,
      from: { address: 'post@esaf.no', name: 'ESAF' },
    })
    expect(
      emailConfigFromEnv({
        ...base,
        EMAIL_FROM: 'Styret i ESAF <Styret@Example.test>',
        EMAIL_REPLY_TO: 'Styret@Example.test',
      }),
    ).toMatchObject({
      from: { address: 'styret@example.test', name: 'Styret i ESAF' },
      replyTo: 'styret@example.test',
    })
    expect(describeEmail(emailConfigFromEnv(base))).toBe('cloudflare, fra ESAF <post@esaf.no>')
    expect(describeEmail(emailConfigFromEnv(base))).not.toContain(apiToken)
  })

  it('avsender- og svaradresser som ikke kan leses, avvises', () => {
    const base = { EMAIL_PROVIDER: 'console' }
    expect(variables({ ...base, EMAIL_FROM: 'ESAF <ikke-en-adresse>' }, development)).toEqual([
      'EMAIL_FROM',
    ])
    expect(
      variables({ ...base, EMAIL_REPLY_TO: 'to@example.test, tre@example.test' }, development),
    ).toEqual(['EMAIL_REPLY_TO'])
    expect(variables({ ...base, EMAIL_FROM: 'post@example.test' }, development)).toEqual([])
  })
})

describe('parseMailbox', () => {
  it('leser «Navn <adresse>» og bare adressen', () => {
    expect(parseMailbox('ESAF <post@example.test>')).toEqual({
      address: 'post@example.test',
      name: 'ESAF',
    })
    expect(parseMailbox('"ESAF, styret" <styret@example.test>')).toEqual({
      address: 'styret@example.test',
      name: 'ESAF, styret',
    })
    expect(parseMailbox('  Post@Example.test ')).toEqual({ address: 'post@example.test' })
    expect(parseMailbox('<post@example.test>')).toEqual({ address: 'post@example.test' })
  })

  it('avviser ugyldige adresser og linjeskift', () => {
    expect(() => parseMailbox('ESAF')).toThrow()
    expect(() => parseMailbox('ESAF <post@>')).toThrow()
    expect(() => parseMailbox('ESAF\r\nBcc: x@example.test <post@example.test>')).toThrow()
  })
})
