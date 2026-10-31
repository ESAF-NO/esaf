import type { CompanyLogoUrls } from '@esaf/core'
import { Check, Plus } from 'lucide-react'
import { useEffect, useId, useState, type KeyboardEvent } from 'react'
import { findCompanies } from '#/lib/companies.functions.ts'
import { CompanyLogo, cx, Input } from './ui.tsx'

type Hit = Awaited<ReturnType<typeof findCompanies>>[number]
type Option = { kind: 'company'; hit: Hit } | { kind: 'new' }

/**
 * Navnet i feltet, og selskapet det er koblet til hvis det ble valgt i listen.
 * `logo` følger med et valgt selskap, så den kan vises ved feltet.
 */
export type CompanyValue = {
  name: string
  companyId: string | null
  logo?: CompanyLogoUrls | null
}

/**
 * Selskapsfelt med forslag fra selskapene som finnes, etter WAI-ARIAs
 * combobox-mønster. Et valgt forslag kobler erfaringen til det selskapet. Et nytt
 * navn blir et nytt selskap når skjemaet lagres, men serveren kobler likevel
 * navn med samme slug («kahoot» og «Kahoot!») til selskapet som finnes.
 */
export function CompanyInput({
  label,
  value,
  onChange,
  placeholder,
  autoFocus,
  allowNew = true,
  excludeId,
  className,
}: {
  label: string
  value: CompanyValue
  onChange: (value: CompanyValue) => void
  placeholder?: string
  autoFocus?: boolean
  /** Tilby «Nytt selskap» når ingen av forslagene er samme selskap. */
  allowNew?: boolean
  /** Et selskap som ikke skal foreslås, for eksempel det man slår sammen med. */
  excludeId?: string
  className?: string
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [hits, setHits] = useState<Hit[]>([])
  const [active, setActive] = useState(-1)
  const term = value.name.trim()

  useEffect(() => {
    if (!open || !term) return
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const found = await findCompanies({ data: { q: term } })
        if (!cancelled) {
          setHits(found.filter((h) => h.id !== excludeId))
          setActive(-1)
        }
      } catch {
        if (!cancelled) setHits([])
      }
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [term, open, excludeId])

  const options: Option[] = [
    ...hits.map((hit) => ({ kind: 'company' as const, hit })),
    ...(allowNew && !hits.some((h) => h.exact) ? [{ kind: 'new' as const }] : []),
  ]
  const expanded = open && term !== '' && options.length > 0
  const optionId = (i: number) => `${id}-valg-${i}`

  function choose(option: Option | undefined) {
    if (option?.kind === 'company') {
      onChange({ name: option.hit.name, companyId: option.hit.id, logo: option.hit.logo })
    }
    setOpen(false)
    setActive(-1)
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!expanded) {
        setOpen(true)
        return
      }
      const last = options.length - 1
      setActive((i) => (e.key === 'ArrowDown' ? (i >= last ? 0 : i + 1) : i <= 0 ? last : i - 1))
    } else if (e.key === 'Enter' && expanded && active >= 0) {
      // Velger forslaget i stedet for å sende skjemaet.
      e.preventDefault()
      choose(options[active])
    } else if (e.key === 'Escape' && expanded) {
      e.preventDefault()
      setOpen(false)
    }
  }

  // Etiketten står for seg selv, så forslagslisten ikke blir en del av feltets navn.
  return (
    <div className={cx('space-y-1.5', className)}>
      <label htmlFor={`${id}-felt`} className="block text-sm font-medium text-stone-800">
        {label}
      </label>
      <div className="relative">
        <Input
          id={`${id}-felt`}
          value={value.name}
          onChange={(e) => {
            onChange({ name: e.target.value, companyId: null })
            setOpen(true)
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setOpen(false)}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={`${id}-liste`}
          aria-activedescendant={expanded && active >= 0 ? optionId(active) : undefined}
          autoComplete="off"
          maxLength={120}
          placeholder={placeholder}
          autoFocus={autoFocus}
        />
        {expanded && (
          <ul
            id={`${id}-liste`}
            role="listbox"
            aria-label={label}
            className="absolute inset-x-0 top-full z-30 mt-1 max-h-72 animate-in overflow-y-auto rounded-xl bg-white p-1 shadow-lift ring-1 ring-stone-200"
          >
            {options.map((option, i) => (
              <li
                key={option.kind === 'company' ? option.hit.id : 'nytt'}
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                // Beholder fokus i feltet, så klikket rekker fram før listen lukkes.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(option)}
                className={cx(
                  'flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm',
                  i === active && 'bg-stone-100',
                )}
              >
                {option.kind === 'company' ? (
                  <>
                    <CompanyLogo name={option.hit.name} logo={option.hit.logo} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-stone-900">
                        {option.hit.name}
                      </span>
                      <span className="block truncate text-xs text-stone-500">
                        {[
                          option.hit.formerNames.length
                            ? `Tidligere ${option.hit.formerNames.join(', ')}`
                            : null,
                          option.hit.tagline,
                          option.hit.people ? `${option.hit.people} fra ES` : null,
                        ]
                          .filter(Boolean)
                          .join(' · ') || 'Ingen fra ES ennå'}
                      </span>
                    </span>
                    {option.hit.id === value.companyId && (
                      <Check className="size-4 shrink-0 text-brand-600" aria-hidden />
                    )}
                  </>
                ) : (
                  <>
                    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-stone-100 text-stone-500">
                      <Plus className="size-4" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-stone-600">
                      Nytt selskap: <span className="font-medium text-stone-900">{term}</span>
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
