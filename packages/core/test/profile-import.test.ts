import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { normalizePhone, parseProfileSheet, parseProfileWorkbook } from '../src/profile-import.ts'
import { normalizeLinkedinUrl } from '../src/profiles.ts'

describe('parseProfileSheet (CSV)', () => {
  it('kjenner igjen vanlige kolonnenavn og tolker kull', () => {
    const csv = [
      'Navn,E-post,Kull,Selskap',
      'Ola  Nordmann,OLA@Example.test,2015,Acme',
      '"Kari, Jr. Nordmann",,Kull 2016,',
    ].join('\n')
    const sheet = parseProfileSheet(csv, { yearKind: 'graduation' })
    expect(sheet.rows).toMatchObject([
      { line: 2, fullName: 'Ola Nordmann', emails: ['ola@example.test'], years: [2015] },
      { line: 3, fullName: 'Kari, Jr. Nordmann', emails: [], years: [2016] },
    ])
    expect(sheet.sheets[0]?.ignoredHeaders).toEqual(['Selskap'])
    expect(sheet.errors).toEqual([])
  })

  it('regner om fra opptaksår til uteksamineringsår, som er slik ES navngir kull', () => {
    const sheet = parseProfileSheet('navn,kull\nOla,2022', { yearKind: 'start' })
    expect(sheet.rows[0]?.years).toEqual([2024])
  })

  it('slår sammen fornavn og etternavn, og godtar egne kolonnenavn', () => {
    const csv = 'Fornavn,Etternavn,Mail,Årgang\nOla,Nordmann,ola@example.test,2015'
    const sheet = parseProfileSheet(csv, { yearKind: 'start', columns: { cohort: 'Årgang' } })
    expect(sheet.rows[0]).toMatchObject({ fullName: 'Ola Nordmann', emails: ['ola@example.test'] })
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

  it('samme person i to kull kobles til begge, annen person med samme e-post hoppes over', () => {
    const csv = [
      'navn,epost,kull',
      'Anita Aas,anita@example.test,2012',
      'Anita  Aas,ANITA@example.test,2013',
      'Noen Andre,anita@example.test,2014',
      'Per Berg,per@example.test,2005/2006',
    ].join('\n')
    const sheet = parseProfileSheet(csv, { yearKind: 'graduation' })
    expect(sheet.rows.map((r) => [r.fullName, r.years])).toEqual([
      ['Anita Aas', [2012, 2013]],
      ['Per Berg', [2005, 2006]],
    ])
    expect(sheet.warnings.map((w) => w.line)).toEqual([3])
    expect(sheet.errors.map((e) => e.line)).toEqual([4])
  })

  it('tar med rader uten kull når de har e-post, så de kan kjennes igjen senere', () => {
    const sheet = parseProfileSheet('navn,epost,kull\nStian,stian@example.test,\nJørgen,,', {
      yearKind: 'graduation',
    })
    expect(sheet.rows).toMatchObject([{ fullName: 'Stian', years: [] }])
    expect(sheet.warnings).toMatchObject([{ line: 2, message: expect.stringContaining('kull') }])
    expect(sheet.errors).toMatchObject([{ line: 3, message: expect.stringContaining('e-post') }])
  })

  it('leser telefon og bransjer', () => {
    const csv = [
      'Navn,Kull,Mobil,Bransjer (eks. bygg, media)',
      'Ola,2015,412 34 567,"olje og gass, Telekom; olje og gass"',
      'Kari,2015,ring meg,',
    ].join('\n')
    const sheet = parseProfileSheet(csv, { yearKind: 'graduation' })
    expect(sheet.rows).toMatchObject([
      { phone: '+47 412 34 567', industries: ['Olje og gass', 'Telekom'] },
      { phone: null, industries: [] },
    ])
    expect(sheet.warnings.map((w) => w.line)).toEqual([3])
  })

  it('tar med alle gyldige e-poster og varsler om ugyldige', () => {
    const csv = 'navn,epost,kull\nOla,ikke-en-epost,2015\nKari,"kari@a.test; kari@b.test",2015'
    const sheet = parseProfileSheet(csv, { yearKind: 'start' })
    expect(sheet.rows.map((r) => r.emails)).toEqual([[], ['kari@a.test', 'kari@b.test']])
    expect(sheet.warnings).toHaveLength(1)
  })

  it('leser profilfelt: by og LinkedIn automatisk, selskap bare når oppgitt', () => {
    const csv = [
      'Navn,Kull,By,LinkedIn,Selskap,Nåværende jobb',
      'Ola,2015,Oslo,linkedin.com/in/ola,Acme,Daglig leder',
      'Kari,2015,,https://example.test/kari,,',
    ].join('\n')
    const auto = parseProfileSheet(csv, { yearKind: 'graduation' })
    expect(auto.rows[0]?.fields).toEqual({
      city: 'Oslo',
      linkedinUrl: 'https://linkedin.com/in/ola',
    })
    expect(auto.rows[0]?.role).toBeNull()
    expect(auto.sheets[0]?.ignoredHeaders).toEqual(['Selskap', 'Nåværende jobb'])
    expect(auto.warnings.map((w) => w.line)).toEqual([3])

    // Nåværende selskap og stilling blir erfaring; ES-selskap blir profilfelt.
    const job = parseProfileSheet(csv, {
      yearKind: 'graduation',
      columns: { currentCompany: 'Selskap', jobTitle: 'Nåværende jobb' },
    })
    expect(job.rows[0]?.role).toEqual({ company: 'Acme', title: 'Daglig leder' })
    const es = parseProfileSheet(csv, { yearKind: 'graduation', columns: { esCompany: 'Selskap' } })
    expect(es.rows[0]).toMatchObject({ fields: { esCompany: 'Acme' }, role: null })
  })

  it('feiler tydelig når nødvendige kolonner mangler', () => {
    expect(() => parseProfileSheet('Hvem,Kull\nOla,2015', { yearKind: 'start' })).not.toThrow()
    expect(() => parseProfileSheet('Navn,Telefon\nOla,123', { yearKind: 'start' })).toThrow(/kull/)
    expect(() =>
      parseProfileSheet('Navn,Kull\nOla,2015', { yearKind: 'start', columns: { email: 'Epost2' } }),
    ).toThrow(/Epost2/)
  })
})

/** Lager en arbeidsbok med samme rotete struktur som den ekte telefonlista, men oppdiktede data. */
async function workbook(sheets: Record<string, unknown[][]>, hidden: string[] = []) {
  const wb = new ExcelJS.Workbook()
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name, { state: hidden.includes(name) ? 'hidden' : 'visible' })
    for (const row of rows) ws.addRow(row)
  }
  return new Uint8Array(await wb.xlsx.writeBuffer())
}

