import { Link } from '@tanstack/react-router'
import { Check } from 'lucide-react'
import type { ReactNode } from 'react'
import { cx, Logo } from './ui.tsx'

/** Myk glød øverst, felles for forsiden og alle sidene på veien inn. */
export function Glow({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cx('pointer-events-none absolute inset-x-0 top-0 -z-10', className)}
    >
      <div className="mx-auto h-[520px] max-w-5xl bg-[radial-gradient(50%_60%_at_50%_0%,rgb(249_115_22/0.16),transparent)]" />
    </div>
  )
}

/**
 * Rammen rundt innlogging, registrering og stegene før man er godkjent:
 * logo, en lenke til høyre og innholdet i midten.
 */
export function AuthShell({
  children,
  action,
  wide = false,
}: {
  children: ReactNode
  action?: ReactNode
  wide?: boolean
}) {
  return (
    <div className="relative isolate min-h-dvh overflow-hidden bg-stone-50">
      <Glow />
      <header className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:h-20 sm:px-8">
        <Link to="/" aria-label="ESAF, til forsiden">
          <Logo />
        </Link>
        {action}
      </header>
      <main
        id="innhold"
        className={cx('mx-auto w-full px-5 pt-4 pb-20 sm:pt-10', wide ? 'max-w-xl' : 'max-w-md')}
      >
        {children}
      </main>
    </div>
  )
}

export function AuthCard({
  eyebrow,
  title,
  subtitle,
  children,
  footer,
}: {
  eyebrow?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <>
      <div className="rounded-3xl bg-white p-6 shadow-[0_1px_2px_rgb(28_25_23/0.04),0_12px_40px_-12px_rgb(28_25_23/0.12)] ring-1 ring-stone-200/70 sm:p-8">
        {eyebrow && <p className="mb-3 text-xs font-semibold text-brand-600">{eyebrow}</p>}
        <h1 className="text-2xl font-semibold tracking-tight text-balance text-stone-950">
          {title}
        </h1>
        {subtitle && <div className="mt-2 text-sm leading-relaxed text-stone-500">{subtitle}</div>}
        <div className="mt-7">{children}</div>
      </div>
      {footer && <div className="mt-6 text-center text-sm text-stone-500">{footer}</div>}
    </>
  )
}

const steps = ['Opprett konto', 'Bekreft e-post', 'Hvem er du?', 'Godkjenning']

/** Hvor man er på veien inn. `current` er steget man står på (0–3). */
export function AccessSteps({ current, className }: { current: number; className?: string }) {
  return (
    <ol className={cx('grid grid-cols-4 gap-2', className)} aria-label="Veien inn">
      {steps.map((label, i) => {
        const done = i < current
        const active = i === current
        return (
          <li key={label} aria-current={active ? 'step' : undefined} className="min-w-0">
            <div
              className={cx(
                'h-1 rounded-full',
                done ? 'bg-brand-500' : active ? 'bg-brand-300' : 'bg-stone-200',
              )}
            />
            <p
              className={cx(
                'mt-2 flex items-center gap-1 text-[11px] leading-tight font-medium sm:text-xs',
                done ? 'text-stone-500' : active ? 'text-stone-950' : 'text-stone-400',
              )}
            >
              {done && <Check className="size-3 shrink-0 text-brand-600" aria-hidden />}
              <span className="truncate">{label}</span>
            </p>
          </li>
        )
      })}
    </ol>
  )
}
