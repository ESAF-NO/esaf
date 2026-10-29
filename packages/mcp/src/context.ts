import { AccessDeniedError, DomainError, type ObjectStorage, type Viewer } from '@esaf/core'
import type { Db } from '@esaf/db'
import type { CallToolResult, McpServer, ToolAnnotations } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { ImageFetcher } from './images.ts'

/** Det verktøyene trenger for én forespørsel. */
export type ToolContext = {
  /** Databasen, merket med nøkkelen så revisjonsloggen viser at det kom fra MCP. */
  db: Db
  storage: ObjectStorage
  viewer: NonNullable<Viewer>
  fetchImage: ImageFetcher
  /** Adressen til appen, for lenker i svarene, f.eks. `https://app.esaf.no`. */
  appUrl: string
}

/** Hvor mye verktøyet endrer, for `annotations` og nøkler med bare lesing. */
type Effect = 'read' | 'write' | 'destructive'

type ToolDefinition<S extends z.ZodObject> = {
  name: string
  title: string
  description: string
  input: S
  effect: Effect
  /** Gjør det samme om det kalles to ganger med samme input. */
  idempotent?: boolean
  run: (args: z.output<S>, ctx: ToolContext) => Promise<unknown>
}

/** Svaret som tekst. Kompakt JSON; datoer blir ISO-strenger. */
export function jsonResult(value: unknown): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value ?? { ok: true }),
      },
    ],
  }
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] }
}

/**
 * Feil fra domenet som melding til modellen. Tilgangsfeil sier hva som mangler,
 * uten å røpe mer. Ukjente feil logges på serveren og blir en generell melding,
 * så SQL og stakkspor aldri sendes ut.
 */
export function toolError(error: unknown): CallToolResult {
  if (error instanceof AccessDeniedError) {
    return errorResult(
      {
        unauthenticated: 'MCP-nøkkelen gjelder ikke lenger. Lag en ny under Konto og sikkerhet.',
        not_member: 'Kontoen bak MCP-nøkkelen er ikke aktivt medlem.',
        forbidden: 'Rollen din gir ikke tilgang til dette.',
        strong_auth_required: 'Kontoen må ha passkey eller tofaktor for å bruke adminverktøyene.',
      }[error.reason],
    )
  }
  if (error instanceof DomainError) return errorResult(error.message)
  console.error('[esaf/mcp] Feil i et verktøy:', error)
  return errorResult('Noe gikk galt på serveren. Prøv igjen, eller sjekk loggen.')
}

/**
 * Registrerer et verktøy. Verktøy som endrer noe, finnes ikke for nøkler med bare
 * lesing. Rettighetene sjekkes uansett av @esaf/core ved hvert kall.
 */
export function defineTool<S extends z.ZodObject>(
  server: McpServer,
  ctx: ToolContext,
  def: ToolDefinition<S>,
) {
  if (def.effect !== 'read' && ctx.viewer.apiToken?.readOnly) return
  const annotations: ToolAnnotations = {
    title: def.title,
    readOnlyHint: def.effect === 'read',
    destructiveHint: def.effect === 'destructive',
    idempotentHint: def.effect === 'read' || def.idempotent === true,
    openWorldHint: false,
  }
  server.registerTool(
    def.name,
    { title: def.title, description: def.description, inputSchema: def.input, annotations },
    // SDK-typen for tilbakekallet er generisk over skjemaet; argumentene er validert mot `def.input`.
    (async (args: z.output<S>) => {
      try {
        return jsonResult(await def.run(args, ctx))
      } catch (error) {
        return toolError(error)
      }
    }) as never,
  )
}

// Felles byggeklosser for input. Bare form og beskrivelser her; full validering
// (lengder, formater, regler) skjer i @esaf/core, med norske feilmeldinger.

export const id = (what: string) => z.uuid().describe(`${what} (UUID).`)

