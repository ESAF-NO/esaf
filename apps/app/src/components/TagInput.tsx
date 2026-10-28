import { Plus, X } from 'lucide-react'
import { useId, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { cx } from './ui.tsx'

const MAX_LENGTH = 40
const same = (a: string, b: string) => a.toLocaleLowerCase('nb') === b.toLocaleLowerCase('nb')

/**
 * Stikkord som brikker: skriv og trykk Enter eller komma, Backspace fjerner
 * det siste. Forslagene under kan klikkes inn.
 */
export function TagInput({
  label,
  value,
  onChange,
  suggestions = [],
  placeholder,
  max = 10,
}: {
  label: string
  value: string[]
  onChange: (tags: string[]) => void
  suggestions?: readonly string[]
  placeholder?: string
  max?: number
}) {
  const [draft, setDraft] = useState('')
  const id = useId()
  const full = value.length >= max

  function add(raw: string[]) {
    const next = [...value]
    for (const part of raw) {
      const tag = part.trim().replace(/\s+/g, ' ')
      if (tag && tag.length <= MAX_LENGTH && next.length < max && !next.some((t) => same(t, tag))) {
        next.push(tag)
      }
    }
    if (next.length !== value.length) onChange(next)
    setDraft('')
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      add([draft])
    } else if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1))
    }
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData('text')
    if (/[,;\n]/.test(text)) {
      e.preventDefault()
      add(text.split(/[,;\n]+/))
    }
  }

  const term = draft.trim().toLocaleLowerCase('nb')
  const open = suggestions
    .filter((s) => !value.some((t) => same(t, s)) && s.toLocaleLowerCase('nb').includes(term))
    .slice(0, 8)

  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium text-stone-800">
        {label}
      </label>
      <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg bg-white px-2 py-1.5 shadow-card ring-1 ring-stone-200 transition ring-inset focus-within:ring-2 focus-within:ring-brand-500">
        {value.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-md bg-stone-100 py-0.5 pr-1 pl-2 text-sm font-medium text-stone-800"
          >
            {tag}
            <button
              type="button"
              onClick={() => onChange(value.filter((t) => t !== tag))}
              className="grid size-5 place-items-center rounded text-stone-400 hover:bg-stone-200 hover:text-stone-700"
              aria-label={`Fjern ${tag}`}
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </span>
        ))}
        <input
          id={id}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => draft.trim() && add([draft])}
          disabled={full}
          maxLength={MAX_LENGTH}
          placeholder={full ? `Maks ${max}` : value.length ? 'Legg til flere' : placeholder}
          className="h-7 min-w-32 flex-1 border-0 bg-transparent px-1 text-sm text-stone-900 placeholder:text-stone-400 focus:outline-none disabled:cursor-not-allowed"
        />
      </div>
      {!full && open.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Forslag">
          {open.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => add([s])}
              className={cx(
                'inline-flex items-center gap-1 rounded-full bg-white px-2.5 py-1 text-xs font-medium text-stone-600 ring-1 ring-stone-200 transition ring-inset',
                'hover:bg-stone-900 hover:text-white hover:ring-stone-900',
              )}
            >
              <Plus className="size-3" aria-hidden /> {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
