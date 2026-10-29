import { useRouter } from '@tanstack/react-router'
import { Building2, CornerDownLeft, FileText, Search, Users } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { channels, type ChannelKey } from '#/lib/channels.ts'
import { quickSearch } from '#/lib/search.functions.ts'
import { RepresentativeTag } from './Representatives.tsx'
import { Avatar, CompanyLogo, cx, Verified } from './ui.tsx'

type Results = Awaited<ReturnType<typeof quickSearch>>
type Item = {
  key: string
  label: string
  sub?: string
  go: () => void
  render: () => React.ReactNode
}

/** Monteres på nytt hver gang den åpnes, så tilstanden starter blank. */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Results | null>(null)
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(0)

  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) return
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const found = await quickSearch({ data: { q: term } })
        if (!cancelled) {
          setResults(found)
          setActive(0)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 180)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [q])

  function onChange(value: string) {
    setQ(value)
    setLoading(value.trim().length >= 2)
  }

  const go = (fn: () => Promise<void>) => () => {
    onClose()
    void fn()
  }

  const sections = useMemo(() => {
    if (!results) return []
    const term = q.trim()
    const people: Item[] = results.people.map((p) => ({
      key: `p-${p.personId}`,
      label: p.fullName,
      go: go(() =>
        router.navigate({ to: '/medlemmer/$personId', params: { personId: p.personId } }),
      ),
      render: () => (
        <>
          <Avatar name={p.fullName} photo={p.photo} size="sm" muted={!p.claimed} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1 font-medium text-stone-900">
              {p.fullName} <Verified claimed={p.claimed} />
              <RepresentativeTag years={p.representativeOf} className="ml-1" />
            </span>
            <span className="block truncate text-xs text-stone-500">
              {[p.jobTitle, p.currentCompany].filter(Boolean).join(' · ')}
            </span>
          </span>
        </>
      ),
    }))
    if (results.people.length) {
      people.push({
        key: 'all-people',
        label: 'Alle personer',
        go: go(() => router.navigate({ to: '/medlemmer', search: { q: term } })),
        render: () => (
          <span className="pl-11 text-sm text-stone-500">
            Se alle personer som matcher «{term}»
          </span>
        ),
      })
    }
    const companies: Item[] = results.companies.map((c) => ({
      key: `c-${c.slug}`,
      label: c.name,
      go: go(() => router.navigate({ to: '/selskaper/$slug', params: { slug: c.slug } })),
      render: () => (
        <>
          <CompanyLogo name={c.name} logo={c.logo} size="sm" className="size-8 text-xs" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium text-stone-900">{c.name}</span>
            <span className="block truncate text-xs text-stone-500">
              {[c.tagline, c.people ? `${c.people} fra ES` : null].filter(Boolean).join(' · ')}
            </span>
          </span>
        </>
      ),
    }))
    if (results.companies.length) {
      companies.push({
        key: 'all-companies',
        label: 'Alle selskaper',
        go: go(() => router.navigate({ to: '/selskaper', search: { q: term, vis: 'alle' } })),
        render: () => (
          <span className="pl-11 text-sm text-stone-500">
            Se alle selskaper som matcher «{term}»
          </span>
        ),
      })
    }
    const posts: Item[] = results.posts.map((p) => {
      const Icon = channels[p.channel as ChannelKey].icon
      return {
        key: `post-${p.id}`,
        label: p.title,
        go: go(() => router.navigate({ to: '/feed/$postId', params: { postId: p.id } })),
        render: () => (
          <>
            <span className="grid size-8 place-items-center rounded-lg bg-stone-100 text-stone-500">
              <Icon className="size-4" aria-hidden />
            </span>
            <span className="min-w-0 flex-1 truncate font-medium text-stone-900">{p.title}</span>
          </>
        ),
      }
    })
    return [
      { title: 'Personer', icon: Users, items: people },
      { title: 'Selskaper', icon: Building2, items: companies },
      { title: 'Innlegg', icon: FileText, items: posts },
    ].filter((s) => s.items.length)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results])

  const flat = sections.flatMap((s) => s.items)

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') onClose()
    else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, flat.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      flat[active]?.go()
    }
  }

  let index = -1
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Søk"
    >
      <button
        type="button"
        className="absolute inset-0 bg-stone-950/40 backdrop-blur-sm"
        aria-label="Lukk søket"
        onClick={onClose}
      />
      <div className="relative w-full max-w-xl animate-in overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-stone-200">
        <div className="flex items-center gap-3 border-b border-stone-200 px-4">
          <Search className="size-5 text-stone-400" aria-hidden />
          <input
            autoFocus
            value={q}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Søk etter personer, selskaper, ekspertise, innlegg …"
            className="h-14 flex-1 bg-transparent text-[15px] text-stone-900 placeholder:text-stone-400 focus:outline-none"
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls="sokeresultater"
            aria-activedescendant={flat[active] ? `res-${flat[active].key}` : undefined}
          />
          <kbd className="rounded-md bg-stone-100 px-1.5 py-0.5 text-[11px] font-medium text-stone-500">
            Esc
          </kbd>
        </div>

        <div id="sokeresultater" role="listbox" className="max-h-[60vh] overflow-y-auto p-2">
          {q.trim().length < 2 ? (
            <div className="px-3 py-8 text-center text-sm text-stone-500">
              Prøv et navn, et selskap, «fundraising» eller «Oslo».
            </div>
          ) : loading && !flat.length ? (
            <div className="px-3 py-8 text-center text-sm text-stone-500">Søker …</div>
          ) : flat.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-stone-500">
              Ingen treff på «{q.trim()}».
            </div>
          ) : (
            sections.map((section) => (
              <div key={section.title} className="mb-1">
                <p className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wider text-stone-400 uppercase">
                  {section.title}
                </p>
                {section.items.map((item) => {
                  index++
                  const i = index
                  return (
                    <button
                      key={item.key}
                      id={`res-${item.key}`}
                      type="button"
                      role="option"
                      aria-selected={i === active}
                      onMouseEnter={() => setActive(i)}
                      onClick={item.go}
                      className={cx(
                        'flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm',
                        i === active ? 'bg-stone-100' : '',
                      )}
                    >
                      {item.render()}
                      {i === active && (
                        <CornerDownLeft className="size-4 text-stone-400" aria-hidden />
                      )}
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
