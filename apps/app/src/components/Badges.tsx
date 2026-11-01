import type { BadgeChip, BadgeColor, BadgeIcon as BadgeIconName, BadgeProgress } from '@esaf/core'
import { Link } from '@tanstack/react-router'
import {
  Anchor,
  Award,
  BookOpen,
  Briefcase,
  CalendarCheck,
  Camera,
  Coffee,
  Compass,
  Crown,
  Feather,
  Flag,
  Flame,
  Footprints,
  Gem,
  Gift,
  Globe,
  GraduationCap,
  HandHeart,
  Handshake,
  Heart,
  Leaf,
  Lightbulb,
  Medal,
  Megaphone,
  Mic,
  Mountain,
  PartyPopper,
  PenLine,
  Puzzle,
  Rocket,
  Shield,
  Sparkles,
  Sprout,
  Star,
  Sun,
  Target,
  Tent,
  Trophy,
  Users,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { Dialog, DialogActions } from './Dialog.tsx'
import { buttonClass, cx } from './ui.tsx'

/** Ikonene fra `badgeIcons` i @esaf/core. */
export const badgeIconComponents: Record<BadgeIconName, LucideIcon> = {
  award: Award,
  medal: Medal,
  trophy: Trophy,
  star: Star,
  crown: Crown,
  flame: Flame,
  rocket: Rocket,
  tent: Tent,
  mic: Mic,
  megaphone: Megaphone,
  handshake: Handshake,
  'hand-heart': HandHeart,
  users: Users,
  'graduation-cap': GraduationCap,
  sparkles: Sparkles,
  gem: Gem,
  heart: Heart,
  compass: Compass,
  'calendar-check': CalendarCheck,
  briefcase: Briefcase,
  lightbulb: Lightbulb,
  mountain: Mountain,
  sun: Sun,
  zap: Zap,
  target: Target,
  flag: Flag,
  'book-open': BookOpen,
  'pen-line': PenLine,
  camera: Camera,
  gift: Gift,
  'party-popper': PartyPopper,
  coffee: Coffee,
  globe: Globe,
  shield: Shield,
  leaf: Leaf,
  anchor: Anchor,
  feather: Feather,
  footprints: Footprints,
  puzzle: Puzzle,
  sprout: Sprout,
}

/** Fargene fra `badgeColors`: medaljen, og den lyse varianten til små merker. */
export const badgeColorClasses: Record<BadgeColor, { medal: string; soft: string; bar: string }> = {
  brand: {
    medal: 'bg-gradient-to-br from-brand-400 to-brand-700 text-white ring-brand-200',
    soft: 'bg-brand-50 text-brand-800 ring-brand-200',
    bar: 'bg-brand-600',
  },
  amber: {
    medal: 'bg-gradient-to-br from-amber-300 to-amber-600 text-white ring-amber-200',
    soft: 'bg-amber-50 text-amber-900 ring-amber-200',
    bar: 'bg-amber-500',
  },
  emerald: {
    medal: 'bg-gradient-to-br from-emerald-400 to-emerald-700 text-white ring-emerald-200',
    soft: 'bg-emerald-50 text-emerald-900 ring-emerald-200',
    bar: 'bg-emerald-600',
  },
  sky: {
    medal: 'bg-gradient-to-br from-sky-400 to-sky-700 text-white ring-sky-200',
    soft: 'bg-sky-50 text-sky-900 ring-sky-200',
    bar: 'bg-sky-600',
  },
  violet: {
    medal: 'bg-gradient-to-br from-violet-400 to-violet-700 text-white ring-violet-200',
    soft: 'bg-violet-50 text-violet-900 ring-violet-200',
    bar: 'bg-violet-600',
  },
  rose: {
    medal: 'bg-gradient-to-br from-rose-400 to-rose-700 text-white ring-rose-200',
    soft: 'bg-rose-50 text-rose-900 ring-rose-200',
    bar: 'bg-rose-600',
  },
  teal: {
    medal: 'bg-gradient-to-br from-teal-400 to-teal-700 text-white ring-teal-200',
    soft: 'bg-teal-50 text-teal-900 ring-teal-200',
    bar: 'bg-teal-600',
  },
  stone: {
    medal: 'bg-gradient-to-br from-stone-500 to-stone-800 text-white ring-stone-200',
    soft: 'bg-stone-100 text-stone-800 ring-stone-200',
    bar: 'bg-stone-700',
  },
}

const medalSizes = {
  sm: 'size-7 [&_svg]:size-3.5',
  md: 'size-12 [&_svg]:size-6',
  lg: 'size-20 [&_svg]:size-10',
}

/** Fargene, også for verdier appen ikke kjenner (fra en nyere versjon). Ukjente ikoner blir `Award`. */
const colorOf = (color: string) => badgeColorClasses[color as BadgeColor] ?? badgeColorClasses.stone

/** Det runde merket. Uten `earned` er det grått, som et merke man ikke har ennå. */
export function BadgeMedal({
  badge,
  earned = true,
  size = 'md',
  className,
}: {
  badge: { icon: string; color: string }
  earned?: boolean
  size?: keyof typeof medalSizes
  className?: string
}) {
  const Icon = badgeIconComponents[badge.icon as BadgeIconName] ?? Award
  return (
    <span
      aria-hidden
      className={cx(
        'grid shrink-0 place-items-center rounded-full ring-4',
        medalSizes[size],
        earned
          ? cx(colorOf(badge.color).medal, 'shadow-sm')
          : 'bg-stone-100 text-stone-400 ring-stone-50 outline-1 -outline-offset-4 outline-stone-300 outline-dashed',
        className,
      )}
    >
      <Icon strokeWidth={2} />
    </span>
  )
}

/** Et lite merke med navnet, til profilen og varsler. Lenker til merket. */
export function BadgePill({
  badge,
  hidden = false,
  title,
}: {
  badge: BadgeChip
  /** Personen har skjult det; bare hen selv ser det, nedtonet. */
  hidden?: boolean
  title?: string
}) {
  const Icon = badgeIconComponents[badge.icon as BadgeIconName] ?? Award
  return (
    <Link
      to="/merker/$slug"
      params={{ slug: badge.slug }}
      title={title ?? badge.description}
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full py-0.5 pr-2.5 pl-1 text-xs font-medium ring-1 transition ring-inset hover:brightness-95',
        hidden ? 'bg-white text-stone-400 ring-stone-200 ring-dashed' : colorOf(badge.color).soft,
      )}
    >
      <span
        className={cx(
          'grid size-5 place-items-center rounded-full',
          hidden ? 'bg-stone-100' : colorOf(badge.color).medal,
        )}
      >
        <Icon className="size-3" aria-hidden />
      </span>
      {badge.name}
      {hidden && <span className="sr-only"> (skjult for andre)</span>}
    </Link>
  )
}

