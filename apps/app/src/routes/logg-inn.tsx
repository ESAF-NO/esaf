import { useState, type FormEvent } from 'react'
import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { authClient } from '#/lib/auth-client.ts'

export const Route = createFileRoute('/logg-inn')({
  head: () => ({ meta: [{ title: 'Logg inn – ESAF-appen' }] }),
  component: SignIn,
})

function SignIn() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    setError(null)
    const { error } = await authClient.signIn.email({
      email: String(form.get('email')),
      password: String(form.get('password')),
    })
    setPending(false)
    if (error) {
      setError(
        error.status === 403
          ? 'Du må bekrefte e-postadressen din før du kan logge inn.'
          : 'Feil e-post eller passord.',
      )
      return
    }
    await router.invalidate()
    await router.navigate({ to: '/medlemmer' })
  }

  return (
    <main>
      <h1>Logg inn</h1>
      <form onSubmit={onSubmit} className="form">
        <label>
          E-post
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Passord
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button type="submit" disabled={pending}>
          {pending ? 'Logger inn …' : 'Logg inn'}
        </button>
      </form>
      <p>
        Ny her? <Link to="/registrer">Registrer deg</Link>
      </p>
    </main>
  )
}
