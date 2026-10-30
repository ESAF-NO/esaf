import { z } from 'zod'

/**
 * E-post fra appen: invitasjoner, lenker for nytt passord og bekreftelse av
 * e-postadressen. Uten leverandør sendes ingenting, og appen er bare åpen for
 * invitasjoner som admin deler selv. Leverandørene:
 *
 * - `console` skriver e-posten i terminalen, med lenkene. Bare utenfor produksjon.
 * - `cloudflare` sender med Cloudflare Email Service (REST-API-et), fra en
 *   adresse på et domene som er satt opp for sending i Cloudflare.
 *
 * Reglene for miljøvariablene står her, som for lagringen, så appen og verktøyene
 * på kommandolinjen følger de samme. Ingen avhengigheter utover `fetch`.
 */

export const EMAIL_PROVIDERS = ['console', 'cloudflare'] as const
export type EmailProvider = (typeof EMAIL_PROVIDERS)[number]

/** Avsender eller mottaker, som `{ address, name }`. */
export type Mailbox = { address: string; name?: string }

export type EmailConfig = {
  from: Mailbox
  replyTo?: string
} & ({ provider: 'console' } | { provider: 'cloudflare'; accountId: string; apiToken: string })

export const DEFAULT_EMAIL_FROM = 'ESAF <post@esaf.no>'

/** Alle må være satt med `EMAIL_PROVIDER=cloudflare`. */
export const CLOUDFLARE_EMAIL_VARIABLES = [
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_EMAIL_API_TOKEN',
] as const

type EmailEnv = Partial<
  Record<
    | 'EMAIL_PROVIDER'
    | 'EMAIL_FROM'
    | 'EMAIL_REPLY_TO'
    | (typeof CLOUDFLARE_EMAIL_VARIABLES)[number],
    string
  >
>

