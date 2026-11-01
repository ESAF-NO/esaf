import { describe, expect, it } from 'vitest'
import {
  describeUnsubscribe,
  digestBoundary,
  INSTANT_DELAY_MS,
  isDue,
  notificationEmail,
  unsubscribeToken,
} from '../src/index.ts'

const PERSON = '00000000-0000-4000-8000-000000000001'
const SECRET = 'en-hemmelighet-som-er-lang-nok-for-testene'

describe('når varsler sendes på e-post', () => {
  it('oppsummeringene går kl. 07 norsk tid, også rundt sommertid', () => {
    // Vintertid (UTC+1): 07:00 i Oslo er 06:00 UTC.
    expect(digestBoundary(new Date('2026-11-04T09:00:00Z'), 'daily').toISOString()).toBe(
      '2026-11-04T06:00:00.000Z',
    )
    // Før kl. 07 gjelder gårsdagens.
    expect(digestBoundary(new Date('2026-11-04T05:30:00Z'), 'daily').toISOString()).toBe(
      '2026-11-03T06:00:00.000Z',
    )
    // Sommertid (UTC+2): 07:00 i Oslo er 05:00 UTC.
    expect(digestBoundary(new Date('2026-06-10T12:00:00Z'), 'daily').toISOString()).toBe(
      '2026-06-10T05:00:00.000Z',
    )
    // Ukentlig: mandag kl. 07. Onsdag 4. november 2026 → mandag 2. november.
    expect(digestBoundary(new Date('2026-11-04T09:00:00Z'), 'weekly').toISOString()).toBe(
      '2026-11-02T06:00:00.000Z',
    )
    // Mandag før kl. 07 → forrige mandag.
    expect(digestBoundary(new Date('2026-11-02T05:00:00Z'), 'weekly').toISOString()).toBe(
      '2026-10-26T06:00:00.000Z',
    )
  })

  it('med en gang venter noen minutter; oppsummeringer venter til grensen; av sender aldri', () => {
    const now = new Date('2026-11-04T09:00:00Z')
    const ago = (ms: number) => new Date(now.getTime() - ms)
    expect(isDue(ago(INSTANT_DELAY_MS - 1000), 'instant', now)).toBe(false)
    expect(isDue(ago(INSTANT_DELAY_MS), 'instant', now)).toBe(true)
    // Laget etter dagens kl. 07: venter til i morgen.
    expect(isDue(new Date('2026-11-04T07:00:00Z'), 'daily', now)).toBe(false)
    expect(isDue(new Date('2026-11-03T20:00:00Z'), 'daily', now)).toBe(true)
    expect(isDue(new Date('2026-11-03T20:00:00Z'), 'weekly', now)).toBe(false)
    expect(isDue(new Date('2026-11-01T20:00:00Z'), 'weekly', now)).toBe(true)
    expect(isDue(ago(60 * 60 * 1000), 'off', now)).toBe(false)
    // For gamle varsler sendes ikke.
    expect(isDue(ago(9 * 24 * 3600 * 1000), 'instant', now)).toBe(false)
  })
})

describe('avmeldingslenken', () => {
  it('er signert, så den ikke kan lages eller endres av andre', () => {
    const token = unsubscribeToken(SECRET, PERSON, 'mentions')
    expect(describeUnsubscribe(SECRET, token)).toEqual({
      category: 'mentions',
      label: 'Når noen nevner deg',
    })
    expect(describeUnsubscribe(SECRET, unsubscribeToken(SECRET, PERSON, 'all')).label).toBe(
      'alle varsler på e-post',
    )
    // Annen hemmelighet, endret innhold eller ukjent kategori avvises.
    expect(() => describeUnsubscribe('en-annen-hemmelighet', token)).toThrow('ikke gyldig')
    const [, signature] = token.split('.')
    const forged = `${Buffer.from(`${PERSON}.all`).toString('base64url')}.${signature}`
    expect(() => describeUnsubscribe(SECRET, forged)).toThrow('ikke gyldig')
    expect(() => describeUnsubscribe(SECRET, 'tull')).toThrow('ikke gyldig')
  })
})

describe('e-posten', () => {
  const links = {
    settingsUrl: 'https://app.esaf.no/konto#varsler',
    unsubscribeUrl: 'https://app.esaf.no/varsler/avmeld?t=x',
    unsubscribeLabel: 'Kommentarer på innleggene dine',
    allUrl: 'https://app.esaf.no/varsler',
  }

  it('ett varsel: setningen som emne, utdraget, en knapp og avmelding', () => {
    const email = notificationEmail({
      ...links,
      summary: false,
      items: [
        {
          text: 'Kari Nordmann kommenterte innlegget ditt «Lansering»',
          url: 'https://app.esaf.no/feed/1#kommentar-2',
          excerpt: 'Gratulerer! <3',
          reply: true,
        },
      ],
    })
    expect(email.subject).toBe('Kari Nordmann kommenterte innlegget ditt «Lansering»')
    expect(email.text).toContain('Svar i ESAF:\nhttps://app.esaf.no/feed/1#kommentar-2')
    expect(email.text).toContain('Svar på denne e-posten går til styret')
    expect(email.text).toContain(
      'Slutt å få kommentarer på innleggene dine på e-post:\nhttps://app.esaf.no/varsler/avmeld?t=x',
    )
    // Det som settes inn, escapes i HTML-en.
    expect(email.html).toContain('Gratulerer! &lt;3')
    expect(email.html).not.toContain('<3')
  })

  it('flere varsler, eller en oppsummering: en liste og «Se alle varsler»', () => {
    const items = [
      { text: 'Ola nevnte deg i «Jobb»', url: 'https://app.esaf.no/feed/1', excerpt: null },
      { text: 'Per kommenterte også «Jobb»', url: 'https://app.esaf.no/feed/1', excerpt: 'Ja!' },
    ]
    expect(notificationEmail({ ...links, summary: false, items }).subject).toBe(
      '2 varsler fra ESAF',
    )
    const digest = notificationEmail({ ...links, summary: true, items })
    expect(digest.subject).toBe('Oppsummering fra ESAF: 2 varsler')
    expect(digest.text).toContain('• Ola nevnte deg i «Jobb»')
    expect(digest.text).toContain('Se alle varsler:\nhttps://app.esaf.no/varsler')
  })
})
