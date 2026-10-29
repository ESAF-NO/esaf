import { describe, expect, it } from 'vitest'
import { eventWhen, periodStart, suggestEventName } from '../src/lib/events.ts'

describe('datoen til et arrangement', () => {
  it('vises så godt den er kjent', () => {
    expect(eventWhen({ startDate: '2018-07-01', endDate: null, datePrecision: 'semester' })).toBe(
      'Høst 2018',
    )
    expect(eventWhen({ startDate: '2019-01-01', endDate: null, datePrecision: 'semester' })).toBe(
      'Vår 2019',
    )
    expect(eventWhen({ startDate: '2015-01-01', endDate: null, datePrecision: 'year' })).toBe(
      '2015',
    )
    expect(
      eventWhen({ startDate: '2018-09-14', endDate: '2018-09-16', datePrecision: 'day' }),
    ).toBe('14.–16. september 2018')
    expect(eventWhen({ startDate: '2018-09-14', endDate: null, datePrecision: 'day' })).toBe(
      '14. september 2018',
    )
  })

  it('lagres som første dag i perioden', () => {
    expect(periodStart(2018, 'autumn')).toBe('2018-07-01')
    expect(periodStart(2018, 'spring')).toBe('2018-01-01')
    expect(periodStart(2015, 'year')).toBe('2015-01-01')
  })

  it('gir et navn fra typen og perioden', () => {
    expect(suggestEventName('ESAF-helgen', '2018-09-14', 'day')).toBe('ESAF-helgen høst 2018')
    expect(suggestEventName('ESAF-helgen', '2019-01-01', 'semester')).toBe('ESAF-helgen vår 2019')
    expect(suggestEventName('ESAF-helgen', '2015-01-01', 'year')).toBe('ESAF-helgen 2015')
    expect(suggestEventName('ESAF-helgen', '', 'day')).toBeNull()
    expect(suggestEventName(undefined, '2015-01-01', 'year')).toBeNull()
  })
})
