import { useState, type ComponentProps } from 'react'
import { Markdown } from './Markdown.tsx'
import { MentionTextarea } from './MentionTextarea.tsx'
import { cx } from './ui.tsx'

/** Én linje med det viktigste av Markdown, under skrivefeltet. */
export function MarkdownHint({ className }: { className?: string }) {
  const syntax = 'font-mono text-[11px] text-stone-600'
  return (
    <p className={cx('truncate text-xs text-stone-500', className)}>
      <span className={syntax}>**fet**</span> <span className={syntax}>_kursiv_</span>{' '}
      <span className={syntax}>[lenke](https://…)</span> <span className={syntax}>`kode`</span>
      <span className="hidden sm:inline">
        {' '}
        <span className={syntax}>- liste</span> <span className={syntax}>&gt; sitat</span>
      </span>
    </p>
  )
}

/**
 * Skrivefelt for Markdown med forhåndsvisning og @omtaler (se `MentionTextarea`). Feltet blir værende i dokumentet
 * mens forhåndsvisningen vises, så angre-historikk og markørposisjon består, og
 * `name` følger med i skjemaet.
 */
export function MarkdownEditor({
  id,
  label,
  showLabel = true,
  value,
  onChange,
  hint = true,
  suggestFirst,
  className,
  ...textarea
}: Omit<ComponentProps<'textarea'>, 'id' | 'value' | 'defaultValue' | 'onChange' | 'ref'> & {
  id: string
  label: string
  /** Kommentarfeltet har ingen synlig etikett, bare for skjermlesere. */
  showLabel?: boolean
  value: string
  onChange: (value: string) => void
  /** Vis formateringshjelpen under feltet. Slå av for å plassere `MarkdownHint` selv. */
  hint?: boolean
  /** Foreslås først når noen skriver @, for eksempel de som er med i tråden. */
  suggestFirst?: { personId: string }[]
}) {
  const [preview, setPreview] = useState(false)

  const tab = (isPreview: boolean, text: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={preview === isPreview}
      aria-controls={isPreview ? `${id}-forhandsvisning` : id}
      onClick={() => {
        setPreview(isPreview)
        // Tilbake til skrivefeltet: fortsett der du slapp.
        if (!isPreview) setTimeout(() => document.getElementById(id)?.focus())
      }}
      className={cx(
        'h-6 rounded-md px-2 text-xs font-medium transition',
        preview === isPreview
          ? 'bg-white text-stone-900 shadow-card'
          : 'text-stone-500 hover:text-stone-900',
      )}
    >
      {text}
    </button>
  )

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <label
          htmlFor={id}
          className={showLabel ? 'text-sm font-medium text-stone-800' : 'sr-only'}
        >
          {label}
        </label>
        <div role="tablist" aria-label="Visning" className="flex rounded-lg bg-stone-200/60 p-0.5">
          {tab(false, 'Skriv')}
          {tab(true, 'Forhåndsvis')}
        </div>
      </div>
      <MentionTextarea
        id={id}
        value={value}
        onValueChange={onChange}
        suggestFirst={suggestFirst}
        hidden={preview}
        className={className}
        {...textarea}
      />
      {preview && (
        <div
          id={`${id}-forhandsvisning`}
          role="tabpanel"
          aria-label="Forhåndsvisning"
          className={cx(
            // Samme mål som skrivefeltet, så ingenting hopper når du bytter.
            'min-h-28 rounded-lg bg-white px-3 py-2.5 text-sm leading-relaxed text-stone-700 shadow-card ring-1 ring-stone-200 ring-inset',
            className,
          )}
        >
          {value.trim() ? (
            <Markdown>{value}</Markdown>
          ) : (
            <p className="text-stone-400">Ingenting å forhåndsvise ennå.</p>
          )}
        </div>
      )}
      {hint && <MarkdownHint />}
    </div>
  )
}
