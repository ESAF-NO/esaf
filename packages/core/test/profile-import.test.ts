import { describe, expect, it } from 'vitest'
import { parseProfileSheet } from '../src/profile-import.ts'

describe('parseProfileSheet', () => {
  it('kjenner igjen vanlige kolonnenavn og tolker kull', () => {
    const csv = [
      'Navn,E-post,Kull,Selskap',
      'Ola  Nordmann,OLA@Example.test,2015,Acme',
      '"Kari, Jr. Nordmann",,Kull 2016,',
    ].join('\n')
    const sheet = parseProfileSheet(csv, { yearKind: 'start' })
    expect(sheet.rows).toEqual([
      { line: 2, fullName: 'Ola Nordmann', email: 'ola@example.test', startYear: 2015 },
      { line: 3, fullName: 'Kari, Jr. Nordmann', email: null, startYear: 2016 },
    ])
    expect(sheet.ignoredHeaders).toEqual(['Selskap'])
    expect(sheet.errors).toEqual([])
  })

  it('regner om fra uteksamineringsår til opptaksår', () => {
    const sheet = parseProfileSheet('navn,kull\nOla,2017', { yearKind: 'graduation' })
    expect(sheet.rows[0]?.startYear).toBe(2015)
  })

  it('slår sammen fornavn og etternavn, og godtar egne kolonnenavn', () => {
    const csv = 'Fornavn,Etternavn,Mail,Årgang\nOla,Nordmann,ola@example.test,2015'
    const sheet = parseProfileSheet(csv, { yearKind: 'start', columns: { cohort: 'Årgang' } })
    expect(sheet.rows[0]).toMatchObject({ fullName: 'Ola Nordmann', email: 'ola@example.test' })
  })

  it('hopper over rader uten navn, ukjent kull og duplikater', () => {
    const csv = [
      'navn,epost,kull',
      ',x@example.test,2015',
      'Uten Kull,,ukjent',
      'Ola,ola@example.test,2015',
      'Ola Igjen,OLA@example.test,2016',
      'Kari,,2015',
      'kari,,2015',
    ].join('\n')
    const sheet = parseProfileSheet(csv, { yearKind: 'start' })
    expect(sheet.rows.map((r) => r.fullName)).toEqual(['Ola', 'Kari'])
    expect(sheet.errors.map((e) => e.line)).toEqual([2, 3, 5, 7])
  })

  it('importerer ugyldig e-post uten e-post, og velger første av flere', () => {
    const csv = 'navn,epost,kull\nOla,ikke-en-epost,2015\nKari,"kari@a.test; kari@b.test",2015'
    const sheet = parseProfileSheet(csv, { yearKind: 'start' })
    expect(sheet.rows.map((r) => r.email)).toEqual([null, 'kari@a.test'])
    expect(sheet.warnings).toHaveLength(2)
  })

  it('feiler tydelig når nødvendige kolonner mangler', () => {
    expect(() => parseProfileSheet('Navn,Telefon\nOla,123', { yearKind: 'start' })).toThrow(/kull/)
    expect(() =>
      parseProfileSheet('Navn,Kull\nOla,2015', { yearKind: 'start', columns: { email: 'Epost2' } }),
    ).toThrow(/Epost2/)
  })
})
