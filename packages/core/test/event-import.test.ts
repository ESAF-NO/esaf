import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import {
  eventRefOf,
  matchEventRef,
  parseParticipation,
  parsePeriod,
  parseRepresentatives,
  readSpreadsheet,
  roleOfValue,
} from '../src/index.ts'

/** En Excel-fil i minnet: fanenavn → rader. */
async function xlsx(
  sheets: Record<string, (string | number | Date | null)[][]>,
  hidden: string[] = [],
) {
  const wb = new ExcelJS.Workbook()
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name, { state: hidden.includes(name) ? 'hidden' : 'visible' })
    for (const row of rows) ws.addRow(row)
  }
  return new Uint8Array(await wb.xlsx.writeBuffer())
}

const csv = (text: string) => new TextEncoder().encode(text)

async function parse(
  data: Uint8Array,
  fileName = 'deltakelse.xlsx',
  options: Omit<Parameters<typeof parseParticipation>[1], 'fileName'> = {},
) {
  return parseParticipation(await readSpreadsheet(data, fileName), { ...options, fileName })
}

describe('verdiene i cellene', () => {
  it('kjenner igjen deltaker, roller og «ikke med»', () => {
    const choice = (v: string) => roleOfValue(v).choice
    expect(['x', 'X', '✓', 'Ja', '1', 'deltok', 'var der'].map(choice)).toEqual(
      Array(7).fill('attended'),
    )
    expect(['arr', 'Arr.', 'arrangør', 'ORG'].map(choice)).toEqual(Array(4).fill('organizer'))
    expect(['foredrag', 'Taler', 'holdt foredrag'].map(choice)).toEqual(Array(3).fill('speaker'))
    expect(['frivillig', 'hjelper'].map(choice)).toEqual(['volunteer', 'volunteer'])
    expect(['nei', '0', '-'].map(choice)).toEqual(['skip', 'skip', 'skip'])
  })

  it('flere verdier i én celle gir den viktigste rollen, og ukjente regnes som deltaker', () => {
    expect(roleOfValue('x, foredrag')).toMatchObject({ choice: 'speaker', known: true })
    expect(roleOfValue('arr/frivillig')).toMatchObject({ choice: 'organizer', known: true })
    expect(roleOfValue('kom sent')).toEqual({ choice: 'attended', known: false, value: 'kom sent' })
    // Admin kan bestemme hva en verdi betyr.
    expect(roleOfValue('Kom sent', { 'kom sent': 'skip' }).choice).toBe('skip')
    expect(roleOfValue('x', { x: 'volunteer' }).choice).toBe('volunteer')
  })
})

