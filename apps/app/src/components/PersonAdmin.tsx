import type { AdminPerson, PersonAdminDetails } from '@esaf/core'
import { useRouter } from '@tanstack/react-router'
import { GitMerge, Plus, Search, Trash2 } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Section } from './CompanyForm.tsx'
import { useAction } from './Contributions.tsx'
import { Avatar, Button, ErrorText, Input, Select, Verified } from './ui.tsx'
import { kull } from '#/lib/format.ts'
import {
  addEmail,
  findAnyPerson,
  mergePerson,
  removeEmail,
  saveCohorts,
} from '#/lib/people.functions.ts'

type Relation = PersonAdminDetails['cohorts'][number]['relation']

const relationLabels: Record<Relation, string> = {
  student: 'Student',
  staff: 'Ansatt på ES',
  mentor: 'Mentor',
}

const sourceLabels: Record<PersonAdminDetails['emails'][number]['source'], string> = {
  signup: 'registrering',
  import: 'kullisten',
  admin: 'lagt inn av admin',
}

/**
 * Det bare admins retter, utenom profilfeltene: kull, kjente e-postadresser og
 * sammenslåing. Hver del lagres for seg, med en gang, og logges.
 */
export function PersonAdmin({ person }: { person: PersonAdminDetails }) {
  return (
    <div className="mt-8 space-y-4">
      <h2 className="text-sm font-semibold text-stone-500">Bare for admins</h2>
      <Cohorts person={person} />
      <Emails person={person} />
      <Merge person={person} />
    </div>
  )
}

function Cohorts({ person }: { person: PersonAdminDetails }) {
  const [rows, setRows] = useState(() =>
    person.cohorts.map((c) => ({ year: String(c.graduationYear), relation: c.relation })),
  )
  const [saved, setSaved] = useState(false)
  const { busy, error, run } = useAction()

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaved(false)
    void run(async () => {
      const cohorts = rows
        .filter((r) => r.year.trim())
        .map((r) => {
          if (!/^\d{4}$/.test(r.year)) throw new Error(`«${r.year}» er ikke et årstall.`)
          return { graduationYear: Number(r.year), relation: r.relation }
        })
      await saveCohorts({ data: { personId: person.personId, cohorts } })
      setSaved(true)
    })
  }

  return (
    <Section
      title="Kull"
      description="Uteksamineringsåret, slik ES navngir kullene. En person kan være student i ett kull og mentor for et annet."
    >
      <form onSubmit={save} className="space-y-2">
        {rows.length === 0 && <p className="text-sm text-stone-500">Ikke knyttet til noe kull.</p>}
        {rows.map((row, i) => (
          <div key={i} className="flex gap-2">
            <Input
              value={row.year}
              onChange={(e) =>
                setRows((list) =>
                  list.map((r, j) =>
                    j === i ? { ...r, year: e.target.value.replace(/\D/g, '').slice(0, 4) } : r,
                  ),
                )
              }
              inputMode="numeric"
              placeholder="2024"
              aria-label={`Kull ${i + 1}`}
              className="w-24"
            />
            <Select
              value={row.relation}
              onChange={(e) =>
                setRows((list) =>
                  list.map((r, j) =>
                    j === i ? { ...r, relation: e.target.value as Relation } : r,
                  ),
                )
              }
              aria-label={`Tilknytning til kull ${i + 1}`}
            >
              {Object.entries(relationLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
            <Button
              variant="ghost"
              className="h-10 w-10 shrink-0 px-0"
              onClick={() => setRows((list) => list.filter((_, j) => j !== i))}
              aria-label={`Fjern kull ${i + 1}`}
            >
              <Trash2 className="size-4" aria-hidden />
            </Button>
          </div>
        ))}
        {error && <ErrorText>{error}</ErrorText>}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRows((list) => [...list, { year: '', relation: 'student' }])}
          >
            <Plus className="size-4" aria-hidden /> Legg til kull
          </Button>
          <Button type="submit" variant="secondary" size="sm" disabled={busy}>
            {busy ? 'Lagrer …' : 'Lagre kull'}
          </Button>
          {saved && (
            <span role="status" className="text-sm text-emerald-700">
              Lagret.
            </span>
          )}
        </div>
      </form>
    </Section>
  )
}

