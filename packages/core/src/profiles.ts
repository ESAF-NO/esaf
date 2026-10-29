import { schema, type Db } from '@esaf/db'
import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { assertCan, assertMember, can, type Viewer } from './access.ts'
import {
  companyName,
  deleteOrphanCompanies,
  optionalCompanyName,
  resolveCompanies,
} from './companies.ts'
import { DomainError, NotFoundError } from './errors.ts'
import { currentRole, loadExperience, type Experience } from './experience.ts'
import { logoUrls, type CompanyLogoUrls } from './logos.ts'
import { photoUrls, type ProfilePhoto } from './photos.ts'
import { optionalText, tagList, yearInput } from './validation.ts'

const { auditEvent, cohort, company, experience, membership, person, personCohort } = schema

export const LINKEDIN_URL = /^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/(in|company)\/[^\s/?#]+\/?$/i

/**
 * Gjør om det folk limer inn (delingslenker med `?utm_…`, uten https, med
 * undersider) til en ren profillenke. Returnerer `null` hvis det ikke er en
 * LinkedIn-profil eller -bedriftsside.
 */
export function normalizeLinkedinUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  const match = url.pathname.match(/^\/(in|company)\/([^/]+)/i)
  if (!/^([a-z]{2,3}\.)?linkedin\.com$/i.test(url.hostname) || !match) return null
  const normalized = `https://${url.hostname.toLowerCase()}/${match[1]!.toLowerCase()}/${match[2]}`
  return LINKEDIN_URL.test(normalized) ? normalized : null
}

const year = yearInput(1950)

/**
 * Én jobb eller ett selskap i erfaringslisten. Uten sluttår er det nåværende.
 * `companyId` er selskapet som ble valgt i forslagslisten; uten det kobles navnet
 * til selskapet med samme slug, eller blir et nytt selskap.
 */
export const experienceInput = z
  .object({
    companyId: z.uuid().nullable().optional(),
    company: companyName,
    title: optionalText(120),
    startYear: year,
    endYear: year,
    founder: z.boolean(),
  })
  .refine((e) => e.startYear === null || e.endYear === null || e.endYear >= e.startYear, {
    message: 'Sluttåret kan ikke være før startåret.',
  })

export type ExperienceInput = z.input<typeof experienceInput>

/**
 * Felles validering for profiler, brukt av webappen og senere MCP. Tomme felt
 * lagres som `null`.
 */
export const profileInput = z.object({
  fullName: z.string().trim().min(2, 'Navn må ha minst 2 tegn.').max(120),
  city: optionalText(80),
  studyBackground: optionalText(120),
  /** Selskapet på Entreprenørskolen, koblet til et selskap som erfaringen. */
  esCompany: optionalCompanyName,
  esCompanyId: z.uuid().nullable().optional(),
  bio: optionalText(1000),
  expertise: tagList('emne', 'emner'),
  industries: tagList('bransjenavn', 'bransjer'),
  experience: z.array(experienceInput).max(30, 'Maks 30 erfaringer.'),
  linkedinUrl: optionalText(300).transform((v, ctx) => {
    if (v === null) return null
    const url = normalizeLinkedinUrl(v)
    if (!url) {
      ctx.addIssue({
        code: 'custom',
        message: 'Må være en lenke til en LinkedIn-profil (https://www.linkedin.com/in/…).',
      })
      return z.NEVER
    }
    return url
  }),
  contactEmail: optionalText(200).refine((v) => v === null || z.email().safeParse(v).success, {
    message: 'Ugyldig e-postadresse.',
  }),
  contactEmailVisible: z.boolean(),
  phone: optionalText(30).refine((v) => v === null || /^\+?[0-9 ()-]{5,20}$/.test(v), {
    message: 'Ugyldig telefonnummer.',
  }),
  phoneVisible: z.boolean(),
})

export type ProfileInput = z.input<typeof profileInput>

