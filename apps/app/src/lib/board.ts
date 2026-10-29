import type { BoardRole } from '@esaf/db'

/**
 * Rollene i styret slik de heter i appen, i rekkefølgen styret vises i.
 * Speiler `boardRoles` og `boardRoleNames` i @esaf/core, som ikke kan
 * importeres i klientkoden. Serveren håndhever reglene.
 */
export const boardRoleNames = {
  chair: 'Leder',
  vice_chair: 'Nestleder',
  member: 'Styremedlem',
  deputy: 'Varamedlem',
} as const satisfies Record<BoardRole, string>

export const boardRoleOrder = Object.keys(boardRoleNames) as BoardRole[]

/** Det kan bare være én leder og én nestleder om gangen. */
export const singleSeat = (role: BoardRole) => role === 'chair' || role === 'vice_chair'

/** Rollen som tittel på profilen og i lister: «Styreleder», «Nestleder i styret», «Styremedlem». */
export const boardTitle = (role: BoardRole) =>
  ({
    chair: 'Styreleder',
    vice_chair: 'Nestleder i styret',
    member: 'Styremedlem',
    deputy: 'Varamedlem i styret',
  })[role]

/** Rollen midt i en setning, til loggen: «styreleder», «varamedlem». */
export const boardRoleInSentence = (role: unknown) =>
  ({ chair: 'styreleder', vice_chair: 'nestleder', member: 'styremedlem', deputy: 'varamedlem' })[
    String(role)
  ] ?? 'styremedlem'
