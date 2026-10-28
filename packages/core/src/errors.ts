export type AccessDeniedReason = 'unauthenticated' | 'not_member' | 'not_admin'

/** Kastes når en handling krever mer tilgang enn den som spør har. */
export class AccessDeniedError extends Error {
  readonly reason: AccessDeniedReason

  constructor(reason: AccessDeniedReason) {
    super(
      {
        unauthenticated: 'Du må logge inn.',
        not_member: 'Krever godkjent ESAF-medlemskap.',
        not_admin: 'Krever adminrolle i ESAF.',
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