describe('parseProfileWorkbook (Excel med én fane per kull)', () => {
  it('leser kull fra fanenavn, hopper over andre faner og tolker overskrifter', async () => {
    const data = await workbook(
      {
        'ES 2024': [
          [
            'Etternavn',
            'Fornavn',
            'E-post',
            'Telefon',
            'Studieretning',
            'LinkedIn (link)',
            'Facebook (link)',
            'Spør meg gjerne om:',
          ],
          [
            'Nordmann',
            'Ola',
            'ola@example.test',
            90000000,
            'Maskin',
            'https://www.linkedin.com/in/ola',
            'https://fb.test/ola',
            'Salg, fundraising; IP',
          ],
        ],
        'ES 2012': [
          [
            'Fornavn',
            'Etternavn',
            'Mobilnr',
            'Primær e-post',
            'NTNU-mail',
            'CERN 1nov-5nov',
            'Studieretning',
          ],
          ['Kari', 'Hansen', 90000001, 'kari@example.test', 'kari@stud.ntnu.test', 'ja', 'Fysikk'],
        ],
        'ES 2014': [
          [
            'Fornavn',
            'Etternavn',
            'Gmail-adresse (må ende på gmail)',
            'Mobil',
            'Tidligere studieretning',
            'Favoritt-is',
            'Adresse',
            'Postnummer',
            'Poststed',
          ],
          [
            'Per',
            'Berg',
            'per@example.test',
            90000002,
            'Data',
            'Sjokolade',
            'Gate 1',
            '7030',
            'Trondheim',
          ],
        ],
        'Mailliste - alle': [['a@example.test'], ['b@example.test']],
        'Ark 16': [],
      },
      ['Ark 16'],
    )
    const parsed = await parseProfileWorkbook(data, { yearKind: 'graduation' })

    expect(parsed.rows).toMatchObject([
      {
        sheet: 'ES 2024',
        fullName: 'Ola Nordmann',
        years: [2024],
        emails: ['ola@example.test'],
        phone: '+47 900 00 000',
        fields: { studyBackground: 'Maskin', linkedinUrl: 'https://www.linkedin.com/in/ola' },
        expertise: ['Salg', 'Fundraising', 'IP'],
      },
      {
        sheet: 'ES 2012',
        fullName: 'Kari Hansen',
        years: [2012],
        emails: ['kari@example.test', 'kari@stud.ntnu.test'],
        phone: '+47 900 00 001',
        fields: { studyBackground: 'Fysikk' },
      },
      {
        sheet: 'ES 2014',
        fullName: 'Per Berg',
        emails: ['per@example.test'],
        phone: '+47 900 00 002',
        fields: { studyBackground: 'Data' },
      },
    ])
    expect(parsed.skippedSheets).toEqual(['Mailliste - alle'])
    // Facebook, adresse og andre private felt importeres aldri.
    const ignored = parsed.sheets.flatMap((s) => s.ignoredHeaders)
    for (const h of ['Facebook (link)', 'Adresse', 'Postnummer', 'Poststed', 'Favoritt-is']) {
      expect(ignored).toContain(h)
    }
    expect(JSON.stringify(parsed.rows)).not.toMatch(/fb\.test|Gate 1|7030|Sjokolade/)
  })

  it('tolker manglende eller feil overskrift i første kolonne ut fra nabokolonnene', async () => {
    const data = await workbook({
      'ES 2021': [
        ['', 'Etternavn', 'E-post'],
        ['Ola', 'Nordmann', 'ola@example.test'],
      ],
      'ES 2020': [
        ['Noen Skrev Navnet Sitt', 'Etternavn', 'E-post'],
        ['Kari', 'Hansen', 'kari@example.test'],
      ],
      'ES 2023': [
        ['F', 'Fornavn', 'E-post'],
        ['Berg', 'Per', 'per@example.test'],
      ],
      'ES 2016': [
        ['en', 'E-mail Address', 'Profession'],
        ['Lise Lund', 'lise@example.test', 'Kjemi'],
      ],
    })
    const parsed = await parseProfileWorkbook(data, { yearKind: 'graduation' })
    expect(parsed.rows.map((r) => [r.sheet, r.fullName])).toEqual([
      ['ES 2021', 'Ola Nordmann'],
      ['ES 2020', 'Kari Hansen'],
      ['ES 2023', 'Per Berg'],
      ['ES 2016', 'Lise Lund'],
    ])
    expect(parsed.sheets.map((s) => s.inferred.length)).toEqual([1, 1, 1, 1])
    expect(parsed.rows[3]?.fields.studyBackground).toBe('Kjemi')
  })

  it('bruker kullkolonnen i faner som dekker flere år, og finner samme person på tvers av faner', async () => {
    const data = await workbook({
      'ES 2005-2009': [
        [
          'Navn',
          'ES-kull',
          'E-post',
          'Bransjer (eks. bygg, media, telecom, bank)',
          'Kompetanseområder (eks. markedsføring, salg)',
        ],
        ['Anne Aas', 2006, 'anne@example.test', 'Olje & energi, bank', 'markedsføring, salg'],
        ['Bjørn Bø', '', '', '', ''],
      ],
      'ES 2010': [
        ['Navn', 'E-post'],
        ['Anne Aas', 'ANNE@example.test'],
        ['Annen Person', 'anne@example.test'],
      ],
    })
    const parsed = await parseProfileWorkbook(data, { yearKind: 'graduation' })
    expect(parsed.rows).toMatchObject([
      {
        fullName: 'Anne Aas',
        years: [2006, 2010],
        industries: ['Olje & energi', 'Bank'],
        expertise: ['Markedsføring', 'Salg'],
      },
    ])
    expect(parsed.warnings).toMatchObject([
      { sheet: 'ES 2010', line: 2, message: expect.stringContaining('ES 2005-2009 rad 2') },
    ])
    expect(parsed.errors).toMatchObject([
      { sheet: 'ES 2005-2009', line: 3, message: expect.stringContaining('kull') },
      { sheet: 'ES 2010', line: 3, message: expect.stringContaining('samme e-post') },
    ])
  })

  it('henter LinkedIn-adressen fra lenken når cellen viser en annen tekst', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('ES 2022')
    ws.addRow(['Navn', 'LinkedIn (link)'])
    ws.addRow(['Ola', { text: 'Profilen min', hyperlink: 'https://www.linkedin.com/in/ola' }])
    const parsed = await parseProfileWorkbook(new Uint8Array(await wb.xlsx.writeBuffer()), {
      yearKind: 'graduation',
    })
    expect(parsed.rows[0]?.fields.linkedinUrl).toBe('https://www.linkedin.com/in/ola')
  })
})

