import {
  schema,
  type CompanyEventType,
  type Db,
  type DatePrecision,
  type ProgrammeKind,
} from '@esaf/db'
import { and, desc, eq, ne } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { z } from 'zod'
import type { Viewer } from './access.ts'
import {
  companyForAdding,
  companyForEdit,
  companyForOwnEdit,
  deleteOrphanCompanies,
  resolveCompanies,
} from './companies.ts'
import { DomainError, NotFoundError } from './errors.ts'
import { logoUrls, type CompanyLogoUrls } from './logos.ts'
import type { Tx } from './members.ts'
import { notifyCompanyAddition } from './notifications.ts'
import { hostLabel, optionalSourceUrl, optionalText, safeHttpUrl } from './validation.ts'

const { auditEvent, company, companyEvent } = schema

/**
 * Historikken til et selskap. Reglene:
 *
 * - Alle aktive medlemmer kan legge til hendelser, og de vises med en gang. De
 *   som ikke er knyttet til selskapet, logges, og har en grense per døgn.
 * - De samme som kan redigere selskapsinfoen, kan rette og slette hendelser:
 *   gründere (også tidligere), ES-teamet, de som jobber eller har jobbet der og admins med
 *   `profiles.edit`. Admins som ikke selv er knyttet til selskapet, logges, som
 *   ved annen redigering.
 * - Hendelser med lav sikkerhet (typisk setninger hentet automatisk fra
 *   nyhetssaker) vises bare for dem som kan redigere selskapet, merket «til
 *   gjennomgang». Lagres en hendelse i appen, regnes den som bekreftet (`high`).
 * - En hendelse av typen `programme` sier at selskapet gikk gjennom et program
 *   (akselerator, inkubator). Programmet er selv et selskap i ESAF, valgt fra
 *   listen eller laget fra navnet, så programmets side kan vise alle selskapene
 *   som har vært med (`loadProgrammeCompanies`). Teksten er da valgfri.
 */

export const companyEventTypes = schema.companyEventType.enumValues
export const programmeKinds = schema.programmeKind.enumValues

/** Typene program slik de vises. */
export const programmeKindLabels: Record<ProgrammeKind, string> = {
  accelerator: 'Akselerator',
  incubator: 'Inkubator',
  pre_incubator: 'Pre-inkubator',
  other: 'Program',
}

const collapseSpaces = (v: string) => v.replace(/\s+/g, ' ')

const pad = (n: number) => String(n).padStart(2, '0')

/** Felles validering av en hendelse, brukt av webappen og senere MCP. */
export const companyEventInput = z
  .object({
    year: z
      .number()
      .int()
      .min(1800, 'Ugyldig årstall.')
      .refine((y) => y <= new Date().getFullYear() + 1, 'Årstallet er for langt fram i tid.'),
    /** 1–12. Uten måned vises bare året. */
    month: z.number().int().min(1).max(12).nullable(),
    /** Krever måned. Uten dag vises måned og år. */
    day: z.number().int().min(1).max(31).nullable(),
    type: z.enum(companyEventTypes),
    text: z.string().trim().max(500, 'Maks 500 tegn.').transform(collapseSpaces),
    sourceUrl: optionalSourceUrl,
    sourceLabel: optionalText(80),
    /** Programmet, for `programme`. Ignoreres for andre typer. */
    programme: z
      .object({
        /** Navnet i feltet. Blir et nytt selskap hvis det ikke finnes. */
        name: z.string().trim().max(120, 'Maks 120 tegn.').default(''),
        /** Selskapet som ble valgt i forslagslisten. */
        companyId: z.uuid('Ugyldig program.').nullable().default(null),
        kind: z.enum(programmeKinds, 'Velg hva slags program det er.'),
        batch: optionalText(40).default(null),
      })
      .nullable()
      .default(null),
  })
  .transform(({ programme, ...e }) => ({
    ...e,
    programme: e.type === 'programme' ? programme : null,
  }))
  .refine(
    (e) => e.type !== 'programme' || (e.programme && (e.programme.companyId || e.programme.name)),
    {
      message: 'Velg programmet.',
    },
  )
  .refine((e) => e.type === 'programme' || e.text.length > 0, {
    message: 'Skriv hva som skjedde.',
  })
  .refine((e) => e.day === null || e.month !== null, {
    message: 'Velg måned når du oppgir dag.',
  })
  .refine(
    (e) => e.day === null || new Date(Date.UTC(e.year, e.month! - 1, e.day)).getUTCDate() === e.day,
    { message: 'Datoen finnes ikke.' },
  )

