import { useState, type FormEvent } from 'react'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import type { UnclaimedProfile } from '@esaf/core'
import {
  decidePendingMembership,
  findUnclaimedProfiles,
  getPendingMemberships,
  linkPendingToProfile,
} from '#/lib/members.functions.ts'

export const Route = createFileRoute('/_konto/admin')({
  head: () => ({ meta: [{ title: 'Admin – ESAF-appen' }] }),
  loader: () => getPendingMemberships(),
  component: Admin,
  errorComponent: ({ error }) => (
    <main>
      <h1>Noe gikk galt</h1>
      <p>{error instanceof Error ? error.message : 'Noe gikk galt.'}</p>
    </main>
  ),
})

function Admin() {
  const pending = Route.useLoaderData()
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function run(personId: string, action: () => Promise<unknown>) {
    setBusy(personId)
    setError(null)
    try {
      await action()
      await router.invalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Noe gikk galt.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <main>
      <h1>Ventende medlemskap</h1>
      <p className="muted">
        Kontoer som ikke matchet en profil fra kullisten. Finnes personen allerede som profil
        (f.eks. med en gammel e-postadresse), koble kontoen til profilen i stedet for å godkjenne en
        ny.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {pending.length === 0 ? (
        <p>Ingen venter på godkjenning.</p>
      ) : (
        <ul className="list">
          {pending.map((p) => (
            <li key={p.personId} className="stack">
              <div className="row">
                <span>
                  <strong>{p.fullName}</strong> <span className="muted">{p.email}</span>
                </span>
                <span className="actions">
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      run(p.personId, () =>
                        decidePendingMembership({
                          data: { personId: p.personId, decision: 'approve' },
                        }),
                      )
                    }
                  >
                    Godkjenn som ny
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy !== null}
                    onClick={() =>
                      run(p.personId, () =>
                        decidePendingMembership({
                          data: { personId: p.personId, decision: 'reject' },
                        }),
                      )
                    }
                  >
                    Avslå
                  </button>
                </span>
              </div>
              <LinkToProfile
                name={p.fullName}
                disabled={busy !== null}
                onLink={(profile) =>
                  run(p.personId, () =>
                    linkPendingToProfile({
                      data: { pendingPersonId: p.personId, profilePersonId: profile.personId },
                    }),
                  )
                }
              />
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}

function LinkToProfile(props: {
  name: string
  disabled: boolean
  onLink: (profile: UnclaimedProfile) => void
}) {
  const [results, setResults] = useState<UnclaimedProfile[] | null>(null)

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const query = String(new FormData(event.currentTarget).get('query'))
    setResults(await findUnclaimedProfiles({ data: { query } }))
  }

  return (
    <details className="link-profile">
      <summary>Koble til eksisterende profil</summary>
      <form onSubmit={search} className="inline-form">
        <label>
          <span className="visually-hidden">Søk etter profil</span>
          <input name="query" defaultValue={props.name} minLength={2} required />
        </label>
        <button type="submit" className="secondary">
          Søk
        </button>
      </form>
      {results &&
        (results.length === 0 ? (
          <p className="muted">Ingen profiler som ikke er tatt i bruk matcher søket.</p>
        ) : (
          <ul className="results">
            {results.map((r) => (
              <li key={r.personId} className="row">
                <span>
                  {r.fullName}
                  {r.cohortYears.length > 0 && (
                    <span className="muted"> · kull {r.cohortYears.join(', ')}</span>
                  )}
                </span>
                <button type="button" disabled={props.disabled} onClick={() => props.onLink(r)}>
                  Koble
                </button>
              </li>
            ))}
          </ul>
        ))}
    </details>
  )
}
