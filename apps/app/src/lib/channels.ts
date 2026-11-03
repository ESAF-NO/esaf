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
    /** Hjelpeteksten i tekstfeltet for innlegg i kanalen. */
    prompt: string
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
    prompt:
      'Gi nok kontekst til at folk kan hjelpe: hva gjelder det, hva har du prøvd, og hva trenger du?',
  },
  intro: {
    label: 'Intro',
    plural: 'Intro-forespørsler',
    icon: Handshake,
    tone: 'bg-violet-50 text-violet-700 ring-violet-600/15',
    dot: 'bg-violet-500',
    hint: 'Finn noen som kjenner noen',
    placeholder: 'Hvem vil du bli introdusert for, og hvorfor?',
    prompt: 'Fortell kort hva du jobber med, og hva en intro kan hjelpe med.',
  },
  lansering: {
    label: 'Lansering',
    plural: 'Lanseringer',
    icon: Rocket,
    tone: 'bg-brand-50 text-brand-700 ring-brand-600/15',
    dot: 'bg-brand-500',
    hint: 'Vis frem noe du har laget',
    placeholder: 'Hva lanserer dere?',
    prompt: 'Hva er det, hvem er det for, og hva vil dere gjerne ha tilbakemelding på?',
  },
  jobb: {
    label: 'Jobb',
    plural: 'Jobber',
    icon: Briefcase,
    tone: 'bg-emerald-50 text-emerald-700 ring-emerald-600/15',
    dot: 'bg-emerald-500',
    hint: 'Stillinger og oppdrag',
    placeholder: 'Hvem ser dere etter?',
    prompt: 'Rollen, hvor, og hvordan man søker. Legg gjerne ved annonsen.',
  },
  arrangement: {
    label: 'Arrangement',
    // Ikke «Arrangementer»: det er navnet på oversikten over arrangementer og deltakere.
    plural: 'Arrangementsinnlegg',
    icon: CalendarDays,
    tone: 'bg-amber-50 text-amber-800 ring-amber-600/20',
    dot: 'bg-amber-500',
    hint: 'Treff, talks og ESAF-helg',
    placeholder: 'Hva skjer, hvor og når?',
    prompt: 'Tid, sted, hvem det passer for, og hvordan man melder seg på.',
  },
  generelt: {
    label: 'Generelt',
    plural: 'Generelt',
    icon: Hash,
    tone: 'bg-stone-100 text-stone-700 ring-stone-600/10',
    dot: 'bg-stone-400',
    hint: 'Alt annet',
    placeholder: 'Hva vil du dele?',
    prompt: 'Skriv det du vil dele med nettverket.',
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
