import { describe, expect, it } from 'vitest'
import {
  attendeeLines,
  matchAttendeeLines,
  parseAttendeeLine,
  primaryCohort,
  representativeBadges,
  type MatchPerson,
} from '../src/index.ts'

describe('kullrepresentant på profilen', () => {
  it('nåværende verv først, tidligere med årene og roligere', () => {
    expect(
      representativeBadges([
        { graduationYear: 2019, startYear: 2019, endYear: 2022 },
        { graduationYear: 2024, startYear: 2024, endYear: null },
      ]),
    ).toEqual([
      { graduationYear: 2024, current: true, period: 'siden 2024' },
      { graduationYear: 2019, current: false, period: '2019–2022' },
    ])
  })

  it('skjuler tidligere verv i et kull personen fortsatt representerer', () => {
    expect(
      representativeBadges([
        { graduationYear: 2020, startYear: 2018, endYear: 2019 },
        { graduationYear: 2020, startYear: 2021, endYear: null },
      ]),
    ).toEqual([{ graduationYear: 2020, current: true, period: 'siden 2021' }])
  })

  it('slår sammen perioder som henger sammen, men ikke dem med hull', () => {
    expect(
      representativeBadges([
        { graduationYear: 2015, startYear: 2015, endYear: 2016 },
        { graduationYear: 2015, startYear: 2017, endYear: 2018 },
        { graduationYear: 2015, startYear: 2021, endYear: 2022 },
      ]),
    ).toEqual([{ graduationYear: 2015, current: false, period: '2021–2022, 2015–2018' }])
  })

  it('ukjent start og verv i ett år', () => {
    expect(
      representativeBadges([
        { graduationYear: 2010, startYear: null, endYear: 2012 },
        { graduationYear: 2012, startYear: 2014, endYear: 2014 },
        { graduationYear: 2013, startYear: null, endYear: null },
      ]),
    ).toEqual([
      { graduationYear: 2013, current: true, period: null },
      { graduationYear: 2012, current: false, period: '2014' },
      { graduationYear: 2010, current: false, period: 'til 2012' },
    ])
  })

  it('flere nåværende kull sorteres nyeste først', () => {
    const badges = representativeBadges([
      { graduationYear: 2018, startYear: 2018, endYear: null },
      { graduationYear: 2022, startYear: 2022, endYear: null },
    ])
    expect(badges.map((b) => b.graduationYear)).toEqual([2022, 2018])
    expect(representativeBadges([])).toEqual([])
  })
})

describe('kullet en deltaker vises under', () => {
  it('laveste studentkull, ellers laveste kull, ellers ingen', () => {
    expect(
      primaryCohort([
        { graduationYear: 2012, relation: 'mentor' },
        { graduationYear: 2016, relation: 'student' },
      ]),
    ).toBe(2016)
    expect(primaryCohort([{ graduationYear: 2020, relation: 'staff' }])).toBe(2020)
    expect(primaryCohort([])).toBeNull()
  })
})

describe('innlimt liste med deltakere', () => {
  it('deler på linjer og semikolon og fjerner punkter og nummer', () => {
    expect(attendeeLines('- Kari\n2. Ola; Per\r\n\n  • Siri  ')).toEqual([
      'Kari',
      'Ola',
      'Per',
      'Siri',
    ])
  })

  it('finner navn, e-post og kull på linjen', () => {
    expect(parseAttendeeLine('Kari Nordmann <Kari@Example.com>')).toEqual({
      name: 'Kari Nordmann',
      emails: ['kari@example.com'],
      year: null,
    })
    expect(parseAttendeeLine('Nordmann, Kari')).toMatchObject({ name: 'Kari Nordmann' })
    expect(parseAttendeeLine('Ola Hansen, ES 2019')).toEqual({
      name: 'Ola Hansen',
      emails: [],
      year: 2019,
    })
    expect(parseAttendeeLine('per2019@example.com')).toEqual({
      name: '',
      emails: ['per2019@example.com'],
      year: null,
    })
  })

  const people: MatchPerson[] = [
    {
      personId: 'kari',
      fullName: 'Kari Nordmann',
      emails: ['kari.nordmann@gmail.com'],
      cohortYears: [2018],
      claimed: true,
      status: 'active',
    },
    {
      personId: 'ola-a',
      fullName: 'Ola Hansen',
      emails: [],
      cohortYears: [2012],
      claimed: false,
      status: 'active',
    },
    {
      personId: 'ola-b',
      fullName: 'Ola Hansen',
      emails: [],
      cohortYears: [2020],
      claimed: false,
      status: 'active',
    },
    {
      personId: 'jose',
      fullName: 'José Ødegård',
      emails: [],
      cohortYears: [2015],
      claimed: false,
      status: 'inactive',
    },
    {
      personId: 'siri',
      fullName: 'Siri Marie Berg',
      emails: [],
      cohortYears: [2016],
      claimed: true,
      status: 'active',
    },
  ]

  it('matcher på e-post (også Gmail-varianter) og normalisert navn', () => {
    const lines = matchAttendeeLines(
      'kari.nordmann+esaf@gmail.com\njose odegard\nOLA HANSEN 2020',
      people,
    )
    expect(lines.map((l) => [l.status, l.by, l.candidates.map((c) => c.personId)])).toEqual([
      ['matched', 'email', ['kari']],
      ['matched', 'name', ['jose']],
      ['matched', 'name', ['ola-b']],
    ])
  })

  it('viser flere treff, løse treff og ukjente for manuelt valg', () => {
    const lines = matchAttendeeLines('Ola Hansen\nSiri Berg\nNoen Ukjent', people)
    expect(lines.map((l) => l.status)).toEqual(['ambiguous', 'suggested', 'unmatched'])
    expect(lines[0]!.candidates.map((c) => c.personId).sort()).toEqual(['ola-a', 'ola-b'])
    expect(lines[1]!.candidates.map((c) => c.personId)).toEqual(['siri'])
  })

  it('merker samme person to ganger og dem som allerede er registrert', () => {
    const lines = matchAttendeeLines(
      'Kari Nordmann\nkari.nordmann@gmail.com',
      people,
      new Set(['kari']),
    )
    expect(lines.map((l) => l.status)).toEqual(['matched', 'duplicate'])
    expect(lines[0]!.candidates[0]!.attending).toBe(true)
  })

  it('avviser for lange lister', () => {
    expect(() => matchAttendeeLines(Array(501).fill('x').join('\n'), people)).toThrow(/Maks 500/)
  })
})
