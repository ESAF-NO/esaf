import { schema, type Db } from '@esaf/db'
import { and, desc, eq, gt, inArray, isNull, lt, max, notExists, or, sql } from 'drizzle-orm'
import { assertCan, assertMember, type Viewer } from './access.ts'
import { assertSession, hashApiToken, revokeApiTokensForUser } from './api-tokens.ts'
import { NotFoundError } from './errors.ts'
import { loadViewer, type Tx } from './members.ts'

const { auditEvent, oauthAccessToken, oauthClient, oauthConsent, oauthRefreshToken } = schema

/**
 * MCP-klienter koblet til med OAuth: appen er sin egen OAuth-server (Better Auths
 * oauth-provider-plugin, satt opp i `auth-config.server.ts` i appen), så en admin
 * kan koble Claude, ChatGPT eller Codex til adminverktøyene ved å logge inn i
 * nettleseren og godkjenne, uten å kopiere en nøkkel. Reglene:
 *
 * - Klienter registrerer seg selv (RFC 7591), men får ingenting før en admin
 *   med `mcp.access` i en sterk økt har godkjent dem. Godkjenningen sjekkes på
 *   serveren (se `assertMayApproveMcpClient`), ikke bare på siden.
 * - Rettighetene er `mcp:read` (verktøy som leser) og `mcp:write` (alle).
 *   Adminen kan gi bare lesetilgang selv om klienten ber om mer.
 * - Tilgangsnøklene er ugjennomsiktige, gyldige en time og lagres bare som
 *   SHA-256. De slås opp ved hver forespørsel, og som med MCP-nøkler må kontoen
 *   være aktiv admin og ha passkey eller tofaktor akkurat nå. Fornyelsesnøklene
 *   (30 dager) byttes ut hver gang de brukes.
 * - En tilkobling (godkjenning med nøkler) kan kobles fra av eieren, og fjernes
 *   automatisk sammen med MCP-nøklene når kontoen deaktiveres, mister
 *   adminrollen eller får passkeyene fjernet av en admin.
 * - Alt klienten gjør, merkes med klienten i revisjonsloggen
 *   (`audit_event.oauth_client_id`, se `withMcpAudit`). Godkjenning og
 *   frakobling logges som `mcp_oauth.connect` og `mcp_oauth.disconnect`.
 */

export const MCP_SCOPE_READ = 'mcp:read'
export const MCP_SCOPE_WRITE = 'mcp:write'
/** Rettighetene klientene kan be om. `offline_access` gir fornyelsesnøkkel. */
export const MCP_OAUTH_SCOPES = [MCP_SCOPE_READ, MCP_SCOPE_WRITE, 'offline_access'] as const
/** Prefiks på tilgangs- og fornyelsesnøkler, så de kan kjennes igjen (f.eks. av hemmelighetsskannere). */
export const OAUTH_ACCESS_TOKEN_PREFIX = 'esaf_at_'
export const OAUTH_REFRESH_TOKEN_PREFIX = 'esaf_rt_'
export const OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60
export const OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60

/**
 * Slik lagres nøklene klientene får: SHA-256 (hex), som MCP-nøklene. Gis til
 * pluginen (`storeTokens`), så nøklene kan slås opp her uten den.
 */
export const hashOAuthToken = hashApiToken

const TOKEN_PATTERN = /^esaf_at_[A-Za-z0-9]{32,128}$/

/**
 * Hvem en MCP-forespørsel kommer fra, ut fra en OAuth-tilgangsnøkkel. `null` for
 * ukjente, utløpte og tilbakekalte nøkler, nøkler uten MCP-rettighet eller for en
 * annen ressurs, deaktiverte klienter, og når kontoen ikke lenger har passkey
 * eller tofaktor. Tilgangen ellers (medlemskap, rolle) sjekkes av hver handling
 * som for en vanlig økt.
 */
export async function authenticateOAuthAccessToken(
  db: Db,
  token: string,
  resource: string,
): Promise<Viewer> {
  if (!TOKEN_PATTERN.test(token)) return null
  const stored = hashOAuthToken(token.slice(OAUTH_ACCESS_TOKEN_PREFIX.length))
  const [row] = await db
    .select({
      clientId: oauthAccessToken.clientId,
      userId: oauthAccessToken.userId,
      scopes: oauthAccessToken.scopes,
      resources: oauthAccessToken.resources,
    })
    .from(oauthAccessToken)
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthAccessToken.clientId))
    .where(
      and(
        eq(oauthAccessToken.token, stored),
        isNull(oauthAccessToken.revoked),
        gt(oauthAccessToken.expiresAt, new Date()),
        or(isNull(oauthClient.disabled), eq(oauthClient.disabled, false)),
      ),
    )
  if (!row?.userId) return null
  // Nøkler for en annen ressurs gjelder ikke her (RFC 8707). Uten ressurs er
  // nøkkelen fra denne serveren, som bare har MCP-ressursen.
  if (row.resources?.length && !row.resources.includes(resource)) return null
  const write = row.scopes.includes(MCP_SCOPE_WRITE)
  if (!write && !row.scopes.includes(MCP_SCOPE_READ)) return null
  const viewer = await loadViewer(db, row.userId)
  if (!viewer || !(viewer.twoFactorEnabled || viewer.hasPasskey)) return null
  return { ...viewer, mcp: { oauthClientId: row.clientId, readOnly: !write } }
}