export type CompanyEventInput = z.input<typeof companyEventInput>
type ParsedEvent = z.output<typeof companyEventInput>

/** Programmet en `programme`-hendelse peker på. */
export type EventProgramme = {
  kind: ProgrammeKind
  batch: string | null
  /** Null når programmet er slettet fra ESAF. */
  company: { id: string; slug: string; name: string; logo: CompanyLogoUrls | null } | null
}

/** En hendelse slik den vises på selskapssiden. */
export type CompanyEvent = {
  id: string
  /** Den innloggede la den inn, og kan rette og slette den uten å være knyttet til selskapet. */
  mine: boolean
  /** `YYYY-MM-DD`. Bare delen `datePrecision` sier, er kjent. */
  date: string
  datePrecision: DatePrecision
  type: CompanyEventType
  text: string
  source: { label: string; url: string | null } | null
  /** Flere kilder, når like hendelser fra flere saker er slått sammen. */
  moreSources: { label: string; url: string | null }[]
  /** Usikker hendelse som bare de som kan redigere, ser. */
  review: boolean
  programme: EventProgramme | null
}

function dateFields(values: ParsedEvent) {
  const precision: DatePrecision = values.day ? 'day' : values.month ? 'month' : 'year'
  return {
    date: `${values.year}-${pad(values.month ?? 1)}-${pad(values.day ?? 1)}`,
    datePrecision: precision,
  }
}

/** Uten eget navn på kilden brukes domenet i lenken. */
function sourceFields(values: ParsedEvent) {
  return {
    sourceUrl: values.sourceUrl,
    sourceLabel: values.sourceLabel ?? hostLabel(values.sourceUrl),
  }
}

/**
 * Kolonnene for en validert hendelse (uten selskap og sikkerhet). Programmet må
 * være slått opp først (`resolveProgramme`).
 */
export function eventValues(values: ParsedEvent, programmeCompanyId: string | null = null) {
  return {
    ...dateFields(values),
    ...sourceFields(values),
    type: values.type,
    text: values.text,
    programmeCompanyId,
    programmeKind: values.programme?.kind ?? null,
    programmeBatch: values.programme?.batch ?? null,
  }
}

/**
 * Selskapet som er programmet, for en `programme`-hendelse: det som ble valgt,
 * eller et som finnes eller lages fra navnet (som ved erfaring). Et selskap kan
 * ikke ha vært med i seg selv.
 */
export async function resolveProgramme(
  tx: Tx,
  companyId: string,
  values: ParsedEvent,
): Promise<string | null> {
  if (!values.programme) return null
  const [id] = await resolveCompanies(tx, [
    { companyId: values.programme.companyId, name: values.programme.name },
  ])
  if (id === companyId)
    throw new DomainError('Et selskap kan ikke ha vært med i sitt eget program.')
  return id!
}

/** Kort tekst for en hendelse, også når en programhendelse står uten egen tekst. */
export function eventSummary(e: {
  text: string
  type: CompanyEventType
  programmeName?: string | null
  programmeBatch?: string | null
}) {
  if (e.text || e.type !== 'programme') return e.text
  const batch = e.programmeBatch ? ` (${e.programmeBatch})` : ''
  return e.programmeName ? `Med i ${e.programmeName}${batch}.` : `Med i et program${batch}.`
}

const programmeCompany = alias(company, 'programme_company')

/**
 * Hendelsene til et selskap, nyeste først. `includeReview` tar med de usikre;
 * det skal bare de som kan redigere selskapet, få.
 */
