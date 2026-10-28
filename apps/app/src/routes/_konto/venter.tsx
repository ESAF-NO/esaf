import { createFileRoute, Link } from '@tanstack/react-router'

export const Route = createFileRoute('/_konto/venter')({
  head: () => ({ meta: [{ title: 'Medlemskap – ESAF-appen' }] }),
  component: Pending,
})

function Pending() {
  const { viewer } = Route.useRouteContext()

  if (viewer.level === 'member' || viewer.level === 'admin') {
    return (
      <main>
        <h1>Du er godkjent medlem</h1>
        <p>
          <Link to="/medlemmer">Gå til medlemsoversikten</Link>
        </p>
      </main>
    )
  }

  return (
    <main>
      <h1>Medlemskapet ditt</h1>
      {!viewer.emailVerified ? (
        <p>Bekreft e-postadressen din via lenken vi sendte deg.</p>
      ) : viewer.status === 'inactive' ? (
        <p>
          Medlemskapet ditt er ikke aktivt. Ta kontakt med ESAF-styret om du mener dette er feil.
        </p>
      ) : (
        <>
          <p>
            Takk! Kontoen din er registrert og venter på godkjenning fra ESAF. Du får tilgang til
            medlemsinnholdet når medlemskapet er godkjent.
          </p>
          <p className="muted">
            Vi fant ingen profil fra kullisten med denne e-postadressen. Står du der med en annen
            adresse, kan styret koble kontoen din til riktig profil når de behandler forespørselen.
          </p>
        </>
      )}
    </main>
  )
}