describe('normalizePhone', () => {
  it.each([
    ['41234567', '+47 412 34 567'],
    ['412 34 567', '+47 412 34 567'],
    ['+47 412 34 567', '+47 412 34 567'],
    ['0047 41234567', '+47 412 34 567'],
    ['4741234567', '+47 412 34 567'],
    ['41234567 / 98765432', '+47 412 34 567'],
    ['M: +4741234567', '+47 412 34 567'],
    ['+1 650 555 1234\n(+47 412 34 567)', '+16505551234'],
    ['4917612345678', '+4917612345678'],
    ['0046701234567', '+46701234567'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected)
  })

  it.each(['12345', 'ring meg', '+47 412+34'])('avviser %s', (raw) => {
    expect(normalizePhone(raw)).toBeNull()
  })
})

describe('normalizeLinkedinUrl', () => {
  it.each([
    [
      'https://www.linkedin.com/in/ola?utm_source=share&utm_medium=ios',
      'https://www.linkedin.com/in/ola',
    ],
    ['https://www.linkedin.com/in/ola/?originalSubdomain=no', 'https://www.linkedin.com/in/ola'],
    ['linkedin.com/in/ola', 'https://linkedin.com/in/ola'],
    ['http://no.linkedin.com/in/ola/details/experience/', 'https://no.linkedin.com/in/ola'],
    ['https://www.linkedin.com/company/acme', 'https://www.linkedin.com/company/acme'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeLinkedinUrl(raw)).toBe(expected)
  })

  it.each([
    'https://www.linkedin.com/feed/',
    'https://www.linkedin.com/public-profile/settings?trk=x',
    'https://evil.test/in/ola',
    'https://linkedin.com.evil.test/in/ola',
    'Ola Nordmann',
  ])('avviser %s', (raw) => {
    expect(normalizeLinkedinUrl(raw)).toBeNull()
  })
})
