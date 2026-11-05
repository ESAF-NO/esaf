import type { GifPage, GifResult } from '@esaf/core'
import { LoaderCircle, Search } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { searchGifs } from '#/lib/gifs.functions.ts'
import { useDismiss } from '#/lib/use-dismiss.ts'
import { ErrorText } from './ui.tsx'

const WAIT_MS = 350

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : 'GIF-søket svarer ikke akkurat nå.'

/**
 * Søk etter en GIF. Uten søkeord vises det som er populært nå. Forhåndsvisningene
 * hentes fra GIPHY, uten referrer; den som velger noe, får en kopi lagret hos oss
 * (se `gifs.ts` i @esaf/core). Når GIPHY ikke svarer, vises GIF-er som er lagret
 * hos oss. GIPHY krever at navnet deres står her.
 */
export function GifPicker({
  onPick,
  onClose,
}: {
  onPick: (gif: GifResult) => void
  onClose: () => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState<GifPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Svar på et gammelt søk skal ikke overskrive det nye.
  const latest = useRef(0)
  useDismiss(box, onClose)

  useEffect(() => {
    box.current?.scrollIntoView({ block: 'nearest' })
  }, [])

  useEffect(() => {
    const request = ++latest.current
    const timer = setTimeout(
      () => {
        setLoading(true)
        searchGifs({ data: { q: query, offset: 0 } })
          .then((next) => {
            if (request !== latest.current) return
            setPage(next)
            setError(null)
          })
          .catch((err: unknown) => {
            if (request === latest.current) setError(errorText(err))
          })
          .finally(() => {
            if (request === latest.current) setLoading(false)
          })
      },
      query ? WAIT_MS : 0,
    )
    return () => clearTimeout(timer)
  }, [query])

  async function more() {
    if (!page?.nextOffset || loading) return
    const request = ++latest.current
    setLoading(true)
    try {
      const next = await searchGifs({ data: { q: query, offset: page.nextOffset } })
      if (request !== latest.current) return
      const seen = new Set(page.results.map((g) => g.id))
      setPage({
        results: [...page.results, ...next.results.filter((g) => !seen.has(g.id))],
        nextOffset: next.nextOffset,
        stored: next.stored,
      })
    } catch (err) {
      if (request === latest.current) setError(errorText(err))
    } finally {
      if (request === latest.current) setLoading(false)
    }
  }

  return (
    <div
      ref={box}
      role="dialog"
      aria-label="Finn en GIF"
      className="absolute inset-x-0 top-full z-30 mt-2 animate-in rounded-2xl bg-white p-2 shadow-lift ring-1 ring-stone-200 sm:right-auto sm:w-96"
    >
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400"
          aria-hidden
        />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          // Enter her skal ikke sende kommentaren.
          onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
          maxLength={50}
          autoFocus
          placeholder="Søk etter GIF-er"
          aria-label="Søk etter GIF-er"
          className="h-9 w-full rounded-lg bg-stone-100 pr-3 pl-9 text-sm text-stone-900 placeholder:text-stone-500 focus:ring-2 focus:ring-brand-500 focus:outline-none"
        />
      </div>
      <div className="mt-2 h-72 overflow-y-auto" aria-busy={loading}>
        {error && <ErrorText>{error}</ErrorText>}
        {page?.stored && page.results.length > 0 && (
          <p className="px-1 pb-2 text-xs text-stone-500">
            GIF-søket er opptatt akkurat nå. Her er GIF-er som er brukt på ESAF.
          </p>
        )}
        {page && page.results.length > 0 && (
          <ul className="columns-2 gap-1.5">
            {page.results.map((gif) => (
              <li key={gif.id} className="mb-1.5 break-inside-avoid">
                <button
                  type="button"
                  onClick={() => onPick(gif)}
                  aria-label={gif.title}
                  title={gif.title}
                  className="block w-full overflow-hidden rounded-lg bg-stone-100 transition hover:opacity-85 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none"
                >
                  <img
                    src={gif.preview.url}
                    alt=""
                    width={gif.preview.width}
                    height={gif.preview.height}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="h-auto w-full"
                  />
                </button>
              </li>
            ))}
          </ul>
        )}
        {page && !page.results.length && !loading && !error && (
          <p className="px-2 py-8 text-center text-sm text-stone-500">
            {page.stored
              ? 'GIF-søket er opptatt akkurat nå, og ingen lagrede GIF-er passer. Prøv igjen om litt, eller last opp en GIF.'
              : 'Ingen GIF-er på det søket.'}
          </p>
        )}
        {loading && (
          <p className="grid place-items-center py-6 text-stone-400">
            <LoaderCircle className="size-5 animate-spin" aria-label="Søker …" />
          </p>
        )}
        {page?.nextOffset && !loading && (
          <button
            type="button"
            onClick={() => void more()}
            className="w-full rounded-lg py-2 text-sm font-medium text-stone-600 transition hover:bg-stone-100 hover:text-stone-900"
          >
            Vis flere
          </button>
        )}
      </div>
      <p className="pt-1.5 text-right text-[11px] text-stone-400">Powered by GIPHY</p>
    </div>
  )
}
