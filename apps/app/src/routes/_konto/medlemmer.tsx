import { createFileRoute } from '@tanstack/react-router'
import type { MemberListItem } from '@esaf/core'
import { getMembers } from '#/lib/members.functions.ts'

export const Route = createFileRoute('/_konto/medlemmer')({
  head: () => ({ meta: [{ title: 'Medlemmer – ESAF-appen' }] }),
  loader: () => getMembers(),
  component: Members,
})

const relationLabel = { student: '', staff: 'ansatt', mentor: 'mentor' } as const

function groupByCohort(members: MemberListItem[]) {
  const groups = new Map<number | null, { member: MemberListItem; relation: string }[]>()
  for (const member of members) {
    const entries = member.cohorts.length
      ? member.cohorts.map((c) => [c.startYear, relationLabel[c.relation]] as const)
      : ([[null, '']] as const)
    for (const [year, relation] of entries) {
      groups.set(year, [...(groups.get(year) ?? []), { member, relation }])
    }
  }
  return [...groups.entries()].sort(([a], [b]) => (b ?? -1) - (a ?? -1))
}

function Members() {
  const members = Route.useLoaderData()
  const claimed = members.filter((m) => m.claimed).length

  return (
    <main className="wide">
      <h1>Medlemmer</h1>
      <p className="muted">
        {members.length} personer · {claimed} verifiserte brukere · {members.length - claimed}{' '}
        profiler som ikke er tatt i bruk ennå
      </p>
      <dl className="legend">
        <div>
          <dt>
            <StatusBadge claimed />
          </dt>
          <dd>Har registrert seg og bekreftet e-postadressen sin.</dd>
        </div>
        <div>
          <dt>
            <StatusBadge claimed={false} />
          </dt>
          <dd>Lagt inn av ESAF fra kullisten. Personen har ikke tatt i bruk profilen ennå.</dd>
        </div>
      </dl>

      {groupByCohort(members).map(([year, entries]) => (
        <section key={year ?? 'uten'} aria-labelledby={`kull-${year ?? 'uten'}`}>
          <h2 id={`kull-${year ?? 'uten'}`}>
            {year ? `Kull ${year}` : 'Uten kull'}{' '}
            <span className="muted count">{entries.length}</span>
          </h2>
          <ul className="list">
            {entries.map(({ member, relation }) => (
              <li key={member.personId} className={member.claimed ? undefined : 'unclaimed'}>
                <span>
                  {member.fullName}
                  {relation && <span className="muted"> · {relation}</span>}
                </span>
                <StatusBadge claimed={member.claimed} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  )
}

function StatusBadge({ claimed }: { claimed: boolean }) {
  return claimed ? (
    <span className="badge verified">
      <span aria-hidden="true">✓ </span>Verifisert
    </span>
  ) : (
    <span className="badge profile">Profil</span>
  )
}
