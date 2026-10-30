import type { BoardBadge as Badge, CurrentBoardSeat, FormerBoardMember } from '@esaf/core'
import type { BoardRole } from '@esaf/db'
import { Link } from '@tanstack/react-router'
import { Landmark } from 'lucide-react'
import { boardRoleNames, boardTitle } from '#/lib/board.ts'
import { Avatar, cx, Verified } from './ui.tsx'

/**
 * Vervet i styret på profilen, som et `<li>` i listen over verv: nåværende som
 * et tydelig merke, tidligere i en roligere stil med årene. Lenker til styret.
 */
export function BoardBadge({ badge }: { badge: Badge | null }) {
  if (!badge) return null
  const role = badge.current ? badge.role : badge.roles[0]!
  return (
    <li>
      <Link
        to="/styret"
        title={
          badge.current
            ? badge.period
              ? `I styret ${badge.period}`
              : undefined
            : badge.roles.length > 1
              ? badge.roles.map((r) => boardRoleNames[r]).join(', ')
              : undefined
        }
        className={cx(
          'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 transition ring-inset',
          badge.current
            ? 'bg-stone-900 text-white ring-stone-900 hover:bg-stone-800'
            : 'text-stone-500 ring-stone-200 hover:text-stone-800 hover:ring-stone-300',
        )}
      >
        <Landmark className="size-3.5" aria-hidden />
        {boardTitle(role)}
        {badge.current && badge.responsibility && (
          <span className="font-normal text-stone-300">· {badge.responsibility}</span>
        )}
        {!badge.current && <span className="tabular-nums">, {badge.period}</span>}
      </Link>
    </li>
  )
}

/** Lite merke i lister og søk: «Styreleder» eller «Styret». */
export function BoardTag({ role, className }: { role: BoardRole | null; className?: string }) {
  if (!role) return null
  return (
    <span
      title={boardTitle(role)}
      className={cx(
        'inline-flex shrink-0 items-center gap-1 rounded-full bg-stone-900 px-1.5 py-px text-[11px] font-medium text-white',
        className,
      )}
    >
      <Landmark className="size-3" aria-hidden />
      {role === 'chair' ? 'Styreleder' : role === 'vice_chair' ? 'Nestleder' : 'Styret'}
    </span>
  )
}

/** Én i styret på styresiden. */
export function BoardSeatCard({ seat }: { seat: CurrentBoardSeat }) {
  return (
    <Link
      to="/medlemmer/$personId"
      params={{ personId: seat.personId }}
      className="flex h-full items-center gap-3.5 rounded-2xl bg-white p-4 shadow-card ring-1 ring-stone-200/70 transition hover:-translate-y-px hover:shadow-lift hover:ring-stone-300"
    >
      <Avatar name={seat.fullName} photo={seat.photo} size="lg" muted={!seat.claimed} />
      <span className="min-w-0">
        <span className="flex items-center gap-1 font-semibold text-stone-950">
          <span className="truncate">{seat.fullName}</span>
          <Verified claimed={seat.claimed} />
        </span>
        <span className="block text-sm text-stone-700">
          {boardRoleNames[seat.role]}
          {seat.responsibility && <span className="text-stone-500"> · {seat.responsibility}</span>}
        </span>
        {seat.since && (
          <span className="block text-xs text-stone-500 tabular-nums">
            I styret siden {seat.since}
          </span>
        )}
        {seat.note && <span className="block truncate text-xs text-stone-500">{seat.note}</span>}
      </span>
    </Link>
  )
}

/** En som har sittet i styret, i listen over tidligere styremedlemmer. */
export function FormerBoardRow({ member: m }: { member: FormerBoardMember }) {
  return (
    <Link
      to="/medlemmer/$personId"
      params={{ personId: m.personId }}
      className="flex items-center gap-3 rounded-xl px-2 py-2 transition hover:bg-stone-50"
    >
      <Avatar name={m.fullName} photo={m.photo} size="sm" muted={!m.claimed} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1 text-sm font-medium text-stone-900">
          <span className="truncate">{m.fullName}</span>
          <Verified claimed={m.claimed} />
        </span>
        <span className="block truncate text-xs text-stone-500">
          {m.roles.map((r) => boardRoleNames[r]).join(', ')}
        </span>
      </span>
      <span className="shrink-0 text-xs text-stone-500 tabular-nums">{m.period}</span>
    </Link>
  )
}
