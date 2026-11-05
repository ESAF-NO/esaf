import type {
  BadgeColor,
  BadgeIcon as BadgeIconName,
  BadgeImage,
  BadgeRarity,
  BadgeRarityTier,
  BadgeStep,
  OwnBadgeUpdate,
  PlayerLevel,
  ProfileBadge,
} from '@esaf/core'
import { Link, useRouteContext, useRouter } from '@tanstack/react-router'
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
import { useState } from 'react'
import { hideOwnBadge } from '#/lib/badges.functions.ts'
import { Dialog, DialogActions } from './Dialog.tsx'
import { buttonClass, cx, ErrorText } from './ui.tsx'

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
  xs: { box: 'size-5 [&_svg]:size-3', ring: 'p-[1.5px]', step: 'hidden', width: '20px' },
  sm: { box: 'size-7 [&_svg]:size-3.5', ring: 'p-[2px]', step: 'hidden', width: '28px' },
  md: {
    box: 'size-12 [&_svg]:size-6',
    ring: 'p-[3px]',
    step: 'text-[9px] px-1 -bottom-1',
    width: '48px',
  },
  lg: {
    box: 'size-20 [&_svg]:size-10',
    ring: 'p-1',
    step: 'text-[11px] px-1.5 -bottom-1.5',
    width: '80px',
  },
}

/**
 * Kanten rundt merket viser hvor sjeldent det er: grå for vanlige, sølv, gull,
 * lilla glød for episke og en regnbuekant med glans for legendariske.
 */
export const rarityRings: Record<BadgeRarityTier, string> = {
  common: 'bg-stone-200',
  uncommon: 'bg-gradient-to-br from-slate-200 via-slate-400 to-slate-200',
  rare: 'bg-gradient-to-br from-amber-200 via-amber-500 to-amber-200',
  epic: 'bg-gradient-to-br from-fuchsia-300 via-violet-600 to-fuchsia-300 shadow-[0_0_14px_-2px] shadow-violet-500/60',
  legendary:
    'bg-[conic-gradient(from_200deg,#f59e0b,#ef4444,#d946ef,#6366f1,#06b6d4,#22c55e,#f59e0b)] shadow-[0_0_18px_-2px] shadow-amber-500/60',
}

/** Navnene, som `badgeRarityNames` i @esaf/core (som ikke kan lastes i nettleseren). */
export const rarityNames: Record<BadgeRarityTier, string> = {
  common: 'Vanlig',
  uncommon: 'Uvanlig',
  rare: 'Sjelden',
  epic: 'Episk',
  legendary: 'Legendarisk',
}

/** Teksten for sjeldenheten: farge per nivå. */
export const rarityText: Record<BadgeRarityTier, string> = {
  common: 'text-stone-500',
  uncommon: 'text-slate-600',
  rare: 'text-amber-700',
  epic: 'text-violet-700',
  legendary:
    'bg-gradient-to-r from-amber-600 via-rose-600 to-violet-600 bg-clip-text text-transparent',
}

const roman = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X']

/** Fargene, også for verdier appen ikke kjenner (fra en nyere versjon). Ukjente ikoner blir `Award`. */
const colorOf = (color: string) => badgeColorClasses[color as BadgeColor] ?? badgeColorClasses.stone

/**
 * Merket: ikonet (eller merkets eget bilde) i fargen sin, med en kant som viser
 * hvor sjeldent det er, og trinnet i serien (I, II, III). Uten `earned` er det
 * grått, som et merke man ikke har ennå.
 */
