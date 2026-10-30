import { describe, expect, it } from 'vitest'
import {
  chooseSearchModel,
  SEARCH_MODEL,
  SEARCH_MODEL_MIN_MEMORY,
  SEARCH_MODEL_SMALL,
} from '../src/search-embedder.ts'

const GB = 1024 ** 3

describe('valg av embedding-modell', () => {
  it('bruker BGE-M3 når serveren har nok minne, og den lille modellen ellers', () => {
    expect(chooseSearchModel(undefined, 8 * GB)).toBe(SEARCH_MODEL)
    expect(chooseSearchModel(undefined, SEARCH_MODEL_MIN_MEMORY)).toBe(SEARCH_MODEL)
    expect(chooseSearchModel(undefined, 2 * GB)).toBe(SEARCH_MODEL_SMALL)
  })

  it('SEARCH_MODEL vinner alltid', () => {
    expect(chooseSearchModel('Xenova/multilingual-e5-base', 2 * GB)).toBe(
      'Xenova/multilingual-e5-base',
    )
    expect(chooseSearchModel(SEARCH_MODEL, 1 * GB)).toBe(SEARCH_MODEL)
  })
})
