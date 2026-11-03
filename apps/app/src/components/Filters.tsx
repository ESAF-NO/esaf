import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { cx } from '#/components/ui.tsx'

/**
 * Felles byggeklosser for filtrene på Selskaper og Personer: faner for hva som
 * vises, av/på-knapper, og en linje med antall treff og «Nullstill».
 */

export type Tally = { label: string; n: number }

/**
 * Teller verdier på tvers av elementer, uten å skille på store og små bokstaver
 * (skrivemåten varierer). Den første skrivemåten vises; mest brukt først.
 */
export function tally<T>(items: readonly T[], values: (item: T) => readonly (string | null)[]) {
  const counts = new Map<string, Tally>()
  for (const item of items) {
    const seen = new Set<string>()
    for (const value of values(item)) {
      const label = value?.trim()
      if (!label) continue
      const key = label.toLocaleLowerCase('nb')
      if (seen.has(key)) continue
      seen.add(key)
      counts.set(key, { label: counts.get(key)?.label ?? label, n: (counts.get(key)?.n ?? 0) + 1 })
    }
  }
  return [...counts.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label, 'nb'))
}

export const sameText = (a: string | null | undefined, b: string) =>
  !!a && a.trim().toLocaleLowerCase('nb') === b.trim().toLocaleLowerCase('nb')

/** Faner som velger utvalget, med antall i hver. */
export function Segmented<V extends string | undefined>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: readonly { value: V; label: string; count?: number }[]
  value: V
  onChange: (value: V) => void
}) {
  return (
    <div
      className="inline-flex max-w-full shrink-0 self-start overflow-x-auto rounded-xl bg-stone-200/60 p-1"
      role="radiogroup"
      aria-label={label}
    >
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.label}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cx(
              'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-medium whitespace-nowrap transition',
              active
                ? 'bg-white text-stone-950 shadow-card'
                : 'text-stone-600 hover:text-stone-900',
            )}
          >
            {o.label}
            {o.count !== undefined && (
              <span
                className={cx('text-xs tabular-nums', active ? 'text-stone-500' : 'text-stone-400')}
              >
                {o.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/** Av/på-filter, som «Gründere» eller «Verifiserte». */
export function ToggleChip({
  pressed,
  onToggle,
  children,
}: {
  pressed: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onToggle}
      className={cx(
        'inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-medium shadow-card ring-1 transition ring-inset',
        pressed
          ? 'bg-brand-50 text-brand-700 ring-brand-200'
          : 'bg-white text-stone-700 ring-stone-200 hover:ring-stone-300',
      )}
    >
      {children}
    </button>
  )
}

/** Antall treff, og «Nullstill» når noe er filtrert. */
export function FilterSummary({
  children,
  onReset,
  extra,
}: {
  children: ReactNode
  onReset?: () => void
  extra?: ReactNode
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <p className="flex items-center gap-3 text-sm text-stone-500" aria-live="polite">
        {children}
        {onReset && (
          <button
            type="button"
            onClick={onReset}
            className="inline-flex items-center gap-1 font-medium text-stone-700 hover:text-brand-600"
          >
            <X className="size-3.5" aria-hidden /> Nullstill filtre
          </button>
        )}
      </p>
      {extra}
    </div>
  )
}
