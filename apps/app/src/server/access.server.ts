import { AccessDeniedError, DomainError } from '@esaf/core'
import { notFound, redirect } from '@tanstack/react-router'

/** Oversetter domenefeil til svar klienten forstår, uten å lekke detaljer. */
export function rethrowForClient(error: unknown): never {
  if (error instanceof AccessDeniedError) {
    if (error.reason === 'unauthenticated') throw redirect({ to: '/logg-inn' })
    if (error.reason === 'not_member') throw redirect({ to: '/venter' })
    // Ikke røp at adminsider finnes for vanlige medlemmer.
    throw notFound()
  }
  if (error instanceof DomainError) throw new Error(error.message)
  throw error
}