/** «3 av 5» med en stolpe. */
export function BadgeProgressBar({
  progress,
  color,
  className,
}: {
  progress: BadgeProgress
  color: BadgeColor
  className?: string
}) {
  const share = Math.round((progress.current / progress.target) * 100)
  return (
    <div className={className}>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-stone-100"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={progress.target}
        aria-valuenow={progress.current}
        aria-label={`${progress.current} av ${progress.target}`}
      >
        <div
          className={cx('h-full rounded-full', colorOf(color).bar)}
          style={{ width: `${Math.max(share, progress.current > 0 ? 6 : 0)}%` }}
        />
      </div>
      <p className="mt-1 text-xs text-stone-500 tabular-nums">
        {progress.current} av {progress.target}
      </p>
    </div>
  )
}

/**
 * Når den innloggede nettopp har fått merker: en liten feiring med merkene og
 * en lenke til dem. Vises etter «Jeg var der» og «Var du der?».
 */
export function NewBadgesDialog({ badges, onClose }: { badges: BadgeChip[]; onClose: () => void }) {
  if (!badges.length) return null
  const one = badges.length === 1
  return (
    <Dialog
      title={one ? 'Du fikk et nytt merke!' : `Du fikk ${badges.length} nye merker!`}
      onClose={onClose}
    >
      <ul className="space-y-4">
        {badges.map((b) => (
          <li key={b.id} className="flex items-center gap-4">
            <BadgeMedal badge={b} size="md" className="animate-in" />
            <div className="min-w-0">
              <p className="font-semibold text-stone-950">{b.name}</p>
              <p className="text-sm text-stone-600">{b.description}</p>
            </div>
          </li>
        ))}
      </ul>
      <DialogActions>
        <Link to="/merker" className={buttonClass({ variant: 'secondary' })}>
          Se alle merker
        </Link>
        <button
          type="button"
          onClick={onClose}
          className={buttonClass({ variant: 'brand' })}
          data-autofocus
        >
          Så bra!
        </button>
      </DialogActions>
    </Dialog>
  )
}
