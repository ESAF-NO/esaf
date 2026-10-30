import { describe, expect, it } from 'vitest'
import { decodeBase64Image, fetchPublicImage, isPublicAddress } from '../src/images.ts'

describe('bilder fra nettet', () => {
  it('bare offentlige adresser er lov', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.5',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:10.0.0.1',
      '64:ff9b::a00:1',
      'ikke-en-ip',
    ]) {
      expect([address, isPublicAddress(address)]).toEqual([address, false])
    }
    for (const address of ['8.8.8.8', '151.101.1.69', '2606:4700::6810:84e5', '::ffff:8.8.8.8']) {
      expect([address, isPublicAddress(address)]).toEqual([address, true])
    }
  })

  it('avviser lenker innover før noe hentes', async () => {
    for (const url of [
      'http://127.0.0.1/bilde.png',
      'http://[::1]/bilde.png',
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost/bilde.png',
      'http://postgres:5432/',
      'http://intern.local/bilde.png',
      'https://example.com:8443/bilde.png',
      'https://bruker:pass@example.com/bilde.png',
      'file:///etc/passwd',
      'ftp://example.com/bilde.png',
      'ikke en lenke',
    ]) {
      await expect(fetchPublicImage(url), url).rejects.toThrow(
        /offentlig|standardporten|brukernavn|http eller https|Ugyldig/,
      )
    }
  })

  it('leser base64 og data-adresser, med grense', () => {
    expect([...decodeBase64Image('AQID')]).toEqual([1, 2, 3])
    expect([...decodeBase64Image('data:image/png;base64,AQID')]).toEqual([1, 2, 3])
    expect(() => decodeBase64Image('ikke base64!')).toThrow(/base64/)
    expect(() => decodeBase64Image('A'.repeat(15 * 1024 * 1024))).toThrow(/for stort/)
  })
})
