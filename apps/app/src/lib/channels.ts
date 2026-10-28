import {
  Briefcase,
  CalendarDays,
  CircleHelp,
  Handshake,
  Hash,
  Rocket,
  type LucideIcon,
} from 'lucide-react'

export const channelKeys = [
  'generelt',
  'sporsmal',
  'intro',
  'lansering',
  'jobb',
  'arrangement',
] as const
export type ChannelKey = (typeof channelKeys)[number]

export const channels: Record<
  ChannelKey,
  {
    label: string
    plural: string
    icon: LucideIcon
    tone: string
    dot: string
    hint: string
    placeholder: string
  }
> = {
  sporsmal: {
    label: 'Spørsmål',
    plural: 'Spørsmål',
    icon: CircleHelp,
    tone: 'bg-sky-50 text-sky-700 ring-sky-600/15',
    dot: 'bg-sky-500',
    hint: 'Be nettverket om råd',
    placeholder: 'Hva lurer du på?',
  },
  intro: {
    label: 'Intro',
    plural: 'Intro-forespørsler',
    icon: Handshake,
    tone: 'bg-violet-50 text-violet-700 ring-violet-600/15',
    dot: 'bg-violet-500',
    hint: 'Finn noen som kjenner noen',
    placeholder: 'Hvem vil du bli introdusert for, og hvorfor?',
  },
  lansering: {
    label: 'Lansering',
    plural: 'Lanseringer',
    icon: Rocket,
    tone: 'bg-brand-50 text-brand-700 ring-brand-600/15',
    dot: 'bg-brand-500',
    hint: 'Vis frem noe du har laget',
    placeholder: 'Hva lanserer dere?',
  },
  jobb: {
    label: 'Jobb',
    plural: 'Jobber',
    icon: Briefcase,
    tone: 'bg-emerald-50 text-emerald-700 ring-emerald-600/15',
    dot: 'bg-emerald-500',
    hint: 'Stillinger og oppdrag',
    placeholder: 'Hvem ser dere etter?',
  },
  arrangement: {
    label: 'Arrangement',
    plural: 'Arrangementer',
    icon: CalendarDays,
    tone: 'bg-amber-50 text-amber-800 ring-amber-600/20',
    dot: 'bg-amber-500',
    hint: 'Treff, talks og ESAF-helg',
    placeholder: 'Hva skjer, hvor og når?',
  },
  generelt: {
    label: 'Generelt',
    plural: 'Generelt',
    icon: Hash,
    tone: 'bg-stone-100 text-stone-700 ring-stone-600/10',
    dot: 'bg-stone-400',
    hint: 'Alt annet',
    placeholder: 'Hva vil du dele?',
  },
}

export const channelOrder: ChannelKey[] = [
  'sporsmal',
  'intro',
  'lansering',
  'jobb',
  'arrangement',
  'generelt',
]
