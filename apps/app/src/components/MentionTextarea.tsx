import type { MentionCandidate } from '@esaf/core'
import { useRouteContext } from '@tanstack/react-router'
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ComponentProps,
  type KeyboardEvent,
} from 'react'
import { caretCoordinates } from '#/lib/caret.ts'
import { kull } from '#/lib/format.ts'
import {
  applyEdit,
  insertMention,
  matchPeople,
  mentionedPeople,
  mentionQuery,
  plainText,
} from '#/lib/mentions.ts'
import { fetchMentionable } from '#/lib/notifications.functions.ts'
import { Avatar, cx, Textarea } from './ui.tsx'

const FRESH_FOR_MS = 5 * 60_000
let directory: {
  at: number
  request: Promise<MentionCandidate[]>
  people?: MentionCandidate[]
} | null = null

/** Alle som kan nevnes. Hentes første gang noen skriver @, og gjenbrukes en stund. */
function loadPeople() {
  if (!directory || Date.now() - directory.at > FRESH_FOR_MS) {
    const entry: NonNullable<typeof directory> = { at: Date.now(), request: fetchMentionable() }
    directory = entry
    entry.request.then(
      (people) => (entry.people = people),
      () => {
        if (directory === entry) directory = null
      },
    )
  }
  return directory.request
}

const names = new Intl.ListFormat('nb', { type: 'conjunction' })

type Props = Omit<ComponentProps<'textarea'>, 'value' | 'defaultValue' | 'onChange'> & {
  /** Teksten med omtaler, slik den sendes til serveren. */
  value: string
  onValueChange: (value: string) => void
  /** Foreslås først og når det bare står @, for eksempel de som er med i tråden. */
  suggestFirst?: { personId: string }[]
  /** Uten egen ramme og bakgrunn, inne i en `Composer`. */
  bare?: boolean
  /** Plassering av «Varsler …» under feltet. */
  noteClassName?: string
}

/**
 * Tekstfelt der @ åpner en liste med medlemmer. Feltet viser «@Kari Nordmann»,
 * mens verdien har hele omtalen med id, så den peker på riktig person. Lista
 * styres med piltastene, Enter eller Tab velger og Esc lukker. Markøren blir i
 * feltet hele tiden.
 */
