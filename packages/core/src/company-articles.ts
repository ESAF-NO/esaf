import { schema, type CompanyArticleSource, type Db, type DatePrecision } from '@esaf/db'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Viewer } from './access.ts'
import { companyForEdit } from './companies.ts'
import { DomainError, NotFoundError } from './errors.ts'
import type { Tx } from './members.ts'
import { hostLabel, optionalText, safeHttpUrl } from './validation.ts'

const { auditEvent, companyArticle } = schema

/**
 * «I media»: saker i aviser og på nettsteder om et selskap. Reglene:
 *
 * - Bare lenken, tittelen, utgiveren, datoen og to merker (betalingsmur, nevner
 *   ES) lagres. Teksten i saken lagres aldri.
 * - De samme som kan redigere selskapsinfoen, kan legge til, rette og fjerne
 *   saker: gründere (også tidligere), ES-teamet, de som jobber der nå og admins
 *   med `profiles.edit`. Admins som ikke selv er knyttet til selskapet, logges.
 *   Andre medlemmer foreslår saker (se `suggestCompanyArticle` i contributions.ts).
 * - Lenken må være http eller https. Samme sak står bare én gang per selskap, også
 *   når lenken er skrevet litt ulikt (med eller uten «www.», sporingsparametre,
 *   skråstrek til slutt eller `#`-del); se `articleUrlKey`.
 */

const collapseSpaces = (v: string) => v.replace(/\s+/g, ' ')
const pad = (n: number) => String(n).padStart(2, '0')

/** Sporingsparametre som ikke endrer hvilken sak lenken går til. */
const TRACKING_PARAM = /^(utm_.*|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|_ga|_gl|ref_src)$/i

/**
 * Gjør en lenke til en sak om til formen som lagres: bare http og https, uten
 * brukernavn og passord, uten `#`-del og uten sporingsparametre. Lenker uten
 * protokoll («e24.no/sak») får https. Returnerer `null` når det ikke er en
 * nettadresse.
 */
export function normalizeArticleUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
  if (!/^[^.]+(\.[^.]+)+$/.test(url.hostname)) return null
  url.hash = ''
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) url.searchParams.delete(key)
  }
  return url.href
}

/**
 * Nøkkelen to lenker til samme sak har felles: uten protokoll, «www.», skråstrek
 * til slutt og med parametrene sortert. Brukes til å finne duplikater; selve
 * lenken lagres som den ble skrevet (normalisert med `normalizeArticleUrl`).
 */
