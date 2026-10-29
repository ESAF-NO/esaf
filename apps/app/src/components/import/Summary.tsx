import type { ImportIssue } from '@esaf/core'
import type { ReactNode } from 'react'
import { plural } from '#/lib/format.ts'

/** Tallene i en plan: «12 nye deltakelser» osv. Null vises dempet. */
export function Totals({ items }: { items: { label: string; value: number }[] }) {
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {items.map((i) => (
        <div
          key={i.label}
          className="rounded-xl bg-stone-50 px-3 py-2.5 ring-1 ring-stone-200 ring-inset"
        >
          <dt className="text-xs text-stone-500">{i.label}</dt>
          <dd
            className={
              i.value
                ? 'text-lg font-semibold text-stone-950 tabular-nums'
                : 'text-lg font-semibold text-stone-400 tabular-nums'
            }
          >
            {i.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** Rader som er hoppet over eller har noe å se på, med hvor i arket. */
export function Issues({ issues, title }: { issues: ImportIssue[]; title: ReactNode }) {
  if (!issues.length) return null
  return (
    <details className="rounded-xl bg-amber-50/60 px-3 py-2.5 text-sm ring-1 ring-amber-200 ring-inset">
      <summary className="cursor-pointer font-medium text-amber-900">
        {title} ({plural(issues.length, 'rad', 'rader')})
      </summary>
      <ul className="mt-2 max-h-60 space-y-0.5 overflow-y-auto text-xs text-amber-900">
        {issues.map((i, n) => (
          <li key={n}>
            <span className="font-medium">{i.where}:</span> {i.message}
          </li>
        ))}
      </ul>
    </details>
  )
}

/** Overskrift for et steg i importen. */
export function StepTitle({ n, children }: { n: number; children: ReactNode }) {
  return (
    <h2 className="flex items-center gap-2 text-sm font-semibold text-stone-950">
      <span className="grid size-5 place-items-center rounded-full bg-stone-900 text-[11px] text-white tabular-nums">
        {n}
      </span>
      {children}
    </h2>
  )
}

/** Eksempel på et ark, som en liten tabell. */
export function ExampleSheet({ title, rows }: { title: ReactNode; rows: string[][] }) {
  return (
    <figure className="space-y-1">
      <figcaption className="text-xs font-medium text-stone-700">{title}</figcaption>
      <div className="overflow-x-auto">
        <table className="text-[11px] text-stone-600">
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={i === 0 ? 'font-medium text-stone-800' : undefined}>
                {r.map((c, j) => (
                  <td
                    key={j}
                    className="border border-stone-200 bg-white px-1.5 py-0.5 whitespace-nowrap"
                  >
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  )
}
