import { createFileRoute, Link } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  const { viewer } = Route.useRouteContext()

  return (
    <main>
      <h1>ESAF-appen</h1>
      <p className="lead">
        Det lukkede nettverket for ESAF – NTNUs Entreprenørskoles Alumniforening. Appen er under
        utvikling.
      </p>
      <p>
        Alle kan opprette en konto, men innholdet for medlemmer blir først synlig når ESAF har
        godkjent medlemskapet ditt.
      </p>
      {viewer.level === 'anonymous' ? (
        <p className="actions">
          <Link to="/registrer" className="button">
            Registrer deg
          </Link>
          <Link to="/logg-inn">Jeg har allerede konto</Link>
        </p>
      ) : viewer.level === 'pending' ? (
        <p>
          <Link to="/venter">Se status for medlemskapet ditt</Link>
        </p>
      ) : (
        <p>
          <Link to="/medlemmer">Gå til medlemsoversikten</Link>
        </p>
      )}
      <p className="muted">
        Leter du etter informasjon om foreningen? Se <a href="https://esaf.no">esaf.no</a>.
      </p>
    </main>
  )
}