function Emails({ person }: { person: PersonAdminDetails }) {
  const [email, setEmail] = useState('')
  const { busy, error, run } = useAction()

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void run(async () => {
      await addEmail({ data: { personId: person.personId, email } })
      setEmail('')
    })
  }

  return (
    <Section
      title="Kjente e-postadresser"
      description="Brukes til å koble en konto til riktig profil. Vises aldri for andre medlemmer."
    >
      {person.emails.length === 0 ? (
        <p className="text-sm text-stone-500">Ingen kjente adresser.</p>
      ) : (
        <ul className="divide-y divide-stone-100 rounded-xl ring-1 ring-stone-200 ring-inset">
          {person.emails.map((e) => (
            <li key={e.email} className="flex items-center gap-3 px-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-stone-900">{e.email}</span>
                <span className="text-xs text-stone-500">
                  Fra {sourceLabels[e.source]}
                  {e.login && ' · kontoen logger inn med denne'}
                </span>
              </span>
              {!e.login && (
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy}
                  aria-label={`Fjern ${e.email}`}
                  onClick={() =>
                    confirm(`Fjerne ${e.email}? En konto med adressen kobles ikke lenger hit.`) &&
                    run(() => removeEmail({ data: { personId: person.personId, email: e.email } }))
                  }
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="flex gap-2">
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="navn@example.com"
          aria-label="Ny e-postadresse"
          maxLength={200}
          required
        />
        <Button type="submit" variant="secondary" disabled={busy || !email.trim()}>
          <Plus className="size-4" aria-hidden /> Legg til
        </Button>
      </form>
      {error && <ErrorText>{error}</ErrorText>}
    </Section>
  )
}

/**
 * Samme person to ganger: alt fra duplikatet flyttes hit, eller hit til den andre
 * hvis bare den har konto. To kontoer slås aldri sammen.
 */
function Merge({ person }: { person: PersonAdminDetails }) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<AdminPerson[]>([])
  const { busy, error, run } = useAction()
  const term = query.trim()

  useEffect(() => {
    if (term.length < 2) return
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const found = await findAnyPerson({ data: { q: term } })
        if (!cancelled) setHits(found.filter((p) => p.personId !== person.personId))
      } catch {
        if (!cancelled) setHits([])
      }
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [term, person.personId])

  function merge(other: AdminPerson) {
    const keepOther = other.claimed && !person.claimed
    const [keep, drop] = keepOther
      ? [other.fullName, person.fullName]
      : [person.fullName, other.fullName]
    const question = `Slå sammen ${drop} med ${keep}? Erfaring, kull, e-post, sitater, kilder og innhold flyttes til ${keep}, tomme felt fylles, og ${drop} slettes. Det kan ikke angres.`
    if (!confirm(question)) return
    void run(
      () => mergePerson({ data: { sourceId: other.personId, targetId: person.personId } }),
      async (result) => {
        const { personId } = result as { personId: string }
        await router.invalidate()
        await router.navigate({ to: '/medlemmer/$personId/rediger', params: { personId } })
      },
    )
  }

  return (
    <Section
      title="Slå sammen duplikat"
      description="Finnes personen to ganger? Velg den andre, så flyttes alt hit. Har bare den andre konto, beholdes den."
    >
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400"
          aria-hidden
        />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Søk etter den andre"
          aria-label="Søk etter duplikat"
          className="pl-9"
        />
      </div>
      {term.length >= 2 && (
        <ul className="space-y-1">
          {hits.length === 0 && <li className="text-sm text-stone-500">Ingen treff.</li>}
          {hits.map((p) => {
            const blocked = p.claimed && person.claimed
            return (
              <li
                key={p.personId}
                className="flex items-center gap-3 rounded-xl px-3 py-2 ring-1 ring-stone-200 ring-inset"
              >
                <Avatar name={p.fullName} photo={p.photo} size="sm" muted={!p.claimed} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1 text-sm font-medium text-stone-900">
                    <span className="truncate">{p.fullName}</span>
                    <Verified claimed={p.claimed} />
                  </span>
                  <span className="block text-xs text-stone-500">
                    {kull(p.cohortYears) ?? 'Uten kull'}
                    {blocked && ' · begge har konto, kan ikke slås sammen'}
                  </span>
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy || blocked}
                  onClick={() => merge(p)}
                >
                  <GitMerge className="size-4" aria-hidden /> Slå sammen
                </Button>
              </li>
            )
          })}
        </ul>
      )}
      {error && <ErrorText>{error}</ErrorText>}
    </Section>
  )
}