export function articleUrlKey(url: string): string {
  const normalized = normalizeArticleUrl(url) ?? url
  try {
    const u = new URL(normalized)
    u.searchParams.sort()
    const query = u.searchParams.toString()
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${query ? `?${query}` : ''}`
  } catch {
    return normalized
  }
}

/** Felles validering av en sak, brukt av webappen, forslag, importen og senere MCP. */
export const companyArticleInput = z
  .object({
    url: z
      .string()
      .trim()
      .min(1, 'Lim inn lenken til saken.')
      .max(1000, 'Lenken er for lang.')
      .transform((v, ctx) => {
        const url = normalizeArticleUrl(v)
        if (!url) {
          ctx.addIssue({
            code: 'custom',
            message: 'Ugyldig lenke. Bruk hele adressen, som begynner med https://.',
          })
          return z.NEVER
        }
        return url
      }),
    title: z
      .string()
      .trim()
      .min(1, 'Skriv tittelen på saken.')
      .max(300, 'Maks 300 tegn.')
      .transform(collapseSpaces),
    /** Uten utgiver vises domenet i lenken. */
    publisher: optionalText(120).transform((v) => (v === null ? null : collapseSpaces(v))),
    /** Uten år er saken udatert, og den står sist. */
    year: z
      .number()
      .int()
      .min(1900, 'Ugyldig årstall.')
      .refine((y) => y <= new Date().getFullYear(), 'Årstallet kan ikke være fram i tid.')
      .nullable(),
    month: z.number().int().min(1).max(12).nullable(),
    day: z.number().int().min(1).max(31).nullable(),
    paywall: z.boolean(),
    mentionsEs: z.boolean(),
  })
  .refine((a) => a.month === null || a.year !== null, {
    message: 'Skriv året når du velger måned.',
  })
  .refine((a) => a.day === null || a.month !== null, { message: 'Velg måned når du oppgir dag.' })
  .refine(
    (a) =>
      a.day === null || new Date(Date.UTC(a.year!, a.month! - 1, a.day)).getUTCDate() === a.day,
    { message: 'Datoen finnes ikke.' },
  )

export type CompanyArticleInput = z.input<typeof companyArticleInput>
export type CompanyArticleValues = z.output<typeof companyArticleInput>

/** En sak slik den vises på selskapssiden. */
export type CompanyArticle = {
  id: string
  /** Alltid http eller https. */
  url: string
  title: string
  /** Utgiveren slik den er lagret, til redigering. `null` betyr at domenet vises. */
  publisher: string | null
  /** Utgiveren, eller domenet i lenken. */
  publisherLabel: string
  /** `YYYY-MM-DD`, eller `null` når datoen ikke er kjent. */
  publishedAt: string | null
  publishedPrecision: DatePrecision
  paywall: boolean
  mentionsEs: boolean
}

/** Kolonnene for en validert sak (uten selskap og hvem som la den inn). */
export function articleValues(values: CompanyArticleValues) {
  const precision: DatePrecision = values.day ? 'day' : values.month ? 'month' : 'year'
  return {
    url: values.url,
    title: values.title,
    publisher: values.publisher,
    publishedAt:
      values.year === null
        ? null
        : `${values.year}-${pad(values.month ?? 1)}-${pad(values.day ?? 1)}`,
    publishedPrecision: precision,
    paywall: values.paywall,
    mentionsEs: values.mentionsEs,
  }
}

export function parseArticle(input: unknown): CompanyArticleValues {
  const parsed = companyArticleInput.safeParse(input)
  if (!parsed.success) throw new DomainError(parsed.error.issues[0]?.message ?? 'Ugyldige felt.')
  return parsed.data
}

/** Sakene om et selskap: nyeste først, de uten dato sist. */
export async function loadCompanyArticles(
  db: Db | Tx,
  companyId: string,
): Promise<CompanyArticle[]> {
  const rows = await db
    .select()
    .from(companyArticle)
    .where(eq(companyArticle.companyId, companyId))
    .orderBy(
      sql`${companyArticle.publishedAt} desc nulls last`,
      desc(companyArticle.createdAt),
      asc(companyArticle.title),
    )
  return rows.flatMap((r) => {
    // Lenkene valideres før de lagres; dette er et ekstra lag før de sendes til nettleseren.
    const url = safeHttpUrl(r.url)
    if (!url) return []
    return [
      {
        id: r.id,
        url,
        title: r.title,
        publisher: r.publisher,
        publisherLabel: r.publisher ?? hostLabel(url) ?? url,
        publishedAt: r.publishedAt,
        publishedPrecision: r.publishedPrecision,
        paywall: r.paywall,
        mentionsEs: r.mentionsEs,
      },
    ]
  })
}

/**
 * Saken om selskapet med samme lenke (se `articleUrlKey`), utenom `exceptId`.
 * Kalles med selskapet låst, så to samtidige lagringer ikke gir to like saker.
 */
export async function findDuplicateArticle(
  db: Db | Tx,
  companyId: string,
  url: string,
  exceptId?: string,
) {
  const key = articleUrlKey(url)
  const rows = await db
    .select({ id: companyArticle.id, url: companyArticle.url, title: companyArticle.title })
    .from(companyArticle)
    .where(eq(companyArticle.companyId, companyId))
  return rows.find((r) => r.id !== exceptId && articleUrlKey(r.url) === key) ?? null
}

/** Legger inn en validert sak. Gir `null` når samme sak allerede står på selskapet. */
export async function insertArticle(
  tx: Tx,
  companyId: string,
  values: CompanyArticleValues,
  added: { source: CompanyArticleSource; byPersonId: string | null },
): Promise<{ id: string } | null> {
  if (await findDuplicateArticle(tx, companyId, values.url)) return null
  const [row] = await tx
    .insert(companyArticle)
    .values({
      companyId,
      ...articleValues(values),
      source: added.source,
      addedByPersonId: added.byPersonId,
    })
    .returning({ id: companyArticle.id })
  return row!
}

const duplicate = () => new DomainError('Saken står allerede under «I media».')

async function lockArticle(tx: Tx, articleId: string) {
  const [row] = await tx
    .select({ id: companyArticle.id, companyId: companyArticle.companyId, url: companyArticle.url })
    .from(companyArticle)
    .where(eq(companyArticle.id, articleId))
    .for('update')
  if (!row) throw new NotFoundError('Fant ikke saken.')
  return row
}

async function logAdminChange(
  tx: Tx,
  viewer: Viewer,
  action:
    'company.admin_article_add' | 'company.admin_article_edit' | 'company.admin_article_remove',
  target: { id: string; slug: string; name: string },
  article: { id: string; url: string },
) {
  await tx.insert(auditEvent).values({
    actorPersonId: viewer!.personId,
    action,
    details: {
      companyId: target.id,
      slug: target.slug,
      name: target.name,
      articleId: article.id,
      url: article.url,
    },
  })
}

/** Legger til en sak under «I media». */
export async function addCompanyArticle(
  db: Db,
  viewer: Viewer,
  companyId: string,
  input: CompanyArticleInput,
): Promise<{ id: string }> {
  const values = parseArticle(input)
  return db.transaction(async (tx) => {
    // Låsen på selskapet hindrer at to samtidige lagringer legger inn samme sak.
    const target = await companyForEdit(tx, viewer, companyId, { lock: true })
    const row = await insertArticle(tx, companyId, values, {
      source: target.adminEdit ? 'admin' : 'member',
      byPersonId: viewer!.personId,
    })
    if (!row) throw duplicate()
    if (target.adminEdit) {
      await logAdminChange(tx, viewer, 'company.admin_article_add', target, {
        id: row.id,
        url: values.url,
      })
    }
    return row
  })
}

/** Retter en sak. */
export async function updateCompanyArticle(
  db: Db,
  viewer: Viewer,
  articleId: string,
  input: CompanyArticleInput,
): Promise<void> {
  const values = parseArticle(input)
  await db.transaction(async (tx) => {
    const article = await lockArticle(tx, articleId)
    const target = await companyForEdit(tx, viewer, article.companyId, { lock: true })
    if (await findDuplicateArticle(tx, article.companyId, values.url, articleId)) throw duplicate()
    await tx
      .update(companyArticle)
      .set(articleValues(values))
      .where(eq(companyArticle.id, articleId))
    if (target.adminEdit) {
      await logAdminChange(tx, viewer, 'company.admin_article_edit', target, {
        id: articleId,
        url: values.url,
      })
    }
  })
}

/** Fjerner en sak. */
export async function deleteCompanyArticle(
  db: Db,
  viewer: Viewer,
  articleId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const article = await lockArticle(tx, articleId)
    const target = await companyForEdit(tx, viewer, article.companyId)
    await tx.delete(companyArticle).where(eq(companyArticle.id, articleId))
    if (target.adminEdit) {
      await logAdminChange(tx, viewer, 'company.admin_article_remove', target, article)
    }
  })
}

/**
 * Når to selskaper slås sammen: sakene om duplikatet flyttes, utenom dem målet
 * allerede har (samme lenke). Gir antallet som ble flyttet.
 */
export async function moveCompanyArticles(tx: Tx, sourceId: string, targetId: string) {
  const [fromSource, onTarget] = await Promise.all([
    tx
      .select({ id: companyArticle.id, url: companyArticle.url })
      .from(companyArticle)
      .where(eq(companyArticle.companyId, sourceId)),
    tx
      .select({ url: companyArticle.url })
      .from(companyArticle)
      .where(eq(companyArticle.companyId, targetId)),
  ])
  const taken = new Set(onTarget.map((a) => articleUrlKey(a.url)))
  let moved = 0
  for (const article of fromSource) {
    if (taken.has(articleUrlKey(article.url))) {
      await tx.delete(companyArticle).where(eq(companyArticle.id, article.id))
      continue
    }
    taken.add(articleUrlKey(article.url))
    await tx
      .update(companyArticle)
      .set({ companyId: targetId })
      .where(and(eq(companyArticle.id, article.id), eq(companyArticle.companyId, sourceId)))
    moved++
  }
  return moved
}