export async function loadCompanyEvents(
  db: Db,
  companyId: string,
  {
    includeReview,
    viewerPersonId = null,
  }: { includeReview: boolean; viewerPersonId?: string | null },
): Promise<CompanyEvent[]> {
  const rows = await db
    .select({
      event: companyEvent,
      programme: {
        id: programmeCompany.id,
        slug: programmeCompany.slug,
        name: programmeCompany.name,
        logoKey: programmeCompany.logoKey,
      },
    })
    .from(companyEvent)
    .leftJoin(programmeCompany, eq(programmeCompany.id, companyEvent.programmeCompanyId))
    .where(
      and(
        eq(companyEvent.companyId, companyId),
        includeReview ? undefined : ne(companyEvent.confidence, 'low'),
      ),
    )
    .orderBy(desc(companyEvent.date), desc(companyEvent.createdAt))
  return rows.map(({ event: r, programme }) => {
    const url = safeHttpUrl(r.sourceUrl)
    const label = r.sourceLabel ?? hostLabel(url)
    return {
      id: r.id,
      mine: viewerPersonId !== null && r.addedByPersonId === viewerPersonId,
      date: r.date,
      datePrecision: r.datePrecision,
      type: r.type,
      text: r.text,
      source: label ? { label, url } : null,
      moreSources: r.moreSources.flatMap((m) => {
        const moreUrl = safeHttpUrl(m.url)
        const moreLabel = m.label ?? hostLabel(moreUrl)
        return moreLabel ? [{ label: moreLabel, url: moreUrl }] : []
      }),
      review: r.confidence === 'low',
      programme:
        r.type === 'programme'
          ? {
              kind: r.programmeKind ?? 'other',
              batch: r.programmeBatch,
              company: programme
                ? {
                    id: programme.id,
                    slug: programme.slug,
                    name: programme.name,
                    logo: logoUrls(programme.logoKey),
                  }
                : null,
            }
          : null,
    }
  })
}

/** Et selskap som har vært med i et program, slik det vises på programmets side. */
export type ProgrammeCompany = {
  eventId: string
  date: string
  datePrecision: DatePrecision
  kind: ProgrammeKind
  batch: string | null
  company: {
    id: string
    slug: string
    name: string
    tagline: string | null
    logo: CompanyLogoUrls | null
  }
}

/**
 * Selskapene som har vært med i programmet, nyeste først. Usikre hendelser tas
 * ikke med: de er ikke sjekket av noen knyttet til selskapet.
 */
export async function loadProgrammeCompanies(
  db: Db,
  programmeCompanyId: string,
): Promise<ProgrammeCompany[]> {
  const rows = await db
    .select({
      eventId: companyEvent.id,
      date: companyEvent.date,
      datePrecision: companyEvent.datePrecision,
      kind: companyEvent.programmeKind,
      batch: companyEvent.programmeBatch,
      id: company.id,
      slug: company.slug,
      name: company.name,
      tagline: company.tagline,
      logoKey: company.logoKey,
    })
    .from(companyEvent)
    .innerJoin(company, eq(company.id, companyEvent.companyId))
    .where(
      and(
        eq(companyEvent.programmeCompanyId, programmeCompanyId),
        ne(companyEvent.confidence, 'low'),
      ),
    )
    .orderBy(desc(companyEvent.date), company.name)
  return rows.map((r) => ({
    eventId: r.eventId,
    date: r.date,
    datePrecision: r.datePrecision,
    kind: r.kind ?? 'other',
    batch: r.batch,
    company: {
      id: r.id,
      slug: r.slug,
      name: r.name,
      tagline: r.tagline,
      logo: logoUrls(r.logoKey),
    },
  }))
}

function parse(input: CompanyEventInput) {
  const parsed = companyEventInput.safeParse(input)
  if (!parsed.success) throw new DomainError(parsed.error.issues[0]?.message ?? 'Ugyldige felt.')
  return parsed.data
}

async function lockEvent(tx: Tx, eventId: string) {
  const [row] = await tx
    .select({
      id: companyEvent.id,
      companyId: companyEvent.companyId,
      type: companyEvent.type,
      programmeCompanyId: companyEvent.programmeCompanyId,
      addedByPersonId: companyEvent.addedByPersonId,
    })
    .from(companyEvent)
    .where(eq(companyEvent.id, eventId))
    .for('update')
  if (!row) throw new NotFoundError('Fant ikke hendelsen.')
  return row
}