export const page = {
  limit: z.number().int().min(1).max(200).default(50).describe('Max items to return (1–200).'),
  offset: z.number().int().min(0).default(0).describe('Items to skip, for paging.'),
}

export function paginate<T>(items: T[], { limit, offset }: { limit: number; offset: number }) {
  return {
    total: items.length,
    offset,
    items: items.slice(offset, offset + limit),
    more: offset + limit < items.length,
  }
}

export const reason = z
  .string()
  .min(3)
  .max(500)
  .describe('Short justification, stored in the audit log (Norwegian is fine).')

export const confidence = z
  .enum(['high', 'medium', 'low'])
  .describe(
    'How sure the source is. high = official/primary source (company site, registry, the person). ' +
      'medium = reputable secondary source (news). low = inferred or uncertain; hidden from members until reviewed.',
  )

export const sourceInput = z.object({
  field: z
    .string()
    .describe('The field the source supports, e.g. "bio", "linkedinUrl", "website".'),
  label: z
    .string()
    .max(80)
    .optional()
    .describe('Source name as shown to members, e.g. "proff.no". Defaults to the URL domain.'),
  url: z.string().max(500).optional().describe('Public http(s) URL of the source.'),
  confidence,
})

export const cohortInput = z.object({
  graduationYear: z
    .number()
    .int()
    .describe('Graduation year as ES names cohorts: "ES 2024" started autumn 2022.'),
  relation: z
    .enum(['student', 'staff', 'mentor'])
    .default('student')
    .describe('student (default), staff or mentor.'),
})

export const experienceInput = z.object({
  companyId: z.uuid().optional().describe('Existing company id. Preferred when known.'),
  company: z
    .string()
    .max(120)
    .describe('Company name. Matched to an existing company by slug, or created.'),
  title: z.string().max(120).nullable().optional().describe('Job title.'),
  startYear: z.number().int().nullable().optional(),
  endYear: z.number().int().nullable().optional().describe('Omit or null = current position.'),
  founder: z.boolean().default(false).describe('The person founded the company.'),
})

/** Erfaring fra MCP-input til formen @esaf/core vil ha. */
export function toExperience(e: z.output<typeof experienceInput>) {
  return {
    companyId: e.companyId ?? null,
    company: e.company,
    title: e.title ?? null,
    startYear: e.startYear ?? null,
    endYear: e.endYear ?? null,
    founder: e.founder,
  }
}

export const imageInput = {
  imageUrl: z
    .string()
    .max(2000)
    .optional()
    .describe('Public http(s) URL of a JPEG, PNG or WebP image. The server downloads it.'),
  imageBase64: z
    .string()
    .optional()
    .describe('The image as base64 (or a data: URL), when it is not on the web. Max 10 MB.'),
}

/** Bildet fra en adresse eller base64. Nøyaktig én av dem. */
export async function readImage(
  ctx: ToolContext,
  input: { imageUrl?: string; imageBase64?: string },
  decode: (data: string) => Uint8Array,
): Promise<Uint8Array> {
  if (!!input.imageUrl === !!input.imageBase64) {
    throw new DomainError('Oppgi enten imageUrl eller imageBase64.')
  }
  return input.imageUrl ? ctx.fetchImage(input.imageUrl) : decode(input.imageBase64!)
}

/** Lenker til appen i svarene. */
export const links = {
  person: (ctx: ToolContext, personId: string) => `${ctx.appUrl}/medlemmer/${personId}`,
  company: (ctx: ToolContext, slug: string) => `${ctx.appUrl}/selskaper/${slug}`,
  event: (ctx: ToolContext, typeSlug: string, eventId: string) =>
    `${ctx.appUrl}/arrangementer/${typeSlug}/${eventId}`,
  /** Bilder og logoer har relative adresser i appen; de krever innlogging. */
  asset: (ctx: ToolContext, path: string | null | undefined) =>
    path ? `${ctx.appUrl}${path}` : null,
}