export function MentionTextarea({
  value,
  onValueChange,
  suggestFirst = [],
  onKeyDown,
  onFocus,
  onBlur,
  onScroll,
  bare = false,
  noteClassName,
  ...props
}: Props) {
  const Field = bare ? 'textarea' : Textarea
  const { viewer } = useRouteContext({ from: '__root__' })
  const field = useRef<HTMLTextAreaElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const pendingCaret = useRef<number | null>(null)
  const id = useId()
  const [caret, setCaret] = useState<number | null>(null)
  const [people, setPeople] = useState(() => directory?.people ?? null)
  const [failed, setFailed] = useState(false)
  const [dismissed, setDismissed] = useState<number | null>(null)
  const [active, setActive] = useState({ key: '', index: 0 })

  const trigger = caret === null ? null : mentionQuery(value, caret)
  const key = trigger ? `${trigger.start}:${trigger.query}` : ''
  const preferred = [...new Set(suggestFirst.map((p) => p.personId))]
  const options =
    !trigger || !people
      ? []
      : trigger.query
        ? matchPeople(people, trigger.query, preferred)
        : preferred.flatMap((pid) => people.find((p) => p.personId === pid) ?? []).slice(0, 6)
  // Med mellomrom og ingen treff skriver personen trolig videre, ikke et navn.
  const open =
    trigger !== null &&
    trigger.start !== dismissed &&
    (options.length > 0 || !trigger.query.includes(' '))
  const index = active.key === key ? Math.min(active.index, options.length - 1) : 0

  const status = !open
    ? ''
    : failed
      ? 'Fikk ikke hentet medlemmene. Prøv igjen.'
      : !people
        ? 'Henter medlemmer …'
        : options.length
          ? `${options.length === 1 ? 'Ett forslag' : `${options.length} forslag`}. Velg med piltastene og Enter.`
          : trigger.query
            ? 'Ingen medlemmer med det navnet.'
            : 'Skriv navnet til den du vil nevne.'
  const mentioned = mentionedPeople(value).filter((p) => p.personId !== viewer.personId)

  /** Plasserer lista under @-en. Måles i DOM-en, så den flyttes direkte, ikke via state. */
  function place() {
    const el = field.current
    const box = popup.current
    if (!el || !box || !trigger) return
    const at = caretCoordinates(el, trigger.start)
    const top = at.top - el.scrollTop + at.lineHeight + 4
    box.style.top = `${Math.min(Math.max(top, 0), el.offsetHeight + 4)}px`
    box.style.left = `${Math.max(0, Math.min(at.left - el.scrollLeft, el.offsetWidth - box.offsetWidth))}px`
  }

  useLayoutEffect(() => {
    const el = field.current
    if (el && pendingCaret.current !== null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current)
      pendingCaret.current = null
    }
    if (open) place()
  })

  /** Følger markøren, og henter medlemmene når en omtale begynner. */
  function track(el: HTMLTextAreaElement, markup: string) {
    const position = el.selectionStart === el.selectionEnd ? el.selectionEnd : null
    setCaret(position)
    const next = position === null ? null : mentionQuery(markup, position)
    if (dismissed !== null && next?.start !== dismissed) setDismissed(null)
    if (next && next.start !== trigger?.start) {
      setFailed(false)
      loadPeople().then(setPeople, () => setFailed(true))
    }
  }

  function choose(person: MentionCandidate) {
    if (!trigger || caret === null) return
    const next = insertMention(value, trigger.start, caret, {
      personId: person.personId,
      name: person.fullName,
    })
    pendingCaret.current = next.caret
    setCaret(next.caret)
    onValueChange(next.markup)
  }

  function handleChange(e: ChangeEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget
    const next = applyEdit(value, el.value, el.selectionEnd)
    onValueChange(next)
    track(el, next)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    const bare = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
    if (open && trigger && bare && !e.nativeEvent.isComposing) {
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && options.length) {
        e.preventDefault()
        const step = e.key === 'ArrowDown' ? 1 : -1
        setActive({ key, index: (index + step + options.length) % options.length })
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && options[index]) {
        e.preventDefault()
        choose(options[index])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setDismissed(trigger.start)
        return
      }
    }
    onKeyDown?.(e)
  }

  return (
    <div>
      <div className="relative">
        <Field
          {...props}
          ref={field}
          value={plainText(value)}
          onChange={handleChange}
          onSelect={(e) => track(e.currentTarget, value)}
          onFocus={(e) => {
            track(e.currentTarget, value)
            onFocus?.(e)
          }}
          onBlur={(e) => {
            setCaret(null)
            onBlur?.(e)
          }}
          onKeyDown={handleKeyDown}
          onScroll={(e) => {
            place()
            onScroll?.(e)
          }}
          aria-autocomplete="list"
          aria-controls={open ? `${id}-forslag` : undefined}
          aria-activedescendant={open && options[index] ? `${id}-${index}` : undefined}
        />
        {open && (
          <div
            ref={popup}
            className="absolute z-30 w-72 max-w-full animate-in overflow-hidden rounded-xl bg-white p-1 shadow-lift ring-1 ring-stone-200"
          >
            <ul id={`${id}-forslag`} role="listbox" aria-label="Medlemmer du kan nevne">
              {options.map((p, i) => (
                <li
                  key={p.personId}
                  id={`${id}-${i}`}
                  role="option"
                  aria-selected={i === index}
                  // Markøren skal bli i feltet når noen klikker i lista.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(p)}
                  onMouseMove={() => i !== index && setActive({ key, index: i })}
                  className={cx(
                    'flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm',
                    i === index && 'bg-stone-100',
                  )}
                >
                  <Avatar name={p.fullName} size="xs" />
                  <span className="min-w-0 flex-1 truncate font-medium text-stone-900">
                    {p.fullName}
                  </span>
                  {p.cohortYears.length > 0 && (
                    <span className="shrink-0 text-xs text-stone-400">{kull(p.cohortYears)}</span>
                  )}
                </li>
              ))}
            </ul>
            {!options.length && <p className="px-2.5 py-1.5 text-sm text-stone-500">{status}</p>}
          </div>
        )}
      </div>
      <p className="sr-only" role="status">
        {status}
      </p>
      <p
        aria-live="polite"
        className={cx('text-xs text-stone-500', mentioned.length > 0 && 'mt-1.5', noteClassName)}
      >
        {mentioned.length > 0 && `Varsler ${names.format(mentioned.map((p) => p.name))}.`}
      </p>
    </div>
  )
}
