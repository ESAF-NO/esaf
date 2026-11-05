import { expect, it, vi } from 'vitest'
import { isChunkLoadError, recoverPreloadError } from '../src/lib/preload-recovery.ts'

it('reloads once after a missing chunk and guards against reload loops across page loads', () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
  }
  const reload = vi.fn()
  expect(recoverPreloadError(storage, reload, 100_000)).toBe(true)
  expect(recoverPreloadError(storage, reload, 100_001)).toBe(false)
  expect(reload).toHaveBeenCalledTimes(1)
  expect(recoverPreloadError(storage, reload, 160_001)).toBe(true)
})

it('does not risk a reload loop when session storage is unavailable', () => {
  const reload = vi.fn()
  const storage = {
    getItem: () => {
      throw new Error('blocked')
    },
    setItem: vi.fn(),
  }
  expect(recoverPreloadError(storage, reload)).toBe(false)
  expect(reload).not.toHaveBeenCalled()
})

it('recognises a failed chunk import in every browser, and nothing else', () => {
  for (const message of [
    'Importing a module script failed.',
    'Failed to fetch dynamically imported module: https://app.esaf.no/assets/feed-abc.js',
    'error loading dynamically imported module: https://app.esaf.no/assets/feed-abc.js',
  ]) {
    expect(isChunkLoadError(new TypeError(message))).toBe(true)
  }
  expect(isChunkLoadError(new Error('Fant ikke profilen'))).toBe(false)
  expect(isChunkLoadError('Importing a module script failed.')).toBe(false)
})
