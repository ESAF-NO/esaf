import { Link, useRouter, type ErrorComponentProps } from '@tanstack/react-router'
import { AuthCard, AuthShell } from './AuthLayout.tsx'
import { Button, buttonClass } from './ui.tsx'

/**
 * Siden som vises når noe feiler uventet, i stedet for rammeverkets rå
 * feilmelding. Detaljene vises bare i utvikling, så de aldri lekker interne
 * feil til medlemmer.
 */
export function ErrorPage({ error, reset }: ErrorComponentProps) {
  const router = useRouter()
  const retry = () => {
    reset()
    void router.invalidate()
  }
  return (
    <AuthShell>
      <AuthCard
        title="Noe gikk galt"
        subtitle="Siden kunne ikke vises akkurat nå. Prøv igjen, eller gå til forsiden. Skjer det igjen, si fra til styret."
      >
        <div className="flex flex-wrap gap-3">
          <Button variant="brand" onClick={retry}>
            Prøv igjen
          </Button>
          <Link to="/" className={buttonClass({ variant: 'secondary' })}>
            Til forsiden
          </Link>
        </div>
        {import.meta.env.DEV && error instanceof Error && (
          <pre className="mt-6 overflow-x-auto rounded-lg bg-stone-100 p-3 text-xs text-stone-600">
            {error.message}
          </pre>
        )}
      </AuthCard>
    </AuthShell>
  )
}

export function NotFoundPage() {
  return (
    <AuthShell>
      <AuthCard title="Fant ikke siden" subtitle="Lenken kan være gammel, eller siden er fjernet.">
        <Link to="/" className={buttonClass({ variant: 'brand' })}>
          Til forsiden
        </Link>
      </AuthCard>
    </AuthShell>
  )
}
