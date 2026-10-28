import { useState, type FormEvent } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { authClient } from '#/lib/auth-client.ts'

export const Route = createFileRoute('/registrer')({
  head: () => ({ meta: [{ title: 'Registrer deg – ESAF-appen' }] }),
  component: SignUp,
})

function SignUp() {
  const [state, setState] = useState<'idle' | 'pending' | 'sent'>('idle')
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setState('pending')
    setError(null)
    const { error } = await authClient.signUp.email({
      name: String(form.get('name')),
      email: String(form.get('email')),
      password: String(form.get('password')),
      callbackURL: '/venter',
    })
    if (error) {
      setState('idle')
      setError(error.message ?? 'Kunne ikke opprette konto.')
      return
    }
    setState('sent')
  }

  if (state === 'sent') {
    return (
      <main>
        <h1>Sjekk e-posten din</h1>
        <p>Vi har sendt deg en lenke for å bekrefte e-postadressen.</p>
        {import.meta.env.DEV && (
          <p className="muted">Lokalt utviklingsmiljø: lenken skrives ut i serverloggen.</p>
        )}
      </main>
    )
  }

  return (
    <main>
      <h1>Registrer deg</h1>
      <p>
        Etter at du har bekreftet e-posten, må ESAF godkjenne medlemskapet før du får tilgang til
        medlemsinnhold.
      </p>
      <form onSubmit={onSubmit} className="form">
        <label>
          Fullt navn
          <input name="name" autoComplete="name" required />
        </label>
        <label>
          E-post
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Passord (minst 12 tegn)
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
          />
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button type="submit" disabled={state === 'pending'}>
          {state === 'pending' ? 'Oppretter …' : 'Opprett konto'}
        </button>
      </form>
      <p>
        Har du konto? <Link to="/logg-inn">Logg inn</Link>
      </p>
    </main>
  )
}