export function BadgeMedal({
  badge,
  earned = true,
  rarity,
  step,
  size = 'md',
  pop = false,
  delay = 0,
  className,
}: {
  badge: { icon: string; color: string; image?: BadgeImage | null }
  earned?: boolean
  rarity?: BadgeRarityTier
  step?: BadgeStep | null
  size?: keyof typeof medalSizes
  /** Popper inn, til feiringen, eventuelt litt etter de andre (millisekunder). */
  pop?: boolean
  delay?: number
  className?: string
}) {
  const Icon = badgeIconComponents[badge.icon as BadgeIconName] ?? Award
  const s = medalSizes[size]
  // Bildet som ikke lot seg laste, f.eks. ett som nettopp ble byttet. Da vises ikonet.
  const [broken, setBroken] = useState<string | null>(null)
  const image = badge.image && badge.image.small !== broken ? badge.image : null
  return (
    <span
      aria-hidden
      className={cx(
        'relative inline-grid h-fit shrink-0 self-start rounded-full',
        s.ring,
        earned && rarity ? rarityRings[rarity] : earned ? 'bg-white/70' : 'bg-transparent',
        pop && 'animate-pop',
        className,
      )}
      style={pop && delay ? { animationDelay: `${delay}ms` } : undefined}
    >
      <span
        className={cx(
          'relative grid place-items-center overflow-hidden rounded-full',
          s.box,
          earned
            ? cx(colorOf(badge.color).medal, 'shadow-inner ring-2 ring-white/60')
            : 'bg-stone-100 text-stone-400 outline-1 -outline-offset-4 outline-stone-300 outline-dashed',
        )}
      >
        {image ? (
          <img
            // Størrelsene er de samme som BADGE_IMAGE_SIZES i @esaf/core.
            src={image.small}
            srcSet={`${image.small} 96w, ${image.large} 256w`}
            sizes={s.width}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setBroken(image.small)}
            // Feilet bildet før siden ble interaktiv, kommer det ingen error-hendelse.
            ref={(img) => {
              if (img?.complete && img.naturalWidth === 0) setBroken(image.small)
            }}
            className={cx(
              'relative size-full object-cover select-none',
              !earned && 'opacity-60 grayscale',
            )}
          />
        ) : (
          <Icon strokeWidth={2} className="relative" />
        )}
        {earned && rarity === 'legendary' && (
          <span className="pointer-events-none absolute inset-y-[-50%] left-0 w-1/3 animate-shine bg-white/45 blur-[2px] motion-reduce:hidden" />
        )}
      </span>
      {step && (
        <span
          className={cx(
            'absolute left-1/2 -translate-x-1/2 rounded-full font-bold tracking-wide shadow-sm ring-1 tabular-nums',
            s.step,
            earned
              ? 'bg-stone-900 text-white ring-white'
              : 'bg-white text-stone-400 ring-stone-200',
          )}
        >
          {roman[step.index - 1] ?? step.index}
        </span>
      )}
    </span>
  )
}

/** «Episk · 4 % har det». */
export function RarityTag({
  rarity,
  showShare = true,
  showXp = false,
  className,
}: {
  rarity: BadgeRarity
  showShare?: boolean
  showXp?: boolean
  className?: string
}) {
  const percent = rarity.share > 0 && rarity.share < 0.01 ? '<1' : Math.round(rarity.share * 100)
  return (
    <span className={cx('text-xs font-semibold', className)}>
      <span className={rarityText[rarity.tier]}>{rarityNames[rarity.tier]}</span>
      {showShare && (
        <span className="font-normal text-stone-500">
          {' '}
          · {rarity.share === 0 ? 'ingen har det ennå' : `${percent} % har det`}
        </span>
      )}
      {showXp && <span className="font-normal text-stone-500"> · +{rarity.xp} XP</span>}
    </span>
  )
}

/** Nivået i en ring som fylles mot neste nivå. */
export function LevelRing({ level, size = 'md' }: { level: PlayerLevel; size?: 'xs' | 'md' }) {
  const share = (level.xp - level.levelXp) / (level.nextXp - level.levelXp)
  return (
    <span
      className={cx(
        'relative grid shrink-0 place-items-center rounded-full',
        size === 'md' ? 'size-20' : 'size-5',
      )}
      style={{
        background: `conic-gradient(var(--color-brand-500) ${share * 360}deg, var(--color-stone-200) 0)`,
      }}
      role="img"
      aria-label={`Nivå ${level.level}`}
    >
      <span
        className={cx(
          'grid place-items-center rounded-full bg-white font-bold text-stone-950 tabular-nums',
          size === 'md' ? 'size-16 text-2xl' : 'size-3.5 text-[8px]',
        )}
      >
        {level.level}
      </span>
    </span>
  )
}

/**
 * Merkene på en profil, som på GitHub: medaljene i et rutenett, og et klikk
 * viser hva merket er, når personen fikk det og hvor sjeldent det er. På egen
 * profil kan merket skjules derfra.
 */
