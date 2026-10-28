import { AccessDeniedError, DomainError, NotFoundError, type Viewer } from '@esaf/core'
import { notFound, redirect } from '@tanstack/react-router'
import { getRequestViewer } from './viewer.server.ts'

/** Oversetter domenefeil til svar klienten forstår, uten å lekke detaljer. */
export function rethrowForClient(error: unknown): never {
  if (error instanceof AccessDeniedError) {
    if (error.reason === 'unauthenticated') throw redirect({ to: '/logg-inn' })
    if (error.reason === 'not_member') throw redirect({ to: '/venter' })
    // Rollen er der, men tofaktor mangler: send dit det slås på.
    if (error.reason === 'two_factor_required') {
      throw redirect({ to: '/konto', search: { krav: 'tofaktor' } })
    }
    // Ikke røp at adminsider finnes for dem uten rettigheten.
    throw notFound()
  }
  if (error instanceof NotFoundError) throw notFound()
  if (error instanceof DomainError) throw new Error(error.message)
  throw error
}

/** Kjører en domenefunksjon med den innloggede som `viewer`, og oversetter feil for klienten. */
export async function withViewer<T>(fn: (viewer: Viewer) => Promise<T>): Promise<T> {
  try {
    return await fn(await getRequestViewer())
  } catch (error) {
    return rethrowForClient(error)
  }
}
