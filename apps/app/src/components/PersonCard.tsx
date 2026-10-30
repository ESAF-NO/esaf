import type { MemberListItem } from '@esaf/core'
import { Link } from '@tanstack/react-router'
import { MapPin } from 'lucide-react'
import { BoardTag } from './Board.tsx'
import { RepresentativeTag } from './Representatives.tsx'
import { Avatar, Tag, Verified } from './ui.tsx'

/** Verifiserte og utfylte profiler først, så etter navn. Brukes der personer listes. */
export function comparePeople(a: MemberListItem, b: MemberListItem) {
  return (
    Number(b.claimed) - Number(a.claimed) ||
    Number(b.experience.length > 0) - Number(a.experience.length > 0) ||
    a.fullName.localeCompare(b.fullName, 'nb')
  )
}

/** Kortet for én person i katalogen og på kullsidene. Hele kortet lenker til profilen. */
export function PersonCard({ member: m }: { member: MemberListItem }) {
  const headline = [m.jobTitle, m.currentCompany].filter(Boolean).join(' · ')
  const earlier = [...new Set(m.experience.filter((e) => e.endYear !== null).map((e) => e.company))]
  const tags = [...new Set([...m.expertise, ...m.industries])]
  return (
    <Link
      to="/medlemmer/$personId"
      params={{ personId: m.personId }}
      className="group flex h-full gap-3.5 rounded-2xl bg-white p-4 shadow-card ring-1 ring-stone-200/70 transition hover:-translate-y-px hover:shadow-lift hover:ring-stone-300"
    >
      <Avatar name={m.fullName} photo={m.photo} size="lg" muted={!m.claimed} />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1 font-semibold text-stone-950">
          <span className="truncate">{m.fullName}</span>
          <Verified claimed={m.claimed} />
        </p>
        {/* Hardt mellomrom holder linjen, så kortene blir like høye. */}
        <p className="truncate text-sm text-stone-600">{headline || m.studyBackground || ' '}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-500">
          {m.cohorts.length > 0 && (
            <span className="font-medium text-stone-700">
              ES {m.cohorts.map((c) => c.graduationYear).join(', ')}
            </span>
          )}
          <BoardTag role={m.boardRole} />
          <RepresentativeTag years={m.representativeOf} />
          {m.city && (
            <span className="inline-flex items-center gap-1">
              <MapPin className="size-3" aria-hidden />
              {m.city}
            </span>
          )}
        </div>
        {earlier.length > 0 && (
          <p className="mt-1.5 truncate text-xs text-stone-500">
            Tidligere: {earlier.slice(0, 3).join(', ')}
          </p>
        )}
        {tags.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1">
            {tags.slice(0, 3).map((t) => (
              <Tag key={t}>{t}</Tag>
            ))}
            {tags.length > 3 && <Tag className="bg-transparent">+{tags.length - 3}</Tag>}
          </div>
        )}
      </div>
    </Link>
  )
}
