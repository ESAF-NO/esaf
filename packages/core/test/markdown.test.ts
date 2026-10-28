import { describe, expect, it } from 'vitest'
import { markdownToPlainText } from '../src/index.ts'

describe('markdownToPlainText', () => {
  it('fjerner formatering og beholder teksten', () => {
    expect(markdownToPlainText('Vi har **endelig** lansert, _takk_ til ~~ingen~~ alle!')).toBe(
      'Vi har endelig lansert, takk til ingen alle!',
    )
    expect(markdownToPlainText('Bruk `pnpm db:seed` lokalt.')).toBe('Bruk pnpm db:seed lokalt.')
  })

  it('gjør lenker om til lenketeksten, og omtaler til @Navn', () => {
    expect(markdownToPlainText('Les [søknaden vår](https://example.test/soknad) først.')).toBe(
      'Les søknaden vår først.',
    )
    expect(markdownToPlainText('Se https://example.test og <https://example.test/b>')).toBe(
      'Se https://example.test og https://example.test/b',
    )
    expect(
      markdownToPlainText(
        'Spør @[Kari Nordmann](0b6a3c55-8a59-4a4e-9a8a-6a0f2b1c9d10), hun kan dette.',
      ),
    ).toBe('Spør @Kari Nordmann, hun kan dette.')
  })

  it('skiller avsnitt, lister, sitater og kodeblokker med mellomrom', () => {
    const body = [
      '# Overskrift',
      '',
      'Første avsnitt',
      'med linjeskift.',
      '',
      '- ett',
      '- to',
      '',
      '1. tre',
      '',
      '> sitat',
      '',
      '```ts',
      'const x = 1',
      '```',
      '',
      '---',
      '',
      'Slutt',
    ].join('\n')
    expect(markdownToPlainText(body)).toBe(
      'Overskrift Første avsnitt med linjeskift. ett to tre sitat const x = 1 Slutt',
    )
  })

  it('viser rå HTML som tekst, slik appen gjør, og hopper over bilder og fotnoter', () => {
    expect(markdownToPlainText('Hei <script>alert(1)</script>')).toBe(
      'Hei <script>alert(1)</script>',
    )
    expect(markdownToPlainText('![Logoen vår](https://example.test/logo.png) Nytt design')).toBe(
      'Logoen vår Nytt design',
    )
    expect(markdownToPlainText('Påstand[^1]\n\n[^1]: Kilde.')).toBe('Påstand')
  })

  it('tåler tom tekst og tolker bare starten av svært lange tekster', () => {
    expect(markdownToPlainText('')).toBe('')
    expect(markdownToPlainText('   \n\n  ')).toBe('')
    const long = `${'ord '.repeat(5_000)}SLUTT`
    const text = markdownToPlainText(long)
    expect(text.startsWith('ord ord')).toBe(true)
    expect(text).not.toContain('SLUTT')
  })
})
