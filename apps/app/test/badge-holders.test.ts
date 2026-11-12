import { describe, expect, it } from 'vitest'
import {
  filterHolders,
  holderSourceLabel,
  holderStatusLabel,
  sortHolders,
} from '../src/lib/badge-holders.ts'

const h = (fullName: string, achievedOn: string | null = null) => ({ fullName, achievedOn })

describe('sortHolders', () => {
  it('viser de nyeste først, de uten dato sist, og så på navn', () => {
    const sorted = sortHolders([
      h('Åse Berg', null),
      h('Per Olsen', '2019-09-14'),
      h('Kari Nordmann', '2024-05-01'),
      h('Anne Aas', null),
      h('Ola Hansen', '2019-09-14'),
      h('Øystein Lie', '2021-01-10'),
    ])
    expect(sorted.map((x) => x.fullName)).toEqual([
      'Kari Nordmann',
      'Øystein Lie',
      'Ola Hansen',
      'Per Olsen',
      'Anne Aas',
      'Åse Berg',
    ])
  })

  it('endrer ikke lista den får', () => {
    const list = [h('B', '2020-01-01'), h('A', '2021-01-01')]
    sortHolders(list)
    expect(list.map((x) => x.fullName)).toEqual(['B', 'A'])
  })

  it('sorterer æ, ø og å etter z', () => {
    expect(
      sortHolders([h('Åse'), h('Zara'), h('Ærle'), h('Øyvind')]).map((x) => x.fullName),
    ).toEqual(['Zara', 'Ærle', 'Øyvind', 'Åse'])
  })
})

describe('filterHolders', () => {
  const list = [h('Kari Nordmann'), h('José Álvarez'), h('Ola Kari Hansen'), h('Per Olsen')]

  it('gir alle med tomt søk', () => {
    expect(filterHolders(list, '  ')).toHaveLength(4)
  })

  it('finner deler av navnet uten hensyn til store bokstaver', () => {
    expect(filterHolders(list, 'KARI').map((x) => x.fullName)).toEqual([
      'Kari Nordmann',
      'Ola Kari Hansen',
    ])
  })

  it('krever alle ordene, i hvilken som helst rekkefølge', () => {
    expect(filterHolders(list, 'hansen kari').map((x) => x.fullName)).toEqual(['Ola Kari Hansen'])
  })

  it('ser bort fra aksenter, men ikke fra æ, ø og å', () => {
    expect(filterHolders(list, 'jose alvarez').map((x) => x.fullName)).toEqual(['José Álvarez'])
    expect(filterHolders([h('Øystein Lie')], 'oystein')).toHaveLength(0)
    expect(filterHolders([h('Åse Berg')], 'ase')).toHaveLength(0)
    expect(filterHolders([h('Åse Berg')], 'åse')).toHaveLength(1)
  })

  it('gir ingen treff når ingen passer', () => {
    expect(filterHolders(list, 'xyz')).toEqual([])
  })
})

describe('holderStatusLabel', () => {
  it('merker bare medlemskap som ikke er aktivt', () => {
    expect(holderStatusLabel('active')).toBeNull()
    expect(holderStatusLabel('pending')).toBe('Venter')
    expect(holderStatusLabel('inactive')).toBe('Deaktivert')
    expect(holderStatusLabel(null)).toBe('Uten medlemskap')
  })
})

describe('holderSourceLabel', () => {
  it('sier om merket kom etter regelen eller for hånd', () => {
    expect(holderSourceLabel('rule')).toBe('Etter regelen')
    expect(holderSourceLabel('manual')).toBe('Delt ut for hånd')
  })
})