/**
 * Kravet for å godkjenne en MCP-klient: admin med `mcp.access` i en sterk økt
 * fra appen. Kalles av godkjenningssiden og av serveren før godkjenningen lagres.
 */
export function assertMayApproveMcpClient(viewer: Viewer) {
  assertSession(viewer)
  assertCan(viewer, 'mcp.access')
}

/** Det godkjenningssiden viser om en klient. Alt utenom id-en er oppgitt av klienten selv. */
export type McpClientView = {
  clientId: string
  name: string | null
  uri: string | null
  /** Vertsnavnene innloggingen sendes tilbake til, f.eks. `claude.ai` eller `localhost`. */
  redirectHosts: string[]
  disabled: boolean
}

export async function getMcpClient(db: Db, clientId: string): Promise<McpClientView | null> {
  const [row] = await db
    .select({
      clientId: oauthClient.clientId,
      name: oauthClient.name,
      uri: oauthClient.uri,
      redirectUris: oauthClient.redirectUris,
      disabled: oauthClient.disabled,
    })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId))
  if (!row) return null
  const hosts = row.redirectUris.flatMap((uri) => {
    try {
      return [new URL(uri).hostname]
    } catch {
      return []
    }
  })
  return {
    clientId: row.clientId,
    name: row.name?.trim() || null,
    uri: row.uri,
    redirectHosts: [...new Set(hosts)],
    disabled: row.disabled === true,
  }
}

/** Logger at den innloggede har godkjent en klient. */
export async function recordMcpConnect(
  db: Db,
  viewer: Viewer,
  input: { clientId: string; scopes: string[] },
): Promise<void> {
  assertMayApproveMcpClient(viewer)
  const client = await getMcpClient(db, input.clientId)
  await db.transaction(async (tx) => {
    await tx.insert(auditEvent).values({
      actorPersonId: viewer!.personId,
      action: 'mcp_oauth.connect',
      subjectPersonId: viewer!.personId,
      details: {
        clientId: input.clientId,
        name: client?.name ?? null,
        readOnly: !input.scopes.includes(MCP_SCOPE_WRITE),
        redirectHosts: client?.redirectHosts ?? [],
      },
    })
  })
}

export type McpConnectionView = {
  clientId: string
  name: string | null
  redirectHosts: string[]
  readOnly: boolean
  connectedAt: Date
  /** Sist klienten fikk en ny tilgangsnøkkel (hver time den er i bruk). */
  lastActiveAt: Date | null
}

/** Klientene den innloggede har koblet til med OAuth, nyeste først. */
export async function listMcpConnections(db: Db, viewer: Viewer): Promise<McpConnectionView[]> {
  assertSession(viewer)
  assertMember(viewer)
  const lastActive = db
    .select({
      clientId: oauthAccessToken.clientId,
      at: max(oauthAccessToken.createdAt).as('at'),
    })
    .from(oauthAccessToken)
    .where(eq(oauthAccessToken.userId, viewer.userId))
    .groupBy(oauthAccessToken.clientId)
    .as('last_active')
  const rows = await db
    .select({
      clientId: oauthConsent.clientId,
      scopes: oauthConsent.scopes,
      createdAt: oauthConsent.createdAt,
      name: oauthClient.name,
      redirectUris: oauthClient.redirectUris,
      lastActiveAt: lastActive.at,
    })
    .from(oauthConsent)
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
    .leftJoin(lastActive, eq(lastActive.clientId, oauthConsent.clientId))
    .where(eq(oauthConsent.userId, viewer.userId))
    .orderBy(desc(oauthConsent.createdAt))
  return rows.map((r) => ({
    clientId: r.clientId,
    name: r.name?.trim() || null,
    redirectHosts: [
      ...new Set(
        r.redirectUris.flatMap((uri) => {
          try {
            return [new URL(uri).hostname]
          } catch {
            return []
          }
        }),
      ),
    ],
    readOnly: !r.scopes.includes(MCP_SCOPE_WRITE),
    connectedAt: r.createdAt ?? new Date(0),
    lastActiveAt: r.lastActiveAt ? new Date(r.lastActiveAt) : null,
  }))
}

/**
 * Fjerner godkjenningen og alle nøkler en klient (eller alle klienter) har for en
 * konto. Gir antallet godkjenninger som ble fjernet.
 */
