import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { Input } from './ui.tsx'

/** Keep keystrokes independent of asynchronous URL navigation and list rendering. */
export function SearchInput({
  query,
  onSearch,
  ...props
}: {
  query: string
  onSearch: (query: string) => void
} & Omit<ComponentProps<typeof Input>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useState(query)
  const latest = useRef(query)
  const dirty = useRef(false)
  const commit = useRef(onSearch)
  useEffect(() => {
    commit.current = onSearch
  }, [onSearch])

  useEffect(() => {
    // An older navigation must never replace text entered since it started.
    if (query === latest.current) dirty.current = false
    if (!dirty.current) {
      latest.current = query
      setDraft(query)
    }
  }, [query])

  useEffect(() => {
    if (!dirty.current || draft === query) return
    const timer = setTimeout(() => commit.current(draft), 250)
    return () => clearTimeout(timer)
  }, [draft, query])

  return (
    <Input
      {...props}
      type="search"
      value={draft}
      onChange={(event) => {
        latest.current = event.target.value
        dirty.current = true
        setDraft(event.target.value)
      }}
    />
  )
}
