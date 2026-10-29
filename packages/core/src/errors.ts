export type AccessDeniedReason =
  'unauthenticated' | 'not_member' | 'forbidden' | 'strong_auth_required'

/** Kastes når en handling krever mer tilgang enn den som spør har. */
export class AccessDeniedError extends Error {
  readonly reason: AccessDeniedReason

  constructor(reason: AccessDeniedReason) {
    super(
      {
        unauthenticated: 'Du må logge inn.',
        not_member: 'Krever godkjent ESAF-medlemskap.',
        forbidden: 'Du har ikke tilgang til dette.',
        strong_auth_required:
          'Logg inn med passkey eller slå på tofaktor for å bruke adminverktøyene.',
      }[reason],
    )
    this.name = 'AccessDeniedError'
    this.reason = reason
  }
}

export class DomainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DomainError'
  }
}

/** Ressursen finnes ikke, eller den som spør skal ikke vite at den finnes. */
export class NotFoundError extends DomainError {
  constructor(message = 'Fant ikke det du lette etter.') {
    super(message)
    this.name = 'NotFoundError'
  }
}