const profileColumns = {
  personId: person.id,
  fullName: person.fullName,
  userId: person.userId,
  city: person.city,
  studyBackground: person.studyBackground,
  esCompanyId: person.esCompanyId,
  esCompany: company.name,
  esCompanySlug: company.slug,
  esCompanyLogoKey: company.logoKey,
  bio: person.bio,
  expertise: person.expertise,
  industries: person.industries,
  linkedinUrl: person.linkedinUrl,
  contactEmail: person.contactEmail,
  contactEmailVisible: person.contactEmailVisible,
  phone: person.phone,
  phoneVisible: person.phoneVisible,
  photoKey: person.photoKey,
}

export type Profile = {
  personId: string
  fullName: string
  photo: ProfilePhoto | null
  claimed: boolean
  /** Fra den øverste nåværende erfaringen. */
  jobTitle: string | null
  currentCompany: string | null
  city: string | null
  studyBackground: string | null
  esCompany: string | null
  esCompanySlug: string | null
  esCompanyLogo: CompanyLogoUrls | null
  bio: string | null
  expertise: string[]
  industries: string[]
  /** Nåværende først, så tidligere. */
  experience: Experience[]
  linkedinUrl: string | null
  /** Bare satt når personen selv har valgt å vise den. */
  contactEmail: string | null
  /** Bare satt når personen selv har valgt å vise det. */
  phone: string | null
  cohorts: { graduationYear: number; relation: schema.CohortRelation }[]
  isOwn: boolean
  canEdit: boolean
}

/**
 * Profilen til et aktivt medlem, slik andre medlemmer ser den. Kontaktinfo
 * filtreres her på serveren og sendes aldri til klienten når den er skjult.
 */
export async function getProfile(db: Db, viewer: Viewer, personId: string): Promise<Profile> {
  assertMember(viewer)
  const [row] = await db
    .select({ ...profileColumns, status: membership.status })
    .from(person)
    .innerJoin(membership, eq(membership.personId, person.id))
    .leftJoin(company, eq(company.id, person.esCompanyId))
    .where(eq(person.id, personId))
  const isOwn = viewer.personId === personId
  if (!row || (row.status !== 'active' && !isOwn)) throw new NotFoundError('Fant ikke profilen.')

  const [cohorts, experiences] = await Promise.all([
    db
      .select({ graduationYear: cohort.graduationYear, relation: personCohort.relation })
      .from(personCohort)
      .innerJoin(cohort, eq(cohort.id, personCohort.cohortId))
      .where(eq(personCohort.personId, personId))
      .orderBy(asc(cohort.graduationYear)),
    loadExperience(db, [personId]),
  ])
  const roles = experiences.get(personId) ?? []

  const claimed = row.userId !== null
  return {
    personId: row.personId,
    fullName: row.fullName,
    photo: photoUrls(row.photoKey),
    claimed,
    ...currentRole(roles),
    city: row.city,
    studyBackground: row.studyBackground,
    esCompany: row.esCompany,
    esCompanySlug: row.esCompanySlug,
    esCompanyLogo: logoUrls(row.esCompanyLogoKey),
    bio: row.bio,
    expertise: row.expertise,
    industries: row.industries,
    experience: roles,
    linkedinUrl: row.linkedinUrl,
    contactEmail: claimed && row.contactEmailVisible ? row.contactEmail : null,
    phone: claimed && row.phoneVisible ? row.phone : null,
    cohorts,
    isOwn,
    canEdit: isOwn || can(viewer, 'profiles.edit'),
  }
}

function assertCanEdit(viewer: Viewer, personId: string) {
  assertMember(viewer)
  const isOwn = viewer.personId === personId
  if (!isOwn) assertCan(viewer, 'profiles.edit')
  return isOwn
}

export type EditableProfile = Omit<z.output<typeof profileInput>, 'experience' | 'esCompanyId'> & {
  personId: string
  esCompanyId: string | null
  isOwn: boolean
  experience: Experience[]
  photo: ProfilePhoto | null
}

/**
 * Alle felt for eieren eller en admin som skal redigere. Skjult kontaktinfo får
 * bare eieren; en admin kan ikke endre den og skal heller ikke se den.
 */
