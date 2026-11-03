import { describe, expect, it } from 'vitest'
import {
  escapeHtml,
  greeting,
  notificationEmail,
  invitationEmail,
  passwordLinkEmail,
  passwordResetEmail,
  verificationEmail,
  welcomeEmail,
} from '../src/index.ts'

const url = 'https://app.example.test/invitasjon/abc_DEF-123'
// 5. november 2026 kl. 14:05 norsk tid (vintertid, UTC+1).
const expiresAt = new Date('2026-11-05T13:05:00Z')

describe('e-postene', () => {
  it('invitasjonen sier hvem som inviterte, rollen og når lenken går ut', () => {
    const email = invitationEmail({ url, invitedBy: 'Kari Nordmann', role: 'admin', expiresAt })
    expect(email.subject).toBe('Invitasjon til ESAF')
    expect(email.text).toContain('Kari Nordmann har invitert deg til ESAF-appen som admin.')
    expect(email.text).toContain('5. november 2026 kl. 14:05')
    expect(email.text).toContain(url)
    expect(email.html).toContain(`href="${url}"`)
  })

  it('uten rolle står ingen rolle, og uten navn er det styret', () => {
    const email = invitationEmail({ url, invitedBy: null, role: 'member', expiresAt })
    expect(email.text).toContain('Styret i ESAF har invitert deg til ESAF-appen.')
    expect(email.text).not.toMatch(/som (medlem|moderator|admin|hovedadmin)/)
  })

  it('lenken for nytt passord fra en admin', () => {
    const email = passwordLinkEmail({
      url: 'https://app.example.test/nytt-passord/x',
      createdBy: 'Ola Nordmann',
      expiresAt,
    })
    expect(email.subject).toBe('Nytt passord til ESAF')
    expect(email.text).toContain('Ola Nordmann har laget en lenke')
    expect(email.text).toContain('logget ut på alle enheter')
    expect(email.text).toContain('Ba du ikke om dette')
  })

  it('«Glemt passord?» sier én time og ber den som ikke spurte, se bort fra den', () => {
    const email = passwordResetEmail({ url: 'https://app.example.test/nytt-passord/x', expiresAt })
    expect(email.subject).toBe('Nytt passord til ESAF')
    expect(email.text).toContain('i én time (til kl. 14:05)')
    expect(email.text).toContain('Var det ikke deg, kan du se bort fra e-posten.')
  })

  it('bekreftelsen av e-postadressen', () => {
    const email = verificationEmail({
      url: 'https://app.example.test/api/auth/verify-email?token=t&callbackURL=%2Fvelkommen',
      expiresInMinutes: 60,
    })
    expect(email.subject).toBe('Bekreft e-postadressen din')
    expect(email.text).toContain('Lenken virker i én time.')
    // `&` i adressen escapes i HTML-en, men står som den er i teksten.
    expect(email.html).toContain('token=t&amp;callbackURL=%2Fvelkommen')
    expect(email.text).toContain('token=t&callbackURL=%2Fvelkommen')
  })

  it('velkomsten etter godkjenning nevner kullet når det er kjent', () => {
    const app = 'https://app.example.test/'
    const email = welcomeEmail({ url: app, graduationYear: 2017 })
    expect(email.subject).toBe('Du er med i ESAF')
    expect(email.text).toContain('Forespørselen din om tilgang til ESAF-appen er godkjent.')
    expect(email.text).toContain('ES 2017')
    expect(email.html).toContain(`href="${app}"`)
    expect(welcomeEmail({ url: app, graduationYear: null }).text).not.toContain('ES ')
  })

  it('hilsenen bruker fornavnet når vi vet hvem det er', () => {
    expect(greeting('Kari Nordmann')).toBe('Hei Kari!')
    expect(greeting('  Ola  ')).toBe('Hei Ola!')
    expect(greeting(null)).toBe('Hei!')
    expect(greeting('')).toBe('Hei!')
    const named = welcomeEmail({ name: 'Kari Nordmann', url, graduationYear: 2024 })
    expect(named.text.startsWith('Hei Kari!')).toBe(true)
    expect(named.html).toContain('Hei Kari!')
    expect(named.text).toContain('ES 2024')
    expect(invitationEmail({ url, invitedBy: null, role: 'member', expiresAt }).text).toMatch(
      /^Hei!/,
    )
    const note = notificationEmail({
      name: 'Ola Hansen',
      items: [{ text: 'Kari kommenterte', url, excerpt: null }],
      summary: false,
      settingsUrl: url,
      unsubscribeUrl: url,
      unsubscribeLabel: 'Alle varsler',
      allUrl: url,
    })
    expect(note.text.startsWith('Hei Ola!')).toBe(true)
  })

  it('alt som settes inn, escapes i HTML-en', () => {
    const evil = '<script>alert("x")</script> & \'Ola\''
    const email = invitationEmail({
      url: 'https://app.example.test/invitasjon/a"><img src=x onerror=alert(1)>',
      invitedBy: evil,
      role: 'member',
      expiresAt,
    })
    expect(email.html).not.toContain('<script>')
    expect(email.html).not.toContain('<img')
    expect(email.html).toContain(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Ola&#39;',
    )
    expect(email.html).toContain('a&quot;&gt;&lt;img src=x onerror=alert(1)&gt;')
    // Teksten er ren tekst og escapes ikke.
    expect(email.text).toContain(evil)
  })

  it('escapeHtml', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    )
  })
})