async function logAdminChange(
  tx: Tx,
  viewer: Viewer,
  action:
    | 'company.admin_event_add'
    | 'company.admin_event_edit'
    | 'company.admin_event_confirm'
    | 'company.admin_event_remove'
    | 'company.member_event_add'
    | 'company.member_event_edit'
    | 'company.member_event_remove',
  target: { id: string; slug: string; name: string },
  event: { id: string; type: CompanyEventType; programmeCompanyId?: string | null },
) {
  await tx.insert(auditEvent).values({
    actorPersonId: viewer!.personId,
    action,
    details: {
      companyId: target.id,
      slug: target.slug,
      name: target.name,
      eventId: event.id,
      type: event.type,
      ...(event.programmeCompanyId ? { programmeCompanyId: event.programmeCompanyId } : {}),
    },
  })
}

/** Legger til en hendelse i historien til selskapet. */
export async function addCompanyEvent(
  db: Db,
  viewer: Viewer,
  companyId: string,
  input: CompanyEventInput,
): Promise<{ id: string }> {
  const values = parse(input)
  return db.transaction(async (tx) => {
    const target = await companyForAdding(tx, viewer, companyId)
    const programmeCompanyId = await resolveProgramme(tx, companyId, values)
    const [row] = await tx
      .insert(companyEvent)
      .values({
        companyId,
        ...eventValues(values, programmeCompanyId),
        confidence: 'high',
        addedByPersonId: viewer!.personId,
      })
      .returning({ id: companyEvent.id })
    if (target.adminEdit || target.outsider) {
      const action = target.adminEdit ? 'company.admin_event_add' : 'company.member_event_add'
      await logAdminChange(tx, viewer, action, target, {
        id: row!.id,
        type: values.type,
        programmeCompanyId,
      })
    }
    if (target.outsider) {
      await notifyCompanyAddition(tx, {
        companyId,
        actorPersonId: viewer!.personId!,
        kind: 'event',
        id: row!.id,
      })
    }
    return { id: row!.id }
  })
}

/** Retter en hendelse. Den regnes da som bekreftet, også om den var til gjennomgang. */
export async function updateCompanyEvent(
  db: Db,
  viewer: Viewer,
  eventId: string,
  input: CompanyEventInput,
): Promise<void> {
  const values = parse(input)
  await db.transaction(async (tx) => {
    const event = await lockEvent(tx, eventId)
    const target = await companyForOwnEdit(tx, viewer, event.companyId, event.addedByPersonId)
    const programmeCompanyId = await resolveProgramme(tx, event.companyId, values)
    await tx
      .update(companyEvent)
      .set({ ...eventValues(values, programmeCompanyId), confidence: 'high' })
      .where(eq(companyEvent.id, eventId))
    // Et program som bare ble laget fra et navn (en skrivefeil), ryddes bort.
    if (event.programmeCompanyId !== programmeCompanyId) {
      await deleteOrphanCompanies(tx, [event.programmeCompanyId])
    }
    if (target.adminEdit || target.own) {
      const action = target.adminEdit ? 'company.admin_event_edit' : 'company.member_event_edit'
      await logAdminChange(tx, viewer, action, target, {
        id: eventId,
        type: values.type,
        programmeCompanyId,
      })
    }
  })
}

/** Sletter en hendelse. */
export async function deleteCompanyEvent(db: Db, viewer: Viewer, eventId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const event = await lockEvent(tx, eventId)
    const target = await companyForOwnEdit(tx, viewer, event.companyId, event.addedByPersonId)
    await tx.delete(companyEvent).where(eq(companyEvent.id, eventId))
    await deleteOrphanCompanies(tx, [event.programmeCompanyId])
    if (target.adminEdit || target.own) {
      const action = target.adminEdit ? 'company.admin_event_remove' : 'company.member_event_remove'
      await logAdminChange(tx, viewer, action, target, event)
    }
  })
}

/**
 * «Stemmer»: en usikker hendelse regnes som bekreftet og vises for alle, uten at
 * noe annet endres. Samme tilgang som redigering.
 */
export async function confirmCompanyEvent(db: Db, viewer: Viewer, eventId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const event = await lockEvent(tx, eventId)
    const target = await companyForEdit(tx, viewer, event.companyId)
    const updated = await tx
      .update(companyEvent)
      .set({ confidence: 'high' })
      .where(and(eq(companyEvent.id, eventId), eq(companyEvent.confidence, 'low')))
      .returning({ id: companyEvent.id })
    if (!updated.length) throw new DomainError('Hendelsen er allerede bekreftet.')
    if (target.adminEdit) {
      await logAdminChange(tx, viewer, 'company.admin_event_confirm', target, event)
    }
  })
}
