import type { ProfilePhoto } from '@esaf/core'
import { clsx } from 'clsx'
import { BadgeCheck } from 'lucide-react'
import { useState, type ComponentProps, type ReactNode } from 'react'
import { channels, type ChannelKey } from '#/lib/channels.ts'

export { clsx as cx }

const buttonBase =
  'inline-flex items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50'
const buttonVariants = {
  primary: 'bg-stone-900 text-white shadow-sm hover:bg-stone-800',
  brand: 'bg-brand-600 text-white shadow-sm shadow-brand-600/20 hover:bg-brand-700',
  secondary:
    'bg-white text-stone-800 shadow-card ring-1 ring-stone-200 hover:bg-stone-50 hover:ring-stone-300',
  ghost: 'text-stone-600 hover:bg-stone-100 hover:text-stone-900',
  danger: 'text-red-700 hover:bg-red-50',
  /** Bekrefter noe som er vanskelig å angre, som å deaktivere et medlem. */
  destructive: 'bg-red-600 text-white shadow-sm hover:bg-red-700',
}
const buttonSizes = { sm: 'h-8 px-3 text-sm', md: 'h-10 px-4 text-sm', lg: 'h-12 px-6 text-base' }

export type ButtonStyle = { variant?: keyof typeof buttonVariants; size?: keyof typeof buttonSizes }

export const buttonClass = (
  { variant = 'primary', size = 'md' }: ButtonStyle = {},
  extra?: string,
) => clsx(buttonBase, buttonVariants[variant], buttonSizes[size], extra)

export function Button({
  variant,
  size,
  className,
  ...props
}: ComponentProps<'button'> & ButtonStyle) {
  return <button type="button" className={buttonClass({ variant, size }, className)} {...props} />
}

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={clsx('rounded-2xl bg-white shadow-card ring-1 ring-stone-200/70', className)}
      {...props}
    />
  )
}

export function ChannelBadge({ channel, className }: { channel: ChannelKey; className?: string }) {
  const c = channels[channel]
  const Icon = c.icon
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        c.tone,
        className,
      )}
    >
      <Icon className="size-3" aria-hidden />
      {c.label}
    </span>
  )
}

export function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full bg-stone-100 px-2.5 py-0.5 text-xs font-medium text-stone-700',
        className,
      )}
    >
      {children}
    </span>
  )
}

const gradients = [
  'from-orange-400 to-rose-500',
  'from-amber-300 to-orange-500',
  'from-sky-400 to-indigo-500',
  'from-emerald-400 to-teal-600',
  'from-violet-400 to-fuchsia-500',
  'from-rose-400 to-pink-600',
  'from-cyan-400 to-sky-600',
  'from-lime-400 to-emerald-600',
  'from-indigo-400 to-violet-600',
  'from-stone-500 to-stone-800',
]

function hash(s: string) {
  let h = 0
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0
  return Math.abs(h)
}

export function initials(name: string) {
  const parts = name.split(/\s+/).filter(Boolean)
  return (
    (parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')
  ).toLocaleUpperCase('nb')
}

const avatarSizes = {
  xs: 'size-6 text-[10px]',
  sm: 'size-8 text-xs',
  md: 'size-10 text-sm',
  lg: 'size-14 text-lg',
  xl: 'size-24 text-3xl sm:size-28 sm:text-4xl',
}

/** Hvor bred avataren vises, så nettleseren henter den minste bildestørrelsen som holder. */
const avatarWidths = {
  xs: '24px',
  sm: '32px',
  md: '40px',
  lg: '56px',
  xl: '(min-width: 640px) 112px, 96px',
}

/**
 * Profilbildet, eller initialer på en farge avledet av navnet når personen ikke
 * har bilde eller det ikke lar seg laste. Navnet står alltid ved siden av, så
 * avataren er pynt for skjermlesere.
 */
export function Avatar({
  name,
  photo,
  size = 'md',
  muted = false,
  className,
}: {
  name: string
  photo?: ProfilePhoto | null
  size?: keyof typeof avatarSizes
  muted?: boolean
  className?: string
}) {
  // Bildet som ikke lot seg laste, f.eks. ett som nettopp ble fjernet. Et nytt bilde prøves.
  const [broken, setBroken] = useState<string | null>(null)
  if (photo && broken !== photo.small) {
    return (
      <img
        // Størrelsene er de samme som PHOTO_SIZES i @esaf/core.
        src={photo.small}
        srcSet={`${photo.small} 192w, ${photo.large} 512w`}
        sizes={avatarWidths[size]}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setBroken(photo.small)}
        // Feilet bildet før siden ble interaktiv, kommer det ingen error-hendelse.
        ref={(img) => {
          if (img?.complete && img.naturalWidth === 0) setBroken(photo.small)
        }}
        className={clsx(
          'inline-block shrink-0 rounded-full bg-stone-100 object-cover select-none',
          avatarSizes[size],
          className,
        )}
      />
    )
  }
  return (
    <span
      aria-hidden
      className={clsx(
        'inline-grid shrink-0 place-items-center rounded-full font-semibold tracking-tight select-none',
        avatarSizes[size],
        muted
          ? 'bg-stone-100 text-stone-500 ring-1 ring-stone-200 ring-inset'
          : clsx(
              'bg-gradient-to-br text-white shadow-inner',
              gradients[hash(name) % gradients.length],
            ),
        className,
      )}
    >
      {initials(name)}
    </span>
  )
}