async function deleteConnection(tx: Tx, userId: string, clientId?: string): Promise<number> {
  await tx
    .delete(oauthAccessToken)
    .where(
      and(
        eq(oauthAccessToken.userId, userId),
        clientId ? eq(oauthAccessToken.clientId, clientId) : undefined,
      ),
    )
  await tx
    .delete(oauthRefreshToken)
    .where(
      and(
        eq(oauthRefreshToken.userId, userId),
        clientId ? eq(oauthRefreshToken.clientId, clientId) : undefined,
      ),
    )
  const consents = await tx
    .delete(oauthConsent)
    .where(
      and(
        eq(oauthConsent.userId, userId),
        clientId ? eq(oauthConsent.clientId, clientId) : undefined,
      ),
    )
    .returning({ clientId: oauthConsent.clientId })
  return consents.length
}

/** Kobler fra en av den innloggedes klienter. Den må godkjennes på nytt for å virke igjen. */
export async function disconnectMcpClient(db: Db, viewer: Viewer, clientId: string): Promise<void> {
  assertSession(viewer)
  assertMember(viewer)
  const client = await getMcpClient(db, clientId)
  await db.transaction(async (tx) => {
    const removed = await deleteConnection(tx, viewer.userId, clientId)
    if (!removed) throw new NotFoundError('Fant ikke tilkoblingen.')
    await tx.insert(auditEvent).values({
      actorPersonId: viewer.personId,
      action: 'mcp_oauth.disconnect',
      subjectPersonId: viewer.personId,
      details: { clientId, name: client?.name ?? null },
    })
  })
}

/**
 * Trekker tilbake all MCP-tilgang til en konto, i en transaksjon som allerede er
 * i gang (deaktivering, tap av adminrollen, fjernede passkeys): MCP-nøklene og
 * alle OAuth-tilkoblingene. Den som kaller, logger handlingen med antallene.
 */
export async function revokeMcpAccessForUser(
  tx: Tx,
  userId: string,
): Promise<{ revokedTokens?: number; revokedConnections?: number }> {
  const tokens = await revokeApiTokensForUser(tx, userId)
  const connections = await deleteConnection(tx, userId)
  return {
    ...(tokens ? { revokedTokens: tokens } : {}),
    ...(connections ? { revokedConnections: connections } : {}),
  }
}

/** Hvor lenge en registrert klient får ligge uten å bli godkjent. */
const UNUSED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Rydder i OAuth-tabellene: utløpte tilgangs- og fornyelsesnøkler, og klienter
 * som registrerte seg men aldri ble godkjent (eller ble koblet fra), når de er
 * eldre enn et døgn og ikke står i revisjonsloggen. Hvem som helst kan
 * registrere en klient, så uten dette ville tabellen bare vokse. Gir antallene.
 */
export async function pruneOAuth(
  db: Db,
  now = new Date(),
): Promise<{ accessTokens: number; refreshTokens: number; clients: number }> {
  return db.transaction(async (tx) => {
    const accessTokens = await tx
      .delete(oauthAccessToken)
      .where(lt(oauthAccessToken.expiresAt, now))
      .returning({ id: oauthAccessToken.id })
    const refreshTokens = await tx
      .delete(oauthRefreshToken)
      .where(
        or(
          lt(oauthRefreshToken.expiresAt, now),
          // Tilbakekalte og utbyttede nøkler trengs bare en stund, mot gjenbruk.
          lt(oauthRefreshToken.revoked, new Date(now.getTime() - UNUSED_CLIENT_TTL_MS)),
        ),
      )
      .returning({ id: oauthRefreshToken.id })
    const unused = await tx
      .select({ clientId: oauthClient.clientId })
      .from(oauthClient)
      .where(
        and(
          lt(oauthClient.createdAt, new Date(now.getTime() - UNUSED_CLIENT_TTL_MS)),
          notExists(
            tx
              .select({ one: sql`1` })
              .from(oauthConsent)
              .where(eq(oauthConsent.clientId, oauthClient.clientId)),
          ),
          notExists(
            tx
              .select({ one: sql`1` })
              .from(oauthRefreshToken)
              .where(eq(oauthRefreshToken.clientId, oauthClient.clientId)),
          ),
          notExists(
            tx
              .select({ one: sql`1` })
              .from(auditEvent)
              .where(eq(auditEvent.oauthClientId, oauthClient.clientId)),
          ),
        ),
      )
      .limit(1000)
    const ids = unused.map((c) => c.clientId)
    if (ids.length) {
      await tx.delete(oauthAccessToken).where(inArray(oauthAccessToken.clientId, ids))
      await tx.delete(oauthClient).where(inArray(oauthClient.clientId, ids))
    }
    return {
      accessTokens: accessTokens.length,
      refreshTokens: refreshTokens.length,
      clients: ids.length,
    }
  })
}
