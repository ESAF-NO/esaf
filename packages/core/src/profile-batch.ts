import { schema, type Db } from '@esaf/db'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { assertCan, type Viewer } from './access.ts'
import { resolveCompanies } from './companies.ts'
import { DomainError } from './errors.ts'
import { normalizeEmail, type Tx } from './members.ts'
import { cohortsInput, emailInput, insertProfile, normalizePersonName } from './people-admin.ts'
import { deletePhotoFiles, processProfilePhoto, putProcessedPhoto } from './photos.ts'
import { normalizePhone } from './profile-import.ts'
import { experienceInput, profileInput } from './profiles.ts'
import { fieldSourceInput, profileSourceFields, writeFieldSources } from './sources.ts'
import type { ObjectStorage } from './storage.ts'

const { auditEvent, cohort, experience, person, personCohort, personEmail } = schema

/**
 * Mange profiler på én gang, for eksempel et nytt kull før noen har fått
 * invitasjon. Profilene er som fra kullisten: personer uten konto, med aktivt
 * medlemskap (eller `pending`), som aldri gir tilgang til noen konto. Reglene:
 *
 * - Alltid en plan først (`planProfileBatch`): hver rad er `create`, `duplicate`
 *   eller `invalid`. Lagring (`createProfileBatch`) kjører samme plan på nytt og
 *   lager bare radene som er `create`, eller også `duplicate` når admin har sett
 *   over treffene og sier at det er andre personer. Ugyldige rader lages aldri.
 * - Duplikater: samme e-post (kjente adresser og kontaktadressen, også Gmail-
 *   varianter), samme LinkedIn, eller samme navn (uten aksenter og store
 *   bokstaver) med kull innenfor ett år eller uten kull. En e-post som hører til
 *   en annen person, stopper raden helt: adressen kobler kontoer til profiler.
 *   Rader i samme forespørsel sjekkes også mot hverandre.
 * - Alle profilene lages i én transaksjon. Bildene behandles og lastes opp først
 *   (samme behandling som en opplasting i appen); feiler databasen, slettes de.
 *   Et bilde som ikke kan leses, gir en advarsel, og profilen lages uten bilde.
 * - Kontaktinfo (e-post og telefon) kan settes her, som fra kullisten, og vises
 *   for medlemmer til personen selv skjuler den. Kontaktadressen blir også en
 *   kjent adresse. Etterpå endrer admin aldri kontaktinfoen.
 * - Kilder for feltene kan følge med, så profilen viser hvor informasjonen kom
 *   fra til personen bekrefter den.
 * - Hver profil logges som `profile.create` (med `via: 'batch'`), og hele
 *   oppgaven som `profile.batch_create`.
 */

export const PROFILE_BATCH_MAX = 500

export const batchProfileInput = z.object({
  /** Valgfri nøkkel fra den som sender, så svaret kan kobles til raden. */
  ref: z.string().trim().max(100).optional(),
  fullName: profileInput.shape.fullName,
  /** Uten tilknytning er personen student i kullet. */
  cohorts: z
    .preprocess(
      (list) =>
        Array.isArray(list)
          ? list.map((c) => (c && typeof c === 'object' ? { relation: 'student', ...c } : c))
          : list,
      cohortsInput,
    )
    .default([]),
  /** Kjente adresser. En konto med en av dem kan senere kobles til profilen. */
  emails: z.array(emailInput).max(10, 'Maks 10 e-postadresser.').default([]),
  status: z.enum(['active', 'pending']).default('active'),
  city: profileInput.shape.city.default(null),
  studyBackground: profileInput.shape.studyBackground.default(null),
  bio: profileInput.shape.bio.default(null),
  linkedinUrl: profileInput.shape.linkedinUrl.default(null),
  expertise: profileInput.shape.expertise.default([]),
  industries: profileInput.shape.industries.default([]),
  esCompany: profileInput.shape.esCompany.default(null),
  esCompanyId: z.uuid().nullable().optional(),
  /** Uten stilling og år er de ukjent; uten sluttår er stillingen nåværende. */
  experience: z
    .preprocess(
      (list) =>
        Array.isArray(list)
          ? list.map((e) =>
              e && typeof e === 'object'
                ? { title: null, startYear: null, endYear: null, founder: false, ...e }
                : e,
            )
          : list,
      z.array(experienceInput).max(30, 'Maks 30 erfaringer.'),
    )
    .default([]),
  contactEmail: profileInput.shape.contactEmail.default(null),
  contactEmailVisible: z.boolean().default(true),
  phone: profileInput.shape.phone.default(null),
  phoneVisible: z.boolean().default(true),
  sources: z.array(fieldSourceInput).max(30).default([]),
})