export async function getEditableProfile(
  db: Db,
  viewer: Viewer,
  personId: string,
): Promise<EditableProfile> {
  const isOwn = assertCanEdit(viewer, personId)
  const [row] = await db
    .select(profileColumns)
    .from(person)
    .leftJoin(company, eq(company.id, person.esCompanyId))
    .where(eq(person.id, personId))
  if (!row) throw new NotFoundError('Fant ikke profilen.')
  const {
    userId: _userId,
    photoKey,
    esCompanySlug: _esCompanySlug,
    esCompanyLogoKey: _esCompanyLogoKey,
    ...fields
  } = row
  const experiences = await loadExperience(db, [personId])
  const contact = isOwn
    ? {}
    : { contactEmail: null, contactEmailVisible: false, phone: null, phoneVisible: false }
  return {
    ...fields,
    ...contact,
    experience: experiences.get(personId) ?? [],
    photo: photoUrls(photoKey),
    isOwn,
  }
}

/**
 * Lagrer en profil. Eieren kan endre alt. En admin kan fylle ut og rette
 * profilfelt for andre (f.eks. profiler fra kullisten), men aldri endre andres
 * kontaktinfo eller hva som vises av den; det er personens eget valg.
 */
export async function updateProfile(
  db: Db,
  viewer: Viewer,
  personId: string,
  input: ProfileInput,
): Promise<void> {
  const isOwn = assertCanEdit(viewer, personId)
  const parsed = profileInput.safeParse(input)
  if (!parsed.success) throw new DomainError(parsed.error.issues[0]?.message ?? 'Ugyldige felt.')
  const {
    contactEmail,
    contactEmailVisible,
    phone,
    phoneVisible,
    experience: roles,
    esCompany,
    esCompanyId,
    ...fields
  } = parsed.data
  const contact = { contactEmail, contactEmailVisible, phone, phoneVisible }

  await db.transaction(async (tx) => {
    const [before] = await tx
      .select({ esCompanyId: person.esCompanyId })
      .from(person)
      .where(eq(person.id, personId))
      .for('update')
    if (!before) throw new NotFoundError('Fant ikke profilen.')
    const previous = await tx
      .select({ companyId: experience.companyId })
      .from(experience)
      .where(eq(experience.personId, personId))

    // ES-selskapet sist, så rekkefølgen på erfaringen beholdes.
    const companyIds = await resolveCompanies(tx, [
      ...roles.map((r) => ({ companyId: r.companyId, name: r.company })),
      ...(esCompany ? [{ companyId: esCompanyId, name: esCompany }] : []),
    ])
    const esId = esCompany ? companyIds.at(-1)! : null

    await tx
      .update(person)
      .set({ ...(isOwn ? { ...fields, ...contact } : fields), esCompanyId: esId })
      .where(eq(person.id, personId))
    // Listen lagres som en helhet, i rekkefølgen personen satte opp.
    await tx.delete(experience).where(eq(experience.personId, personId))
    if (roles.length) {
      await tx.insert(experience).values(
        roles.map(({ company: _name, companyId: _chosen, ...role }, position) => ({
          ...role,
          companyId: companyIds[position]!,
          personId,
          position,
        })),
      )
    }
    // Et selskap som bare fantes fordi personen skrev det (f.eks. en skrivefeil), ryddes bort.
    await deleteOrphanCompanies(tx, [
      ...previous.map((p) => p.companyId).filter((id) => !companyIds.includes(id)),
      before.esCompanyId !== esId ? before.esCompanyId : null,
    ])
    if (!isOwn) {
      await tx.insert(auditEvent).values({
        actorPersonId: viewer!.personId,
        action: 'profile.admin_edit',
        subjectPersonId: personId,
      })
    }
  })
}

/** Personen som hører til den innloggede kontoen, for «Min profil». */
export function ownPersonId(viewer: Viewer): string {
  assertMember(viewer)
  return viewer.personId
}
