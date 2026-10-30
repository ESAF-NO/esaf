import { createHash, randomBytes } from 'node:crypto'
import { schema, type Db } from '@esaf/db'
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { assertCan, assertMember, type Viewer } from './access.ts'
import { AccessDeniedError, DomainError, NotFoundError } from './errors.ts'
import { loadViewer, type Tx } from './members.ts'

const { apiToken, auditEvent, user } = schema

/**
 * MCP-nøkler: personlige nøkler som kobler en MCP-klient (f.eks. Claude) til
 * adminverktøyene. Reglene:
 *
 * - Bare admins og hovedadmins (`mcp.access`) i en sterk økt kan lage en nøkkel,
 *   og bare fra appen: en nøkkel kan ikke lage eller trekke tilbake nøkler.
 * - Nøkkelen er 256 tilfeldige bit med prefikset `esaf_`. Bare SHA-256 av den
 *   lagres, og den vises én gang. Oppslag skjer på hashen.
 * - En nøkkel gir aldri mer enn kontoen har akkurat nå. Medlemskapet og rollen
 *   slås opp ved hver forespørsel, så en deaktivert admin eller en som har
 *   mistet rollen, kan ikke gjøre noe med nøkkelen. Den regnes som sterk
 *   innlogging bare så lenge kontoen har passkey eller tofaktor.
 * - Nøkler går ut (høyst ett år), kan trekkes tilbake av eieren, og trekkes
 *   tilbake automatisk når kontoen deaktiveres, mister adminrollen eller får
 *   passkeyene fjernet av en admin.
 * - `readOnly`: MCP-serveren viser bare verktøy som leser.
 * - Alt som gjøres med en nøkkel, merkes i revisjonsloggen (`audit_event.api_token_id`,
 *   se `withApiTokenAudit`). Oppretting og tilbaketrekking logges som
 *   `mcp_token.create` og `mcp_token.revoke`.
 */

export const API_TOKEN_PREFIX = 'esaf_'
export const API_TOKEN_MAX_DAYS = 365
/** Høyst så mange gyldige nøkler per konto. */
export const API_TOKEN_MAX_ACTIVE = 10
/** `lastUsedAt` oppdateres ikke oftere enn dette. */
const LAST_USED_RESOLUTION_MS = 60_000

const TOKEN_PATTERN = /^esaf_[A-Za-z0-9_-]{43}$/

export function hashApiToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export const apiTokenInput = z.object({
  name: z.string().trim().min(2, 'Gi nøkkelen et navn.').max(80, 'Maks 80 tegn.'),
  days: z
    .number()
    .int()
    .min(1, 'Minst én dag.')
    .max(API_TOKEN_MAX_DAYS, `Høyst ${API_TOKEN_MAX_DAYS} dager.`),
  readOnly: z.boolean(),
})

export type ApiTokenInput = z.input<typeof apiTokenInput>

export type ApiTokenStatus = 'active' | 'expired' | 'revoked'

export type ApiTokenView = {
  id: string
  name: string
  prefix: string
  readOnly: boolean
  status: ApiTokenStatus
  createdAt: Date
  expiresAt: Date
  lastUsedAt: Date | null
  revokedAt: Date | null
}

function statusOf(row: { revokedAt: Date | null; expiresAt: Date }, now = new Date()) {
  if (row.revokedAt) return 'revoked' as const
  if (row.expiresAt <= now) return 'expired' as const
  return 'active' as const
}

function toView(row: typeof apiToken.$inferSelect): ApiTokenView {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    readOnly: row.readOnly,
    status: statusOf(row),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  }
}

/** Nøkler håndteres bare fra appen, i en ekte økt. */
function assertSession(viewer: Viewer) {
  if (viewer?.apiToken) throw new AccessDeniedError('forbidden')
}

/**
 * Lager en nøkkel og gir den tilbake én gang. Krever `mcp.access` (admin, sterkt
 * innlogget) og en økt fra appen.
 */