export type BatchProfileInput = z.input<typeof batchProfileInput>
type BatchProfile = z.output<typeof batchProfileInput>

export type BatchMatchReason = 'email' | 'linkedin' | 'name'

export type BatchMatch = {
  /** En person som finnes, eller `null` for en annen rad i samme forespørsel. */
  personId: string | null
  /** Raden i forespørselen, for treff mellom rader. */
  row: number | null
  fullName: string
  claimed: boolean
  cohortYears: number[]
  reasons: BatchMatchReason[]
}

export type BatchRowPlan = {
  row: number
  ref: string | null
  fullName: string | null
  status: 'create' | 'duplicate' | 'invalid'
  /** Samme e-post som en annen person: raden kan ikke lages, heller ikke som duplikat. */
  blocked: boolean
  errors: string[]
  matches: BatchMatch[]
}

export type BatchPlan = {
  rows: BatchRowPlan[]
  counts: { create: number; duplicate: number; invalid: number }
}

export type BatchResultRow = BatchRowPlan & {
  /** Profilen som ble laget, ellers `null`. */
  personId: string | null
  warnings: string[]
}

export type BatchResult = {
  rows: BatchResultRow[]
  created: number
  skipped: number
}

/** Gmail ser bort fra punktum og alt etter `+`; da er det samme adresse. */
function emailIdentity(email: string) {
  const [local = '', domain = ''] = normalizeEmail(email).split('@')
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    return `${local.split('+')[0]!.replace(/\./g, '')}@gmail.com`
  }
  return `${local}@${domain}`
}

const linkedinKey = (url: string | null) =>
  url
    ? url
        .toLowerCase()
        .replace(/^https:\/\/([a-z]{2,3}\.)?linkedin\.com/, '')
        .replace(/\/$/, '')
    : null

const nearCohort = (a: number[], b: number[]) =>
  !a.length || !b.length || a.some((x) => b.some((y) => Math.abs(x - y) <= 1))

type Known = {
  personId: string
  fullName: string
  name: string
  claimed: boolean
  cohortYears: number[]
  emails: Set<string>
  /** Adresser i `person_email`, som må være unike. */
  knownEmails: Set<string>
  linkedin: string | null
}

async function loadKnownPeople(db: Db | Tx): Promise<Known[]> {
  const [people, years, emails] = await Promise.all([
    db
      .select({
        id: person.id,
        fullName: person.fullName,
        userId: person.userId,
        contactEmail: person.contactEmail,
        linkedinUrl: person.linkedinUrl,
      })
      .from(person),
    db
      .select({ personId: personCohort.personId, year: cohort.graduationYear })
      .from(personCohort)
      .innerJoin(cohort, eq(cohort.id, personCohort.cohortId)),
    db.select({ personId: personEmail.personId, email: personEmail.email }).from(personEmail),
  ])
  const byId = new Map<string, Known>(
    people.map((p) => [
      p.id,
      {
        personId: p.id,
        fullName: p.fullName,
        name: normalizePersonName(p.fullName),
        claimed: p.userId !== null,
        cohortYears: [],
        emails: new Set(p.contactEmail ? [emailIdentity(p.contactEmail)] : []),
        knownEmails: new Set(),
        linkedin: linkedinKey(p.linkedinUrl),
      },
    ]),
  )
  for (const y of years) byId.get(y.personId)?.cohortYears.push(y.year)
  for (const e of emails) {
    const known = byId.get(e.personId)
    known?.emails.add(emailIdentity(e.email))
    known?.knownEmails.add(normalizeEmail(e.email))
  }
  return [...byId.values()]
}

/** Alle adressene på raden: kjente adresser og kontaktadressen. */
const rowEmails = (p: BatchProfile) => [
  ...new Set([...p.emails, ...(p.contactEmail ? [normalizeEmail(p.contactEmail)] : [])]),
]

