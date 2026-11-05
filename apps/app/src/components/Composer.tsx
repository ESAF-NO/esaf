import {
  AtSign,
  Bold,
  Code,
  Eye,
  Italic,
  Link2,
  List,
  Paperclip,
  PenLine,
  Quote,
  type LucideIcon,
} from 'lucide-react'
import {
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { ATTACHMENT_ACCEPT, MAX_ATTACHMENTS } from '#/lib/assets.ts'
import { AttachmentEditor, type Attachments } from './Attachments.tsx'
import { Markdown } from './Markdown.tsx'
import { MentionTextarea } from './MentionTextarea.tsx'
import { cx } from './ui.tsx'

const noSubscription = () => () => {}

/** «⌘» på Mac og iPad, ellers «Ctrl+». Serveren tegner «⌘», så siden er lik til den lastes. */
export function useModifierLabel() {
  return useSyncExternalStore(
    noSubscription,
    () => (/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'),
    () => '⌘',
  )
}

/**
 * Skrivefeltet for innlegg og kommentarer: tekst, vedlegg og en verktøylinje i
 * ett kort. Formatering gjøres med knappene eller hurtigtastene (⌘B, ⌘I, ⌘K),
 * så ingen trenger å kunne Markdown; teksten lagres fortsatt som Markdown.
 * @ nevner noen (se `MentionTextarea`), ⌘ + Enter sender, og feltet vokser med
 * teksten. Filer kan slippes og bilder limes inn i skjemaet rundt
 * (`attachments.drop.props`).
 *
 * Med `compact` er feltet én linje til noen begynner å skrive, som
 * kommentarfeltet under et innlegg.
 */
export function Composer({
  id,
  label,
  value,
  onChange,
  placeholder,
  maxLength,
  attachments,
  suggestFirst,
  autoFocus = false,
  compact = false,
  minRows = 3,
  header,
  footer,
  actions,
  onEscape,
  dragging = false,
}: {
  id: string
  /** For skjermlesere; vises ikke. */
  label: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  maxLength: number
  attachments: Attachments
  /** Foreslås først når noen skriver @, for eksempel de som er med i tråden. */
  suggestFirst?: { personId: string }[]
  autoFocus?: boolean
  /** Én linje til feltet får fokus eller har innhold. */
  compact?: boolean
  /** Høyden feltet starter med, i linjer. */
  minRows?: number
  /** Over teksten, i samme kort: tittelen på et innlegg. */
  header?: ReactNode
  /** Under teksten, over verktøylinja: lenken på et innlegg. */
  footer?: ReactNode
  /** Til høyre i verktøylinja: sendeknappen. */
  actions?: ReactNode
  onEscape?: () => void
  /** En fil dras over skjemaet. */
  dragging?: boolean
}) {
  const card = useRef<HTMLDivElement>(null)
  const files = useRef<HTMLInputElement>(null)
  const [focused, setFocused] = useState(autoFocus)
  const [preview, setPreview] = useState(false)
  const field = () => document.getElementById(id) as HTMLTextAreaElement | null
  const hasContent =
    value.trim() !== '' || attachments.items.length > 0 || attachments.pending.length > 0
  const open = !compact || focused || hasContent || preview
  const full = attachments.items.length >= MAX_ATTACHMENTS

  // Feltet vokser med teksten, opp til en grense, og ruller etter det.
  useLayoutEffect(() => {
    const el = field()
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight + 2, 560)}px`
  })

  function onBlur(e: FocusEvent) {
    if (!card.current?.contains(e.relatedTarget as Node | null)) setFocused(false)
  }

  /** Bytter ut det som er markert, som om det ble skrevet, så angre (⌘Z) virker. */
  function replace(
    el: HTMLTextAreaElement,
    start: number,
    end: number,
    text: string,
    select: [number, number],
  ) {
    el.focus()
    el.setSelectionRange(start, end)
    if (!document.execCommand('insertText', false, text)) {
      el.setRangeText(text, start, end, 'end')
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    el.setSelectionRange(start + select[0], start + select[1])
  }

  /** Rundt det markerte: **fet**, _kursiv_, `kode`. Står det der allerede, fjernes det. */
  function wrap(marker: string, empty: string) {
    const el = field()
    if (!el) return
    const { selectionStart: start, selectionEnd: end, value: text } = el
    const selected = text.slice(start, end)
    const before = text.slice(start - marker.length, start)
    const after = text.slice(end, end + marker.length)
    if (selected && before === marker && after === marker) {
      replace(el, start - marker.length, end + marker.length, selected, [0, selected.length])
      return
    }
    const inner = selected || empty
    replace(el, start, end, `${marker}${inner}${marker}`, [
      marker.length,
      marker.length + inner.length,
    ])
  }

  /** Foran hver markerte linje: «- » for liste, «> » for sitat. Står det der på alle, fjernes det. */
  function prefix(mark: string) {
    const el = field()
    if (!el) return
    const text = el.value
    const start = text.lastIndexOf('\n', el.selectionStart - 1) + 1
    const nextBreak = text.indexOf('\n', el.selectionEnd)
    const end = nextBreak === -1 ? text.length : nextBreak
    const lines = text.slice(start, end).split('\n')
    const all = lines.every((l) => l.startsWith(mark))
    const next = lines.map((l) => (all ? l.slice(mark.length) : l ? `${mark}${l}` : mark))
    const joined = next.join('\n')
    // En liste eller et sitat midt i et avsnitt trenger en tom linje foran.
    const gap = !all && start > 0 && text[start - 2] !== undefined && text[start - 2] !== '\n'
    replace(el, start, end, `${gap ? '\n' : ''}${joined}`, [
      joined.length + (gap ? 1 : 0),
      joined.length + (gap ? 1 : 0),
    ])
  }

  function link() {
    const el = field()
    if (!el) return
    const { selectionStart: start, selectionEnd: end, value: text } = el
    const selected = text.slice(start, end)
    if (/^https?:\/\/\S+$/.test(selected)) {
      // En adresse er markert: skriv teksten som skal vises.
      replace(el, start, end, `[](${selected})`, [1, 1])
      return
    }
    const shown = selected || 'lenketekst'
    const url = 'https://'
    const inserted = `[${shown}](${url})`
    // Uten markering velges lenketeksten; med markering velges adressen.
    replace(
      el,
      start,
      end,
      inserted,
      selected ? [shown.length + 3, shown.length + 3 + url.length] : [1, 1 + shown.length],
    )
  }

  function code() {
    const el = field()
    if (!el) return
    const selected = el.value.slice(el.selectionStart, el.selectionEnd)
    if (selected.includes('\n')) {
      replace(el, el.selectionStart, el.selectionEnd, `\`\`\`\n${selected}\n\`\`\``, [
        4,
        4 + selected.length,
      ])
    } else wrap('`', 'kode')
  }

  function mention() {
    const el = field()
    if (!el) return
    const { selectionStart: start, selectionEnd: end, value: text } = el
    const space = start > 0 && !/\s/.test(text[start - 1]!) ? ' ' : ''
    replace(el, start, end, `${space}@`, [space.length + 1, space.length + 1])
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key === 'Enter') {
      e.preventDefault()
      e.currentTarget.form?.requestSubmit()
      return
    }
    if (e.key === 'Escape' && onEscape) {
      e.preventDefault()
      onEscape()
      return
    }
    if (!mod || e.altKey || e.shiftKey) return
    const key = e.key.toLowerCase()
    const action =
      key === 'b'
        ? () => wrap('**', 'fet tekst')
        : key === 'i'
          ? () => wrap('_', 'kursiv')
          : key === 'k'
            ? link
            : null
    if (!action) return
    e.preventDefault()
    // ⌘K åpner ellers søket.
    e.stopPropagation()
    action()
  }

  const mod = useModifierLabel()

  const tools: { label: string; icon: LucideIcon; run: () => void; keys?: string }[][] = [
    [
      { label: 'Fet', icon: Bold, run: () => wrap('**', 'fet tekst'), keys: `${mod}B` },
      { label: 'Kursiv', icon: Italic, run: () => wrap('_', 'kursiv'), keys: `${mod}I` },
      { label: 'Lenke', icon: Link2, run: link, keys: `${mod}K` },
    ],
    [
      { label: 'Punktliste', icon: List, run: () => prefix('- ') },
      { label: 'Sitat', icon: Quote, run: () => prefix('> ') },
      { label: 'Kode', icon: Code, run: code },
    ],
    [{ label: 'Nevn noen', icon: AtSign, run: mention }],
  ]

  const toolButton =
    'grid size-8 place-items-center rounded-lg text-stone-500 transition hover:bg-stone-100 hover:text-stone-900 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40'
  const remaining = maxLength - value.length

  return (
    <div
      ref={card}
      onFocus={() => setFocused(true)}
      onBlur={onBlur}
      className={cx(
        'rounded-2xl bg-white shadow-card ring-1 transition',
        dragging
          ? 'ring-2 ring-brand-400'
          : focused
            ? 'ring-stone-300 shadow-lift'
            : 'ring-stone-200/80 hover:ring-stone-300',
      )}
    >
      {header}
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <MentionTextarea
        bare
        id={id}
        value={value}
        onValueChange={onChange}
        suggestFirst={suggestFirst}
        hidden={preview}
        placeholder={placeholder}
        maxLength={maxLength}
        autoFocus={autoFocus}
        rows={open ? minRows : 1}
        onKeyDown={onKeyDown}
        noteClassName="px-4"
        className={cx(
          'block w-full resize-none border-0 bg-transparent px-4 text-[15px] leading-relaxed text-stone-900 placeholder:text-stone-400 focus:ring-0 focus:outline-none',
          open ? 'py-3' : 'py-2.5',
        )}
      />
      {preview && (
        <div
          className="min-h-24 px-4 py-3 text-[15px] leading-relaxed text-stone-700"
          aria-label="Forhåndsvisning"
          role="region"
        >
          {value.trim() ? (
            <Markdown>{value}</Markdown>
          ) : (
            <p className="text-stone-400">Ingenting å forhåndsvise ennå.</p>
          )}
        </div>
      )}
      {(attachments.items.length > 0 ||
        attachments.pending.length > 0 ||
        attachments.error !== null) && (
        <div className="px-4 pb-3">
          <AttachmentEditor attachments={attachments} button={false} />
        </div>
      )}
      {open && footer}
      {open && (
        <div className="flex items-center gap-1 border-t border-stone-100 px-2 py-1.5">
          <div role="toolbar" aria-label="Formatering" className="flex min-w-0 items-center">
            {tools.map((group, g) => (
              <div
                key={g}
                className={cx(
                  'flex items-center',
                  g > 0 && 'ml-1 border-l border-stone-200 pl-1',
                  // På smale skjermer er det plass til det viktigste.
                  g === 1 && 'hidden sm:flex',
                )}
              >
                {group.map((t) => (
                  <button
                    key={t.label}
                    type="button"
                    disabled={preview}
                    // Markeringen i feltet skal bestå når noen klikker.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={t.run}
                    className={toolButton}
                    aria-label={t.keys ? `${t.label} (${t.keys})` : t.label}
                    title={t.keys ? `${t.label} (${t.keys})` : t.label}
                  >
                    <t.icon className="size-4" aria-hidden />
                  </button>
                ))}
              </div>
            ))}
            <div className="ml-1 flex items-center border-l border-stone-200 pl-1">
              <button
                type="button"
                onClick={() => files.current?.click()}
                disabled={full}
                className={toolButton}
                aria-label="Legg ved bilde eller fil"
                title={
                  full
                    ? `Maks ${MAX_ATTACHMENTS} vedlegg`
                    : 'Legg ved bilde eller fil (eller dra den hit, eller lim inn et bilde)'
                }
              >
                <Paperclip className="size-4" aria-hidden />
              </button>
              <input
                ref={files}
                type="file"
                accept={ATTACHMENT_ACCEPT}
                multiple
                hidden
                onChange={(e) => {
                  const picked = [...(e.target.files ?? [])]
                  // Tømmes, så samme fil kan velges igjen etter en feil.
                  e.target.value = ''
                  if (picked.length) attachments.add(picked)
                }}
              />
              <button
                type="button"
                onClick={() => {
                  setPreview((p) => !p)
                  // Tilbake til skrivefeltet: fortsett der du slapp.
                  if (preview) setTimeout(() => field()?.focus())
                }}
                aria-pressed={preview}
                className={cx(toolButton, preview && 'bg-stone-100 text-stone-900')}
                aria-label={preview ? 'Tilbake til skrivingen' : 'Forhåndsvis'}
                title={preview ? 'Tilbake til skrivingen' : 'Forhåndsvis'}
              >
                {preview ? (
                  <PenLine className="size-4" aria-hidden />
                ) : (
                  <Eye className="size-4" aria-hidden />
                )}
              </button>
            </div>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-3 pl-2">
            {remaining < 500 && (
              <span
                className={cx(
                  'text-xs tabular-nums',
                  remaining < 0 ? 'text-red-700' : 'text-stone-400',
                )}
              >
                {remaining}
              </span>
            )}
            {actions && (
              <span className="hidden text-xs text-stone-400 md:inline" aria-hidden>
                {mod}↵ for å sende
              </span>
            )}
            {actions}
          </div>
        </div>
      )}
    </div>
  )
}