const markSizes = {
  sm: 'size-9 rounded-lg text-sm',
  md: 'size-11 rounded-xl text-base',
  lg: 'size-12 rounded-xl text-lg',
  xl: 'size-16 rounded-2xl text-2xl sm:size-20 sm:text-3xl',
}

/** Initial på en farge avledet av navnet, til selskaper får logo. */
export function CompanyMark({
  name,
  size = 'md',
  className,
}: {
  name: string
  size?: keyof typeof markSizes
  className?: string
}) {
  return (
    <span
      aria-hidden
      className={clsx(
        'inline-grid shrink-0 place-items-center bg-gradient-to-br font-bold text-white shadow-sm select-none',
        markSizes[size],
        gradients[hash(name.toLocaleLowerCase('nb')) % gradients.length],
        className,
      )}
    >
      {name.trim()[0]?.toLocaleUpperCase('nb')}
    </span>
  )
}

/** Noen få ansikter tett i tett, med hvit kant så de skilles fra hverandre. */
export function AvatarStack({
  people,
}: {
  people: { personId: string; fullName: string; photo: ProfilePhoto | null; claimed: boolean }[]
}) {
  return (
    <span className="flex -space-x-1.5">
      {people.map((p) => (
        <span key={p.personId} className="inline-flex rounded-full ring-2 ring-white">
          <Avatar name={p.fullName} photo={p.photo} size="sm" muted={!p.claimed} />
        </span>
      ))}
    </span>
  )
}

export function Verified({ claimed, className }: { claimed: boolean; className?: string }) {
  if (!claimed) return null
  return (
    <BadgeCheck
      className={clsx('inline size-4 shrink-0 fill-brand-500 text-white', className)}
      aria-label="Verifisert medlem"
    />
  )
}

export function ProfileStatus({ claimed }: { claimed: boolean }) {
  return claimed ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700 ring-1 ring-brand-600/15 ring-inset">
      <BadgeCheck className="size-3.5 fill-brand-500 text-white" aria-hidden /> Verifisert
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium text-stone-500 ring-1 ring-stone-300 ring-inset ring-dashed">
      Ikke tatt i bruk
    </span>
  )
}

const fieldBase =
  'block w-full rounded-lg border-0 bg-white px-3 py-2 text-sm text-stone-900 shadow-card ring-1 ring-stone-200 transition ring-inset placeholder:text-stone-400 focus:ring-2 focus:ring-brand-500 focus:outline-none'

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={clsx(fieldBase, 'h-10', className)} {...props} />
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={clsx(fieldBase, 'min-h-28 py-2.5 leading-relaxed', className)}
      {...props}
    />
  )
}

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return <select className={clsx(fieldBase, 'h-10 pr-8', className)} {...props} />
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <label className={clsx('block space-y-1.5', className)}>
      <span className="block text-sm font-medium text-stone-800">{label}</span>
      {children}
      {hint && <span className="block text-xs text-stone-500">{hint}</span>}
    </label>
  )
}

/** Av/på-bryter med tekst, for valg som slår noe på for andre (som å vise telefonnummeret). */
export function Switch({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  description?: ReactNode
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 rounded-xl bg-stone-50 px-3.5 py-3 ring-1 ring-stone-200 ring-inset">
      <span className="min-w-0">
        <span className="block text-sm font-medium text-stone-800">{label}</span>
        {description && (
          <span className="block truncate text-xs text-stone-500">{description}</span>
        )}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span className="relative h-6 w-10 shrink-0 rounded-full bg-stone-300 transition peer-checked:bg-brand-600 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500 peer-focus-visible:ring-offset-2 after:absolute after:top-0.5 after:left-0.5 after:size-5 after:rounded-full after:bg-white after:shadow after:transition peer-checked:after:translate-x-4" />
    </label>
  )
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-stone-950 sm:text-[28px]">
          {title}
        </h1>
        {description && <p className="mt-1 text-sm text-stone-500">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

export function EmptyState({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof BadgeCheck
  title: string
  children?: ReactNode
}) {
  return (
    <div className="rounded-2xl border border-dashed border-stone-300 bg-white/50 px-6 py-14 text-center">
      <div className="mx-auto grid size-11 place-items-center rounded-full bg-stone-100 text-stone-500">
        <Icon className="size-5" aria-hidden />
      </div>
      <p className="mt-3 font-medium text-stone-900">{title}</p>
      {children && <div className="mt-1 text-sm text-stone-500">{children}</div>}
    </div>
  )
}

export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200 ring-inset"
    >
      {children}
    </p>
  )
}

export function LinkedInIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28ZM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13ZM7.12 20.45H3.56V9h3.56v11.45ZM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0Z" />
    </svg>
  )
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-2', className)}>
      <span className="grid size-7 place-items-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 text-[13px] font-bold text-white shadow-sm shadow-brand-700/30">
        E
      </span>
      <span className="text-[15px] font-semibold tracking-tight text-stone-950">ESAF</span>
    </span>
  )
}