describe('arrangementer i overskriftene', () => {
  it('leser år, semester og dato', () => {
    expect(eventRefOf('Høst 2018', 'kolonne C')).toMatchObject({
      year: 2018,
      season: 'autumn',
      date: null,
    })
    expect(eventRefOf('V19', 'kolonne D')).toMatchObject({ year: 2019, season: 'spring' })
    expect(eventRefOf('2015', 'kolonne E')).toMatchObject({ year: 2015, season: null })
    expect(eventRefOf('2018-09-14', 'kolonne F')).toMatchObject({
      year: 2018,
      season: 'autumn',
      date: '2018-09-14',
    })
    expect(eventRefOf('Generalforsamling', 'x', '14.03.2024')).toMatchObject({
      date: '2024-03-14',
      year: 2024,
    })
  })

  it('matcher på navn, dato og år, og foreslår navn og dato når det mangler', () => {
    const type = { id: 't1', name: 'ESAF-helgen' }
    const events = [
      {
        id: 'a',
        name: 'ESAF-helgen høst 2018',
        startDate: '2018-09-14',
        endDate: '2018-09-16',
        typeId: 't1',
        typeName: 'ESAF-helgen',
      },
      {
        id: 'b',
        name: 'ESAF-helgen vår 2019',
        startDate: '2019-04-05',
        endDate: null,
        typeId: 't1',
        typeName: 'ESAF-helgen',
      },
      {
        id: 'c',
        name: 'ESAF-helgen høst 2019',
        startDate: '2019-09-13',
        endDate: null,
        typeId: 't1',
        typeName: 'ESAF-helgen',
      },
      {
        id: 'd',
        name: 'Fagkveld 2019',
        startDate: '2019-03-01',
        endDate: null,
        typeId: 't2',
        typeName: 'Fagkveld',
      },
    ]
    const m = (label: string) => matchEventRef(eventRefOf(label, 'x'), events, type, '2026-10-29')
    expect(m('esaf-helgen HØST 2018')).toMatchObject({ status: 'matched', by: 'name' })
    expect(m('2018-09-15')).toMatchObject({ status: 'matched', by: 'date' })
    expect(m('Høst 2018')).toMatchObject({ status: 'matched', by: 'year' })
    expect(m('2019')).toMatchObject({ status: 'ambiguous', by: 'year' })
    expect(m('2019').candidates.map((c) => c.id)).toEqual(['b', 'c'])
    expect(m('Vår 2019').candidates.map((c) => c.id)).toEqual(['b'])
    expect(m('Høst 2020')).toMatchObject({
      status: 'missing',
      suggestion: {
        name: 'ESAF-helgen høst 2020',
        startDate: '2020-07-01',
        datePrecision: 'semester',
      },
    })
    expect(m('Julebord 2020').suggestion.name).toBe('Julebord 2020')
    expect(m('2021')).toMatchObject({
      status: 'missing',
      suggestion: { name: 'ESAF-helgen 2021', startDate: '2021-01-01', datePrecision: 'year' },
    })
    expect(m('2020-09-18').suggestion).toMatchObject({
      startDate: '2020-09-18',
      datePrecision: 'day',
    })
  })

  it('et arrangement med bare årstall passer begge semestrene det året', () => {
    const type = { id: 't1', name: 'ESAF-helgen' }
    const events = [
      {
        id: 'y',
        name: 'ESAF-helgen 2015',
        startDate: '2015-01-01',
        endDate: null,
        datePrecision: 'year' as const,
        typeId: 't1',
        typeName: 'ESAF-helgen',
      },
    ]
    const m = (label: string) => matchEventRef(eventRefOf(label, 'x'), events, type, '2026-10-29')
    expect(m('Høst 2015')).toMatchObject({ status: 'matched', by: 'year' })
    expect(m('V15')).toMatchObject({ status: 'matched', by: 'year' })
    expect(m('Høst 2015').candidates[0]).toMatchObject({ datePrecision: 'year' })
  })
})

