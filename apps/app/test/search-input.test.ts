// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SearchInput } from '../src/components/SearchInput.tsx'

let container: HTMLDivElement
let root: Root
let query: string
let onSearch: ReturnType<typeof vi.fn<(value: string) => void>>

function render(value = query) {
  query = value
  act(() => root.render(createElement(SearchInput, { query, onSearch })))
}

function input() {
  return container.querySelector('input')!
}

function type(value: string) {
  act(() => {
    // Use the native setter so React observes the same change as a browser keystroke.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function advance(ms = 250) {
  act(() => vi.advanceTimersByTime(ms))
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  query = ''
  onSearch = vi.fn()
  render()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('keeps every keystroke immediately and searches once after typing pauses', () => {
  for (const value of ['b', 'be', 'ben', 'benj', 'benja', 'benjam', 'benjami', 'benjamin']) {
    type(value)
    expect(input().value).toBe(value)
    advance(30)
    expect(onSearch).not.toHaveBeenCalled()
  }
  advance()
  expect(onSearch.mock.calls).toEqual([['benjamin']])
})

it('does not let a slow navigation overwrite newer typing', () => {
  type('ben')
  advance()
  type('benjamin')
  render('ben') // The earlier search navigation completes while the user is still typing.
  expect(input().value).toBe('benjamin')
  advance()
  expect(onSearch.mock.calls).toEqual([['ben'], ['benjamin']])
  render('benjamin')
  expect(input().value).toBe('benjamin')
  advance()
  expect(onSearch).toHaveBeenCalledTimes(2)
})

it('syncs external queries once typing has been acknowledged', () => {
  render('space')
  expect(input().value).toBe('space')
  type('benjamin')
  advance()
  render('benjamin')
  render('fintech') // Topic chip or back/forward navigation.
  expect(input().value).toBe('fintech')
  advance()
  expect(onSearch.mock.calls).toEqual([['benjamin']])
})

it('clears the complete query and cancels superseded searches', () => {
  render('benjamin')
  type('ben')
  advance(100)
  type('')
  expect(input().value).toBe('')
  advance()
  expect(onSearch.mock.calls).toEqual([['']])
  render('')
  expect(input().value).toBe('')
})

it('uses the latest callback without restarting the debounce on parent renders', () => {
  type('benjamin')
  advance(200)
  const previous = onSearch
  onSearch = vi.fn()
  render()
  advance(50)
  expect(previous).not.toHaveBeenCalled()
  expect(onSearch).toHaveBeenCalledWith('benjamin')
})

it('cancels pending navigation when the search unmounts', () => {
  type('benjamin')
  act(() => root.render(null))
  advance()
  expect(onSearch).not.toHaveBeenCalled()
})
