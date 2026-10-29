import type { MemberRole } from '@esaf/db'

/**
 * Rollene slik de heter i appen, fra minst til mest. Rekkefølgen og reglene
 * speiler `roles` og `permissions` i @esaf/core, som ikke kan importeres i
 * klientkoden. Serveren håndhever reglene; her brukes de bare til visning.
 * Navnene står med liten forbokstav, så de kan brukes midt i en setning.
 */
export const roleNames = {
  member: 'medlem',
  moderator: 'moderator',
  admin: 'admin',
  owner: 'hovedadmin',
} as const satisfies Record<MemberRole, string>

export const roleOrder = Object.keys(roleNames) as MemberRole[]

/** «Hovedadmin», til etiketter og lister. */
export const roleLabel = (role: MemberRole) =>
  roleNames[role].charAt(0).toLocaleUpperCase('nb') + roleNames[role].slice(1)

export const roleAtLeast = (role: MemberRole, minimum: MemberRole) =>
  roleOrder.indexOf(role) >= roleOrder.indexOf(minimum)

/**
 * Admins og hovedadmins må være sterkt innlogget (passkey eller tofaktor) for å
 * bruke rettighetene sine. Speiler `strongAuthRequired` i @esaf/core.
 */
export const needsStrongAuth = (role: MemberRole) => roleAtLeast(role, 'admin')

/** Hva rollen gir, med fornavnet til den som får den. */
export function roleConsequence(role: MemberRole, name: string) {
  return {
    member: `${name} får vanlig medlemskap, uten ekstra rettigheter.`,
    moderator: `Som moderator kan ${name} fjerne andres innlegg og kommentarer.`,
    admin: `Som admin kan ${name} behandle forespørsler, deaktivere medlemmer og moderatorer, rette profiler og lese loggen.`,
    owner: `Som hovedadmin kan ${name} i tillegg gi og fjerne roller, også din, og endre tilgangen til admins.`,
  }[role]
}