describe('regneark med deltakelse', () => {
  it('matrise: én rad per person, én kolonne per arrangement, med roller', async () => {
    const data = await xlsx({
      Deltakelse: [
        ['Oversikt over ESAF-helgene'],
        [],
        ['Navn', 'E-post', 'Kull', 'Telefon', 'Høst 2018', 'Vår 2019', 'Høst 2019'],
        ['Kari Nordmann', 'kari@example.test', 'ES 2018', '412 34 567', 'x', 'arr', null],
        ['Ola Hansen', null, 2019, null, 'nei', '✓', 'foredrag'],
        ['Per Ødegård', 'PER@example.test', null, null, 'kom sent', null, 'Frivillig'],
        ['Tom rad uten deltakelse', null, null, null, null, null, null],
      ],
    })
    const p = await parse(data)
    expect(p.layout).toBe('matrix')
    expect(p.detected).toBe('matrix')
    expect(p.sheet).toBe('Deltakelse')
    // Telefon er en kjent profilkolonne, ikke et arrangement.
    expect(p.matrixColumns.map((c) => [c.header, c.used])).toEqual([
      ['Telefon', false],
      ['Høst 2018', true],
      ['Vår 2019', true],
      ['Høst 2019', true],
    ])
    expect(p.events.map((e) => [e.label, e.source, e.count])).toEqual([
      ['Høst 2018', 'kolonne E', 2],
      ['Vår 2019', 'kolonne F', 2],
      ['Høst 2019', 'kolonne G', 2],
    ])
    expect(p.people.map((x) => [x.fullName, x.emails, x.year, x.lines])).toEqual([
      ['Kari Nordmann', ['kari@example.test'], 2018, ['rad 4']],
      ['Ola Hansen', [], 2019, ['rad 5']],
      ['Per Ødegård', ['per@example.test'], null, ['rad 6']],
    ])
    expect(
      p.entries.map((e) => [e.personKey.slice(0, 2), e.eventKey.split('|')[0], e.role]),
    ).toEqual([
      ['e:', 'host 2018', null],
      ['e:', 'var 2019', 'organizer'],
      ['n:', 'var 2019', null],
      ['n:', 'host 2019', 'speaker'],
      ['e:', 'host 2018', null],
      ['e:', 'host 2019', 'volunteer'],
    ])
    // Verdiene vises med hva de betyr, også de ukjente.
    expect(p.values.find((v) => v.value === 'kom sent')).toMatchObject({
      known: false,
      choice: 'attended',
    })
    expect(p.values.find((v) => v.value === 'nei')).toMatchObject({ known: true, choice: 'skip' })

    // Admin retter: «kom sent» telles ikke, og bare én kolonne er et arrangement.
    const fixed = await parse(data, 'deltakelse.xlsx', {
      roleMap: { 'kom sent': 'skip' },
      eventColumns: [4],
    })
    expect(fixed.events.map((e) => e.label)).toEqual(['Høst 2018'])
    expect(fixed.entries).toHaveLength(1)
    expect(fixed.people.map((x) => x.fullName)).toEqual(['Kari Nordmann'])
  })

  it('én fane per arrangement, med og uten overskrifter, og skjulte faner hoppes over', async () => {
    const data = await xlsx(
      {
        'ESAF-helgen høst 2018': [
          ['Navn', 'E-post', 'Rolle', 'Notat'],
          ['Kari Nordmann', 'kari@example.test', 'Arrangør', 'Hovedansvarlig'],
          ['Ola Hansen', '', '', ''],
        ],
        'Vår 2019': [['Nordmann, Kari'], ['ola.hansen@example.test'], ['- Per Ødegård 2017']],
        Gammelt: [['Navn'], ['Skjult Person']],
      },
      ['Gammelt'],
    )
    const p = await parse(data)
    expect(p.layout).toBe('sheets')
    expect(p.sheets).toEqual(['ESAF-helgen høst 2018', 'Vår 2019'])
    expect(p.events.map((e) => [e.label, e.source, e.count])).toEqual([
      ['ESAF-helgen høst 2018', 'fanen «ESAF-helgen høst 2018»', 2],
      ['Vår 2019', 'fanen «Vår 2019»', 3],
    ])
    // Kari står på begge fanene, men er én person.
    const kari = p.people.find((x) => x.fullName === 'Kari Nordmann')!
    expect(kari.lines).toEqual(['ESAF-helgen høst 2018 rad 2', 'Vår 2019 rad 1'])
    expect(p.entries[0]).toMatchObject({ role: 'organizer', note: 'Hovedansvarlig' })
    expect(p.people.find((x) => x.fullName === 'Per Ødegård')!.year).toBe(2017)
  })

  it('lang liste: én rad per deltakelse, fra CSV med semikolon og Windows-tegnsett', async () => {
    const text =
      'Navn;E-post;Arrangement;Dato;Rolle\r\n' +
      'Kari Nordmann;kari@example.test;Generalforsamling;14.03.2024;Taler\r\n' +
      'Ola Hansen;;Generalforsamling;14.03.2024;\r\n' +
      'Kari Nordmann;;Fagkveld om salg;2024-10-01;x\r\n' +
      'Pål Ærlig;;;2024-10-01;\r\n'
    // Æ og å som Windows-1252, slik Excel på Windows lagrer CSV.
    const bytes = Uint8Array.from(
      [...text].map((ch) => ({ Æ: 0xc6, å: 0xe5 })[ch] ?? ch.charCodeAt(0)),
    )
    const p = await parse(bytes, 'arrangementer.csv')
    expect(p.layout).toBe('long')
    expect(p.events.map((e) => [e.label, e.date, e.count])).toEqual([
      ['Generalforsamling', '2024-03-14', 2],
      ['Fagkveld om salg', '2024-10-01', 1],
    ])
    expect(p.entries.map((e) => e.role)).toEqual(['speaker', null, null])
    // Navn uten e-post på en senere rad er samme person som raden med e-post.
    expect(p.people).toHaveLength(2)
    expect(p.issues).toEqual([{ where: 'rad 5', message: 'mangler arrangement, hoppes over' }])
  })

  it('admin kan velge et annet oppsett enn det som ble gjettet', async () => {
    const data = await xlsx({
      'Høst 2018': [
        ['Navn', 'Kull'],
        ['Kari Nordmann', '2018'],
      ],
    })
    expect((await parse(data)).layout).toBe('sheets')
    await expect(parse(data, 'x.xlsx', { layout: 'long' })).rejects.toThrow(/arrangement/)
  })

  it('avviser gamle Excel-filer, tomme filer og for store filer', async () => {
    await expect(
      readSpreadsheet(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 1]), 'a.xls'),
    ).rejects.toThrow(/\.xls/)
    await expect(readSpreadsheet(new Uint8Array(), 'a.csv')).rejects.toThrow(/tom/)
    await expect(readSpreadsheet(new Uint8Array(6 * 1024 * 1024), 'a.csv')).rejects.toThrow(
      /for stor/,
    )
    await expect(readSpreadsheet(csv('PK\u0003\u0004 ikke en zip'), 'a.xlsx')).rejects.toThrow(
      /Excel-fila/,
    )
  })
})