export async function createApiToken(
  db: Db,
  viewer: Viewer,
  input: ApiTokenInput,
): Promise<{ token: string; view: ApiTokenView }> {
  assertSession(viewer)
  assertCan(viewer, 'mcp.access')
  const parsed = apiTokenInput.safeParse(input)
  if (!parsed.success) throw new DomainError(parsed.error.issues[0]?.message ?? 'Ugyldige felt.')
  const { name, days, readOnly } = parsed.data
  const token = API_TOKEN_PREFIX + randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000)

  const row = await db.transaction(async (tx) => {
    // Lås kontoen, så to samtidige forespørsler ikke går forbi grensen. Å låse
    // nøklene alene holder ikke: en ny nøkkel fra den andre forespørselen er
    // ikke låst, og telles ikke.
    await tx.select({ id: user.id }).from(user).where(eq(user.id, viewer.userId)).for('update')
    const active = await tx
      .select({ id: apiToken.id })
      .from(apiToken)
      .where(
        and(
          eq(apiToken.userId, viewer.userId),
          isNull(apiToken.revokedAt),
          gt(apiToken.expiresAt, new Date()),
        ),
      )
    if (active.length >= API_TOKEN_MAX_ACTIVE) {
      throw new DomainError(
        `Du har allerede ${API_TOKEN_MAX_ACTIVE} gyldige nøkler. Trekk tilbake en du ikke bruker.`,
      )
    }
    const [created] = await tx
      .insert(apiToken)
      .values({
        userId: viewer.userId,
        name,
        tokenHash: hashApiToken(token),
        prefix: token.slice(0, API_TOKEN_PREFIX.length + 6),
        readOnly,
        expiresAt,
      })
      .returning()
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'mcp_token.create',
      subjectPersonId: viewer.personId,
      details: { tokenId: created!.id, name, readOnly, expiresAt: expiresAt.toISOString() },
    })
    return created!
  })
  return { token, view: toView(row) }
}

/** Den innloggedes egne nøkler, nyeste først. */
export async function listApiTokens(db: Db, viewer: Viewer): Promise<ApiTokenView[]> {
  assertSession(viewer)
  assertMember(viewer)
  const rows = await db
    .select()
    .from(apiToken)
    .where(eq(apiToken.userId, viewer.userId))
    .orderBy(desc(apiToken.createdAt))
  return rows.map(toView)
}

/** Trekker tilbake en av den innloggedes egne nøkler. */
export async function revokeApiToken(db: Db, viewer: Viewer, tokenId: string): Promise<void> {
  assertSession(viewer)
  assertMember(viewer)
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(apiToken)
      .where(and(eq(apiToken.id, tokenId), eq(apiToken.userId, viewer.userId)))
      .for('update')
    if (!row) throw new NotFoundError('Fant ikke nøkkelen.')
    if (row.revokedAt) return
    await tx.update(apiToken).set({ revokedAt: new Date() }).where(eq(apiToken.id, tokenId))
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'mcp_token.revoke',
      subjectPersonId: viewer.personId,
      details: { tokenId, name: row.name },
    })
  })
}

/**
 * Trekker tilbake alle gyldige nøkler til en konto, i en transaksjon som allerede
 * er i gang (deaktivering, tap av adminrollen, fjernede passkeys). Gir antallet.
 * Den som kaller, logger handlingen og tar med antallet.
 */
export async function revokeApiTokensForUser(tx: Tx, userId: string): Promise<number> {
  const revoked = await tx
    .update(apiToken)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiToken.userId, userId), isNull(apiToken.revokedAt)))
    .returning({ id: apiToken.id })
  return revoked.length
}

/**
 * Hvem en MCP-forespørsel kommer fra, ut fra nøkkelen i `Authorization`. `null`
 * for ukjente, utløpte og tilbaketrukne nøkler, og når kontoen ikke lenger har
 * passkey eller tofaktor. Tilgangen ellers (medlemskap, rolle) sjekkes av hver
 * handling som for en vanlig økt.
 */
export async function authenticateApiToken(db: Db, token: string): Promise<Viewer> {
  if (!TOKEN_PATTERN.test(token)) return null
  const now = new Date()
  const [row] = await db
    .select({
      id: apiToken.id,
      userId: apiToken.userId,
      readOnly: apiToken.readOnly,
      lastUsedAt: apiToken.lastUsedAt,
    })
    .from(apiToken)
    .where(
      and(
        eq(apiToken.tokenHash, hashApiToken(token)),
        isNull(apiToken.revokedAt),
        gt(apiToken.expiresAt, now),
      ),
    )
  if (!row) return null
  const viewer = await loadViewer(db, row.userId)
  if (!viewer || !(viewer.twoFactorEnabled || viewer.hasPasskey)) return null
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
    await db.update(apiToken).set({ lastUsedAt: now }).where(eq(apiToken.id, row.id))
  }
  return { ...viewer, apiToken: { id: row.id, readOnly: row.readOnly } }
}

/**
 * Databasen for en forespørsel med nøkkel: hver transaksjon setter
 * `esaf.api_token_id`, så alt den skriver til revisjonsloggen, merkes med
 * nøkkelen (standardverdien til `audit_event.api_token_id`). Settingen gjelder
 * bare transaksjonen (`set_config(…, true)`), så den lekker ikke til andre
 * forespørsler som får samme tilkobling fra poolen. Alle hendelser i loggen
 * skrives i en transaksjon.
 */
export function withApiTokenAudit(db: Db, tokenId: string): Db {
  const transaction: Db['transaction'] = (run, config) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('esaf.api_token_id', ${tokenId}, true)`)
      return run(tx)
    }, config)
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'transaction') return transaction
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
