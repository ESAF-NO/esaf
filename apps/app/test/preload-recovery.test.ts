import { expect, it, vi } from 'vitest'
import { recoverPreloadError } from '../src/lib/preload-recovery.ts'

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