describe('regneark med kullrepresentanter', () => {
  it('perioder skrevet på ulike måter', () => {
    expect(parsePeriod('2019–2022')).toEqual({ start: 2019, end: 2022 })
    expect(parsePeriod('2019-')).toEqual({ start: 2019, end: null })
    expect(parsePeriod('siden 2021')).toEqual({ start: 2021, end: null })
    expect(parsePeriod('til 2018')).toEqual({ start: null, end: 2018 })
    expect(parsePeriod('2020')).toEqual({ start: 2020, end: 2020 })
    expect(parsePeriod('lenge')).toBeNull()
  })

  it('kull, navn, e-post, år og notat, og fanenavnet som kull', async () => {
    const data = await xlsx({
      Representanter: [
        ['Kull', 'Navn', 'E-post', 'Fra', 'Til', 'Notat'],
        ['ES 2019', 'Kari Nordmann', 'kari@example.test', 2019, null, 'Valgt på samlingen'],
        ['2016', 'Ola Hansen', null, '2016', '2018', null],
        ['2016', 'Ola Hansen', null, '2016', '2018', null],
        ['ukjent', 'Per Ødegård', null, null, null, null],
        ['2017', 'Siri Berg', null, 2020, 2018, null],
      ],
      'ES 2020': [
        ['Navn', 'Periode'],
        ['Nordmann, Kari', 'siden 2021'],
      ],
    })
    const p = parseRepresentatives(await readSpreadsheet(data, 'reps.xlsx'), 2026)
    expect(p.rows.map((r) => [r.where, r.graduationYear, r.startYear, r.endYear, r.note])).toEqual([
      ['Representanter rad 2', 2019, 2019, null, 'Valgt på samlingen'],
      ['Representanter rad 3', 2016, 2016, 2018, null],
      ['ES 2020 rad 2', 2020, 2021, null, null],
    ])
    expect(p.issues.map((i) => i.where)).toEqual([
      'Representanter rad 4',
      'Representanter rad 5',
      'Representanter rad 6',
    ])
    // Kari står to ganger, men er én person.
    expect(p.people.map((x) => [x.fullName, x.lines.length])).toEqual([
      ['Kari Nordmann', 2],
      ['Ola Hansen', 1],
    ])
  })

  it('krever kull og navn eller e-post', async () => {
    const data = await xlsx({
      Ark1: [
        ['Navn', 'E-post'],
        ['Kari', 'kari@example.test'],
      ],
    })
    expect(() =>
      parseRepresentatives([
        {
          name: 'Ark1',
          rows: [
            ['Navn', 'E-post'],
            ['Kari', 'k@x.no'],
          ],
        },
      ]),
    ).toThrow(/kull og navn/)
    await expect(readSpreadsheet(data, 'a.xlsx')).resolves.toHaveLength(1)
  })
})