export function ProfileBadgeGrid({ badges, isOwn }: { badges: ProfileBadge[]; isOwn: boolean }) {
  const [open, setOpen] = useState<ProfileBadge | null>(null)
  return (
    <>
      <ul className="grid grid-cols-4 gap-x-2 gap-y-3" aria-label="Merker">
        {badges.map((b) => (
          <li key={b.id}>
            <button
              type="button"
              onClick={() => setOpen(b)}
              title={b.name}
              className="group flex w-full flex-col items-center gap-1.5 rounded-xl p-1 text-center focus-visible:outline-2 focus-visible:outline-brand-500"
            >
              <BadgeMedal
                badge={b}
                rarity={b.hidden ? undefined : b.rarity.tier}
                earned={!b.hidden}
                step={b.step}
                className="self-center transition group-hover:-translate-y-0.5 group-hover:scale-105"
              />
              <span className="line-clamp-2 text-[11px] leading-tight font-medium text-stone-700">
                {b.name}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {open && (
        <BadgeDialog
          // Hentes fra lista, så skjult/vist oppdateres etter lagring.
          badge={badges.find((b) => b.id === open.id) ?? open}
          isOwn={isOwn}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  )
}

/** Ett merke: hva det er, når det ble fortjent, hvor sjeldent det er. */
function BadgeDialog({
  badge: b,
  isOwn,
  onClose,
}: {
  badge: ProfileBadge
  isOwn: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function setHidden(hidden: boolean) {
    setBusy(true)
    setError(null)
    try {
      await hideOwnBadge({ data: { badgeId: b.id, hidden } })
      await router.invalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke lagre.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog title={b.name} onClose={onClose} busy={busy}>
      <div className="flex items-start gap-4">
        <BadgeMedal
          badge={b}
          rarity={b.hidden ? undefined : b.rarity.tier}
          earned={!b.hidden}
          step={b.step}
          size="lg"
        />
        <div className="min-w-0 space-y-1.5 text-sm">
          <p className="text-stone-800">{b.description}</p>
          <RarityTag rarity={b.rarity} showXp />
          <p className="text-stone-500">
            {b.ruleText}
            {b.step && ` · trinn ${b.step.index} av ${b.step.count}`}
            {b.achievedOn && ` · siden ${b.achievedOn.slice(0, 4)}`}
          </p>
          {b.citation && <p className="text-stone-700 italic">«{b.citation}»</p>}
        </div>
      </div>
      {error && (
        <div className="mt-4">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      <DialogActions>
        {isOwn && (
          <button
            type="button"
            onClick={() => setHidden(!b.hidden)}
            disabled={busy}
            className={buttonClass({ variant: 'secondary' })}
          >
            {b.hidden ? 'Vis på profilen' : 'Skjul fra profilen'}
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className={buttonClass({ variant: 'primary' })}
          data-autofocus
        >
          Lukk
        </button>
      </DialogActions>
    </Dialog>
  )
}

/**
 * Når den innloggede nettopp har fått merker: merkene popper inn, med hvor
 * sjeldne de er og XP-en de gir, og et nytt nivå når det ble nådd. Vises etter
 * «Jeg var der» og «Var du der?».
 */
export function NewBadgesDialog({
  update,
  onClose,
}: {
  update: OwnBadgeUpdate
  onClose: () => void
}) {
  const { viewer } = useRouteContext({ from: '/_konto' })
  const { badges, level, previousLevel } = update
  if (!badges.length) return null
  const one = badges.length === 1
  const xp = badges.reduce((sum, b) => sum + b.rarity.xp, 0)
  return (
    <Dialog
      title={
        previousLevel
          ? `Nivå ${level.level}: ${level.title}!`
          : one
            ? 'Nytt merke låst opp!'
            : `${badges.length} nye merker låst opp!`
      }
      description={
        <p className="font-semibold text-brand-700">
          +{xp} XP
          {previousLevel ? ` · fra nivå ${previousLevel} til ${level.level}` : ''}
        </p>
      }
      onClose={onClose}
    >
      {previousLevel !== null && (
        <div className="mb-5 flex items-center gap-4 rounded-2xl bg-gradient-to-br from-brand-50 via-white to-amber-50 p-4 ring-1 ring-brand-100">
          <span className="animate-pop">
            <LevelRing level={level} />
          </span>
          <p className="text-sm text-stone-700">
            Du er nå <strong className="font-semibold text-stone-950">{level.title}</strong>, med{' '}
            {level.xp} XP.
          </p>
        </div>
      )}
      <ul className="space-y-4">
        {badges.map((b, i) => (
          <li key={b.id} className="flex items-center gap-4">
            <BadgeMedal
              badge={b}
              rarity={b.rarity.tier}
              size="md"
              pop
              // Merkene popper inn etter hverandre.
              delay={(i + (previousLevel ? 1 : 0)) * 160}
            />
            <div className="min-w-0">
              <p className="font-semibold text-stone-950">{b.name}</p>
              <p className="text-sm text-stone-600">{b.description}</p>
              <RarityTag rarity={b.rarity} showXp />
            </div>
          </li>
        ))}
      </ul>
      <DialogActions>
        {viewer.personId && (
          <Link
            to="/medlemmer/$personId"
            params={{ personId: viewer.personId }}
            className={buttonClass({ variant: 'secondary' })}
          >
            Se profilen din
          </Link>
        )}
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