function planRows(
  inputs: unknown[],
  known: Known[],
): { plans: BatchRowPlan[]; parsed: (BatchProfile | null)[] } {
  if (!Array.isArray(inputs) || !inputs.length) throw new DomainError('Ingen profiler å lage.')
  if (inputs.length > PROFILE_BATCH_MAX) {
    throw new DomainError(`Høyst ${PROFILE_BATCH_MAX} profiler om gangen.`)
  }
  const parsed: (BatchProfile | null)[] = []
  const plans: BatchRowPlan[] = []
  const earlier: { row: number; profile: BatchProfile; name: string; years: number[] }[] = []

  inputs.forEach((input, row) => {
    const result = batchProfileInput.safeParse(input)
    if (!result.success) {
      const raw = (input ?? {}) as { ref?: unknown; fullName?: unknown }
      parsed.push(null)
      plans.push({
        row,
        ref: typeof raw.ref === 'string' ? raw.ref : null,
        fullName: typeof raw.fullName === 'string' ? raw.fullName : null,
        status: 'invalid',
        blocked: false,
        errors: result.error.issues.map(
          (i) => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`,
        ),
        matches: [],
      })
      return
    }
    const p = result.data
    // Samme sjekk som når kildene skrives, så en ugyldig kilde stopper raden i
    // planen og ikke hele oppgaven når den kjøres.
    const sourceErrors = p.sources
      .filter((s) => !(profileSourceFields as readonly string[]).includes(s.field))
      .map(
        (s) =>
          `sources: Feltet «${s.field}» kan ikke ha kilde. Gyldige felt: ${profileSourceFields.join(', ')}.`,
      )
    if (sourceErrors.length) {
      parsed.push(null)
      plans.push({
        row,
        ref: p.ref ?? null,
        fullName: p.fullName,
        status: 'invalid',
        blocked: false,
        errors: sourceErrors,
        matches: [],
      })
      return
    }
    const errors: string[] = []
    const matches: BatchMatch[] = []
    let blocked = false
    const name = normalizePersonName(p.fullName)
    const years = p.cohorts.map((c) => c.graduationYear)
    const emails = rowEmails(p)
    const identities = new Set(emails.map(emailIdentity))
    const linkedin = linkedinKey(p.linkedinUrl)

    for (const k of known) {
      const reasons: BatchMatchReason[] = []
      if ([...identities].some((e) => k.emails.has(e))) reasons.push('email')
      if (linkedin && k.linkedin === linkedin) reasons.push('linkedin')
      if (name.length >= 3 && k.name === name && nearCohort(years, k.cohortYears)) {
        reasons.push('name')
      }
      if (!reasons.length) continue
      matches.push({
        personId: k.personId,
        row: null,
        fullName: k.fullName,
        claimed: k.claimed,
        cohortYears: [...k.cohortYears].sort(),
        reasons,
      })
      const taken = emails.find((e) => k.knownEmails.has(e))
      if (taken) {
        blocked = true
        errors.push(`${taken} hører allerede til ${k.fullName}.`)
      }
    }
    for (const e of earlier) {
      const reasons: BatchMatchReason[] = []
      const theirs = rowEmails(e.profile)
      if (theirs.some((x) => identities.has(emailIdentity(x)))) reasons.push('email')
      if (linkedin && linkedinKey(e.profile.linkedinUrl) === linkedin) reasons.push('linkedin')
      if (name.length >= 3 && e.name === name && nearCohort(years, e.years)) reasons.push('name')
      if (!reasons.length) continue
      matches.push({
        personId: null,
        row: e.row,
        fullName: e.profile.fullName,
        claimed: false,
        cohortYears: [...e.years].sort(),
        reasons,
      })
      const shared = emails.find((x) => theirs.includes(x))
      if (shared) {
        blocked = true
        errors.push(`${shared} står også på rad ${e.row}.`)
      }
    }
    earlier.push({ row, profile: p, name, years })
    parsed.push(p)
    plans.push({
      row,
      ref: p.ref ?? null,
      fullName: p.fullName,
      status: matches.length ? 'duplicate' : 'create',
      blocked,
      errors,
      matches,
    })
  })
  return { plans, parsed }
}

function countPlans(plans: BatchRowPlan[]): BatchPlan['counts'] {
  return {
    create: plans.filter((p) => p.status === 'create').length,
    duplicate: plans.filter((p) => p.status === 'duplicate').length,
    invalid: plans.filter((p) => p.status === 'invalid').length,
  }
}

/** Hva som ville blitt laget, uten å skrive noe. */
export async function planProfileBatch(
  db: Db,
  viewer: Viewer,
  inputs: unknown[],
): Promise<BatchPlan> {
  assertCan(viewer, 'profiles.edit')
  const { plans } = planRows(inputs, await loadKnownPeople(db))
  return { rows: plans, counts: countPlans(plans) }
}

/**
 * Lager profilene i planen. `allowDuplicates`: lag også rader med mulige treff
 * (admin har sett over dem); rader med en e-post som hører til en annen, lages
 * aldri. `photos` er bildefiler per rad, allerede hentet av den som kaller.
 */
export async function createProfileBatch(
  db: Db,
  storage: ObjectStorage,
  viewer: Viewer,
  inputs: unknown[],
  options: { allowDuplicates?: boolean; photos?: Map<number, Uint8Array> } = {},
): Promise<BatchResult> {
  assertCan(viewer, 'profiles.edit')
  // Planen sjekkes også her, før bildene behandles, så feil ikke koster noe.
  const first = planRows(inputs, await loadKnownPeople(db))
  const wanted = (plan: BatchRowPlan) =>
    plan.status === 'create' ||
    (plan.status === 'duplicate' && options.allowDuplicates === true && !plan.blocked)

  const warnings = new Map<number, string[]>()
  const warn = (row: number, message: string) =>
    warnings.set(row, [...(warnings.get(row) ?? []), message])
  const photoKeys = new Map<number, string>()
  for (const [row, file] of options.photos ?? []) {
    if (!first.plans[row] || !wanted(first.plans[row])) continue
    try {
      photoKeys.set(row, await putProcessedPhoto(storage, await processProfilePhoto(file)))
    } catch (error) {
      if (!(error instanceof DomainError)) {
        await Promise.all([...photoKeys.values()].map((key) => deletePhotoFiles(storage, key)))
        throw error
      }
      warn(row, `Bildet ble ikke lagret: ${error.message}`)
    }
  }

  try {
    return await db.transaction(async (tx) => {
      // Planen på nytt i transaksjonen, så noe som er lagt inn i mellomtiden telles med.
      const { plans, parsed } = planRows(inputs, await loadKnownPeople(tx))
      const rows: BatchResultRow[] = []
      for (const plan of plans) {
        const profile = parsed[plan.row]
        if (!profile || !wanted(plan)) {
          rows.push({ ...plan, personId: null, warnings: warnings.get(plan.row) ?? [] })
          continue
        }
        const { personId } = await insertBatchProfile(tx, viewer, profile, photoKeys.get(plan.row))
        rows.push({ ...plan, personId, warnings: warnings.get(plan.row) ?? [] })
      }
      // Bilder til rader som likevel ikke ble laget (endret plan), brukes ikke.
      const unused = [...photoKeys].filter(([row]) => !rows[row]?.personId).map(([, key]) => key)
      const created = rows.filter((r) => r.personId).length
      if (created) {
        await tx.insert(auditEvent).values({
          actorPersonId: viewer.personId,
          action: 'profile.batch_create',
          details: {
            created,
            skipped: rows.length - created,
            cohorts: [
              ...new Set(
                parsed.flatMap((p, i) =>
                  rows[i]?.personId ? (p?.cohorts.map((c) => c.graduationYear) ?? []) : [],
                ),
              ),
            ].sort(),
            withPhoto: rows.filter((r) => r.personId && photoKeys.has(r.row)).length,
          },
        })
      }
      await Promise.all(unused.map((key) => deletePhotoFiles(storage, key)))
      return { rows, created, skipped: rows.length - created }
    })
  } catch (error) {
    await Promise.all([...photoKeys.values()].map((key) => deletePhotoFiles(storage, key)))
    throw error
  }
}

async function insertBatchProfile(
  tx: Tx,
  viewer: Viewer,
  p: BatchProfile,
  photoKey: string | undefined,
): Promise<{ personId: string }> {
  const { personId } = await insertProfile(
    tx,
    viewer,
    { fullName: p.fullName, cohorts: p.cohorts, emails: rowEmails(p), status: p.status },
    { via: 'batch' },
  )
  // ES-selskapet sist, så rekkefølgen på erfaringen beholdes. Nye selskaper får
  // ukjent status, som fra kullisten: ingen har sagt om de lever.
  const companyIds = await resolveCompanies(
    tx,
    [
      ...p.experience.map((e) => ({ companyId: e.companyId, name: e.company })),
      ...(p.esCompany ? [{ companyId: p.esCompanyId, name: p.esCompany }] : []),
    ],
    { status: 'unknown' },
  )
  await tx
    .update(person)
    .set({
      city: p.city,
      studyBackground: p.studyBackground,
      bio: p.bio,
      linkedinUrl: p.linkedinUrl,
      expertise: p.expertise,
      industries: p.industries,
      esCompanyId: p.esCompany ? companyIds.at(-1)! : null,
      contactEmail: p.contactEmail ? normalizeEmail(p.contactEmail) : null,
      contactEmailVisible: p.contactEmailVisible,
      phone: p.phone ? (normalizePhone(p.phone) ?? p.phone) : null,
      phoneVisible: p.phoneVisible,
      photoKey: photoKey ?? null,
    })
    .where(eq(person.id, personId))
  if (p.experience.length) {
    await tx.insert(experience).values(
      p.experience.map(({ company: _name, companyId: _chosen, ...role }, position) => ({
        ...role,
        companyId: companyIds[position]!,
        personId,
        position,
      })),
    )
  }
  if (p.sources.length) await writeFieldSources(tx, 'person', personId, p.sources)
  return { personId }
}