/** Tomme verdier (`EMAIL_FROM=` i .env) betyr ikke satt. */
const setValue = (value: string | undefined) => {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

const emailAddress = z.email().max(254)
/** Linjeskift i en adresse eller et navn kunne lagt til egne e-posthoder. */
const LINE_BREAK = /[\r\n]/

/**
 * Leser «Navn <adresse>» eller bare «adresse». Kaster om adressen ikke er gyldig.
 * Navnet kan stå i anførselstegn: «"ESAF, styret" <styret@esaf.no>».
 */
export function parseMailbox(value: string): Mailbox {
  const trimmed = value.trim()
  if (LINE_BREAK.test(trimmed)) throw new Error('kan ikke inneholde linjeskift')
  const named = /^(.*?)\s*<([^<>\s]+)>$/.exec(trimmed)
  const address = (named ? named[2]! : trimmed).toLowerCase()
  if (!emailAddress.safeParse(address).success) {
    throw new Error(`«${address}» er ikke en gyldig e-postadresse`)
  }
  const name = named?.[1]?.replace(/^"(.*)"$/, '$1').trim()
  return name ? { address, name } : { address }
}

/** Kontoen hos Cloudflare: 32 heksadesimale tegn. */
const ACCOUNT_ID = /^[0-9a-f]{32}$/i

/**
 * Det som er feil med e-postvariablene: ukjent leverandør, `console` i
 * produksjon, manglende nøkler for Cloudflare og avsender- eller svaradresser som
 * ikke kan leses.
 */
export function emailEnvIssues(
  env: EmailEnv,
  { production }: { production: boolean },
): { variable: string; message: string }[] {
  const issues: { variable: string; message: string }[] = []
  const provider = setValue(env.EMAIL_PROVIDER)
  if (provider === undefined) return issues
  if (!(EMAIL_PROVIDERS as readonly string[]).includes(provider)) {
    issues.push({
      variable: 'EMAIL_PROVIDER',
      message: `må være ${EMAIL_PROVIDERS.join(' eller ')}, eller tom (bare invitasjoner)`,
    })
    return issues
  }
  if (provider === 'console' && production) {
    issues.push({
      variable: 'EMAIL_PROVIDER',
      message:
        'console skriver lenkene i loggen og kan ikke brukes i produksjon. Bruk cloudflare, eller la den stå tom (bare invitasjoner)',
    })
  }
  if (provider === 'cloudflare') {
    for (const variable of CLOUDFLARE_EMAIL_VARIABLES) {
      if (setValue(env[variable]) === undefined) {
        issues.push({ variable, message: 'påkrevd med EMAIL_PROVIDER=cloudflare (se README)' })
      }
    }
    const accountId = setValue(env.CLOUDFLARE_ACCOUNT_ID)
    if (accountId !== undefined && !ACCOUNT_ID.test(accountId)) {
      issues.push({
        variable: 'CLOUDFLARE_ACCOUNT_ID',
        message: 'må være konto-ID-en fra Cloudflare (32 tegn, 0–9 og a–f)',
      })
    }
  }
  const from = setValue(env.EMAIL_FROM)
  if (from !== undefined) {
    try {
      parseMailbox(from)
    } catch (error) {
      issues.push({
        variable: 'EMAIL_FROM',
        message: `${(error as Error).message}. Skriv «Navn <adresse>» eller bare adressen`,
      })
    }
  }
  const replyTo = setValue(env.EMAIL_REPLY_TO)
  if (
    replyTo !== undefined &&
    (LINE_BREAK.test(replyTo) || !emailAddress.safeParse(replyTo).success)
  ) {
    issues.push({ variable: 'EMAIL_REPLY_TO', message: 'må være én gyldig e-postadresse' })
  }
  return issues
}

/**
 * E-posten miljøet beskriver, eller null uten leverandør. Sjekk `emailEnvIssues`
 * først; her antas det at variablene er gyldige.
 */
export function emailConfigFromEnv(env: EmailEnv): EmailConfig | null {
  const provider = setValue(env.EMAIL_PROVIDER) as EmailProvider | undefined
  if (provider === undefined) return null
  const from = parseMailbox(setValue(env.EMAIL_FROM) ?? DEFAULT_EMAIL_FROM)
  const replyTo = setValue(env.EMAIL_REPLY_TO)?.toLowerCase()
  const common = { from, ...(replyTo && { replyTo }) }
  if (provider === 'console') return { provider, ...common }
  return {
    provider,
    accountId: setValue(env.CLOUDFLARE_ACCOUNT_ID)!,
    apiToken: setValue(env.CLOUDFLARE_EMAIL_API_TOKEN)!,
    ...common,
  }
}

/** Uten hemmeligheter: til oppstartsloggen. */
export function describeEmail(config: EmailConfig | null): string {
  if (!config) return 'av (bare invitasjoner)'
  const from = config.from.name
    ? `${config.from.name} <${config.from.address}>`
    : config.from.address
  return `${config.provider}, fra ${from}`
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export type EmailMessage = { to: string; subject: string; text: string; html: string }

export type EmailErrorReason = 'bounced' | 'rejected' | 'throttled' | 'unavailable'

/**
 * E-posten ble ikke sendt. Meldingen kan vises til en admin: den sier hva som
 * skjedde, uten adresser, nøkler eller lenker. Detaljene fra leverandøren
 * (kode og HTTP-status) står i loggen.
 */
export class EmailError extends Error {
  readonly reason: EmailErrorReason
  /** Feilkoden fra Cloudflare, om det kom en. */
  readonly providerCode: number | null
  readonly status: number | null

  constructor(
    reason: EmailErrorReason,
    details: { providerCode?: number | null; status?: number | null; cause?: unknown } = {},
  ) {
    super(
      {
        bounced: 'Adressen tar ikke imot e-post. Sjekk at den er riktig.',
        rejected: 'E-posttjenesten avviste sendingen. Det er en feil i oppsettet; se serverloggen.',
        throttled: 'E-posttjenesten har nådd grensen for utsending. Prøv igjen om litt.',
        unavailable: 'E-posttjenesten svarte ikke. Prøv igjen om litt.',
      }[reason],
      { cause: details.cause },
    )
    this.name = 'EmailError'
    this.reason = reason
    this.providerCode = details.providerCode ?? null
    this.status = details.status ?? null
  }
}

export type Mailer = {
  readonly provider: EmailProvider
  /** Sender e-posten, eller kaster `EmailError`. */
  send(message: EmailMessage): Promise<void>
}

type Log = Pick<Console, 'info' | 'error'>

export type MailerOptions = {
  fetch?: typeof globalThis.fetch
  log?: Log
  /** Hvor lenge det ventes på Cloudflare. */
  timeoutMs?: number
}

export const EMAIL_TIMEOUT_MS = 10_000

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4'

/** Svaret fra Cloudflare, så langt vi bruker det. */
type CloudflareResponse = {
  success?: boolean
  errors?: { code?: number; message?: string }[]
  result?: { delivered?: string[]; permanent_bounces?: string[]; queued?: string[] } | null
}

/** Feilmeldingene fra Cloudflare kan nevne mottakeren. Den skal ikke i loggen. */
const redactAddresses = (text: string) => text.replace(/[^\s<>"']+@[^\s<>"']+/g, '[adresse]')

function assertRecipient(to: string) {
  if (LINE_BREAK.test(to) || !emailAddress.safeParse(to).success) {
    // Kommer ikke fra brukeren; adressene er validert før de lagres.
    throw new Error('Ugyldig mottakeradresse')
  }
}

export function createMailer(config: EmailConfig, options: MailerOptions = {}): Mailer {
  const log = options.log ?? console
  if (config.provider === 'console') {
    return {
      provider: 'console',
      async send(message) {
        assertRecipient(message.to)
        // Bare i utvikling (se `emailEnvIssues`): lenkene skal kunne klikkes rett fra terminalen.
        log.info(
          `\n[esaf/e-post] Til: ${message.to}\nEmne: ${message.subject}\n\n${message.text}\n`,
        )
      },
    }
  }

  const fetchImpl = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? EMAIL_TIMEOUT_MS
  const endpoint = `${CLOUDFLARE_API}/accounts/${encodeURIComponent(config.accountId)}/email/sending/send`

  /** Logger det som trengs for å finne feilen, aldri mottakeren, nøkkelen eller innholdet. */
  function fail(error: EmailError, detail: string): never {
    log.error(`[esaf/e-post] E-posten ble ikke sendt (${error.reason}): ${detail}`)
    throw error
  }

  return {
    provider: 'cloudflare',
    async send(message) {
      assertRecipient(message.to)
      let response: Response
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.apiToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            to: message.to,
            from: config.from,
            subject: message.subject,
            text: message.text,
            html: message.html,
            ...(config.replyTo && { reply_to: config.replyTo }),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (cause) {
        const timedOut = cause instanceof Error && cause.name === 'TimeoutError'
        return fail(
          new EmailError('unavailable', { cause }),
          timedOut
            ? `Cloudflare svarte ikke innen ${timeoutMs / 1000} sekunder`
            : `kunne ikke nå Cloudflare (${cause instanceof Error ? cause.name : 'ukjent feil'})`,
        )
      }

      const body = (await response.json().catch(() => null)) as CloudflareResponse | null
      if (!response.ok || body?.success !== true) {
        const first = body?.errors?.[0]
        const providerCode = typeof first?.code === 'number' ? first.code : null
        const status = response.status
        // 10004: for mange forespørsler.
        const reason: EmailErrorReason =
          status === 429 || providerCode === 10004
            ? 'throttled'
            : status >= 500
              ? 'unavailable'
              : 'rejected'
        const what = [
          `HTTP ${status}`,
          providerCode !== null && `kode ${providerCode}`,
          first?.message && `«${redactAddresses(first.message).slice(0, 200)}»`,
        ]
          .filter(Boolean)
          .join(', ')
        return fail(new EmailError(reason, { providerCode, status }), `Cloudflare svarte ${what}`)
      }

      const bounced = body.result?.permanent_bounces ?? []
      if (bounced.some((address) => address.toLowerCase() === message.to.toLowerCase())) {
        return fail(
          new EmailError('bounced', { status: response.status }),
          'Cloudflare meldte en permanent avvisning fra mottakeren',
        )
      }
    },
  }
}
