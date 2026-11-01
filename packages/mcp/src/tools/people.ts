import {
  addFieldSources,
  addPersonEmail,
  createProfileBatch,
  deleteProfile,
  DomainError,
  fillUnclaimedContact,
  getEditableProfile,
  getPersonAdmin,
  listPeopleIndex,
  loadFieldSources,
  loadPersonBadgesForAdmin,
  loadPersonEvents,
  loadQuotes,
  mergeChoiceFields,
  mergePeople,
  planProfileBatch,
  PROFILE_BATCH_MAX,
  profileSourceFields,
  removePersonEmail,
  removeProfilePhoto,
  setPersonCohorts,
  setProfilePhoto,
  updateProfile,
  type AdminPersonIndexItem,
  type EditableProfile,
  type ProfileInput,
} from '@esaf/core'
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import {
  cohortInput,
  defineTool,
  experienceInput,
  id,
  imageInput,
  links,
  page,
  paginate,
  readImage,
  reason,
  sourceInput,
  toExperience,
  type ToolContext,
} from '../context.ts'
import { decodeBase64Image } from '../images.ts'

const missingKeys = [
  'photo',
  'bio',
  'linkedin',
  'city',
  'experience',
  'studyBackground',
  'esCompany',
  'expertise',
  'industries',
  'contactEmail',
  'phone',
  'knownEmail',
] as const satisfies readonly (keyof AdminPersonIndexItem['has'])[]

function personSummary(ctx: ToolContext, p: AdminPersonIndexItem) {
  return {
    personId: p.personId,
    fullName: p.fullName,
    claimed: p.claimed,
    status: p.status,
    role: p.role,
    source: p.source,
    cohorts: p.cohorts.map((c) =>
      c.relation === 'student' ? c.graduationYear : `${c.graduationYear} (${c.relation})`,
    ),
    jobTitle: p.jobTitle,
    currentCompany: p.currentCompany,
    city: p.city,
    missing: missingKeys.filter((k) => !p.has[k]),
    link: links.person(ctx, p.personId),
  }
}

/** Erfaringen slik den står, i formen `updateProfile` vil ha. */
const experienceFrom = (profile: EditableProfile) =>
  profile.experience.map((e) => ({
    companyId: e.companyId,
    company: e.company,
    title: e.title,
    startYear: e.startYear,
    endYear: e.endYear,
    founder: e.founder,
  }))

/** Profilen slik den står, som input til `updateProfile`. Kontaktinfo røres ikke av admins. */
function inputFrom(profile: EditableProfile): ProfileInput {
  return {
    fullName: profile.fullName,
    city: profile.city,
    studyBackground: profile.studyBackground,
    esCompany: profile.esCompany,
    esCompanyId: profile.esCompanyId,
    bio: profile.bio,
    expertise: profile.expertise,
    industries: profile.industries,
    experience: experienceFrom(profile),
    linkedinUrl: profile.linkedinUrl,
    contactEmail: profile.contactEmail,
    contactEmailVisible: profile.contactEmailVisible,
    phone: profile.phone,
    phoneVisible: profile.phoneVisible,
  }
}

const sourcesField = z
  .array(sourceInput)
  .max(30)
  .optional()
  .describe(
    `Where the information came from, per field (${profileSourceFields.join(', ')}). ` +
      'Shown on the profile as "Fra <source> · ikke bekreftet" until the person confirms. Always include for researched data.',
  )

async function personDetails(ctx: ToolContext, personId: string) {
  const { db, viewer } = ctx
  const [admin, profile, events, quotes, badges] = await Promise.all([
    getPersonAdmin(db, viewer, personId),
    getEditableProfile(db, viewer, personId),
    loadPersonEvents(db, personId),
    loadQuotes(db, viewer, { personId }),
    loadPersonBadgesForAdmin(db, viewer, personId),
  ])
  const sources = await loadFieldSources(db, viewer, 'person', personId, profileSourceFields)
  return {
    personId,
    link: links.person(ctx, personId),
    fullName: profile.fullName,
    claimed: admin.claimed,
    status: admin.status,
    role: admin.role,
    source: admin.source,
    cohorts: admin.cohorts,
    knownEmails: admin.emails,
    photo: links.asset(ctx, profile.photo?.large),
    city: profile.city,
    studyBackground: profile.studyBackground,
    bio: profile.bio,
    linkedinUrl: profile.linkedinUrl,
    expertise: profile.expertise,
    industries: profile.industries,
    esCompany: profile.esCompany ? { id: profile.esCompanyId, name: profile.esCompany } : null,
    experience: profile.experience.map((e) => ({
      experienceId: e.id,
      companyId: e.companyId,
      company: e.company,
      companySlug: e.companySlug,
      title: e.title,
      startYear: e.startYear,
      endYear: e.endYear,
      founder: e.founder,
    })),
    // Kontaktinfo bare for profiler ingen har tatt i bruk; ellers er den personens egen.
    contact:
      profile.contactAccess === 'visibility'
        ? {
            email: profile.contactEmail,
            emailVisible: profile.contactEmailVisible,
            phone: profile.phone,
            phoneVisible: profile.phoneVisible,
          }
        : 'Only the person can see and change contact details on a claimed profile.',
    events: events.map((g) => ({
      type: g.type.name,
      total: g.total,
      events: g.events.map((e) => ({ eventId: e.id, name: e.name, role: e.role })),
    })),
    badges: badges.map((b) => ({
      badgeId: b.badgeId,
      slug: b.slug,
      name: b.name,
      badgeStatus: b.status,
      source: b.source,
      achievedOn: b.achievedOn,
      citation: b.citation,
      hiddenByPerson: b.hidden,
    })),
    quotes: quotes.map((q) => ({
      quoteId: q.id,
      text: q.text,
      company: q.company?.name ?? null,
      date: q.date,
      source: q.source,
      confidence: q.confidence,
    })),
    sources: sources.map((s) => ({
      field: s.field,
      label: s.label,
      url: s.url,
      confirmed: s.confirmed,
      confidence: s.confidence,
    })),
  }
}

export function registerPeopleTools(server: McpServer, ctx: ToolContext) {
  defineTool(server, ctx, {
    name: 'list_people',
    title: 'List people',
    description:
      'All people ESAF knows about: members with accounts and unclaimed profiles (from the cohort list or created by admins), ' +
      'including pending and deactivated. Filter to find profiles that need work, e.g. missing=["photo","bio"] for a cohort. ' +
      'Returns compact summaries; use get_person for everything about one person.',
    input: z.object({
      query: z
        .string()
        .max(100)
        .optional()
        .describe('Case-insensitive match on name, current company, job title or city.'),
      cohort: z.number().int().optional().describe('Graduation year, e.g. 2024 for ES 2024.'),
      relation: z.enum(['student', 'staff', 'mentor']).optional(),
      claimed: z.boolean().optional().describe('true = has an account; false = unclaimed profile.'),
      status: z.enum(['active', 'pending', 'inactive']).optional(),
      role: z.enum(['member', 'moderator', 'admin', 'owner']).optional(),
      source: z.enum(['signup', 'import', 'admin']).optional(),
      missing: z
        .array(z.enum(missingKeys))
        .optional()
        .describe('Only people missing ALL of these fields.'),
      ...page,
    }),
    effect: 'read',
    run: async (args, ctx) => {
      const q = args.query?.trim().toLocaleLowerCase('nb')
      const people = (await listPeopleIndex(ctx.db, ctx.viewer)).filter(
        (p) =>
          (!q ||
            [p.fullName, p.currentCompany, p.jobTitle, p.city].some((v) =>
              v?.toLocaleLowerCase('nb').includes(q),
            )) &&
          (args.cohort === undefined ||
            p.cohorts.some(
              (c) =>
                c.graduationYear === args.cohort &&
                (!args.relation || c.relation === args.relation),
            )) &&
          (args.cohort !== undefined ||
            !args.relation ||
            p.cohorts.some((c) => c.relation === args.relation)) &&
          (args.claimed === undefined || p.claimed === args.claimed) &&
          (!args.status || p.status === args.status) &&
          (!args.role || p.role === args.role) &&
          (!args.source || p.source === args.source) &&
          (args.missing ?? []).every((k) => !p.has[k]),
      )
      const result = paginate(people, args)
      return { ...result, items: result.items.map((p) => personSummary(ctx, p)) }
    },
  })

  defineTool(server, ctx, {
    name: 'get_person',
    title: 'Get person',
    description:
      'Everything an admin can see about one person: profile fields, experience (with experienceId), cohorts, ' +
      'known e-mail addresses, membership and role, events, badges, quotes and where imported or researched fields came from. ' +
      'Contact details are only included for unclaimed profiles.',
    input: z.object({ personId: id('The person') }),
    effect: 'read',
    run: (args, ctx) => personDetails(ctx, args.personId),
  })

  defineTool(server, ctx, {
    name: 'create_profiles',
    title: 'Create profiles (bulk)',
    description:
      `Create up to ${PROFILE_BATCH_MAX} unclaimed profiles at once, e.g. a whole new cohort before anyone is invited. ` +
      'Profiles never give access to any account; invite people separately with create_invitation. ' +
      'ALWAYS call with dryRun=true first (the default): each row comes back as create, duplicate (with the matching ' +
      'people and why) or invalid (with errors). Then call again with dryRun=false. Rows marked duplicate are skipped ' +
      'unless allowDuplicates=true (only after checking they really are different people); rows whose e-mail belongs ' +
      'to someone else are never created. Photos are downloaded from photoUrl on the real run; a photo that fails ' +
      'gives a warning and the profile is created without it.',
    input: z.object({
      profiles: z
        .array(
          z.object({
            ref: z.string().max(100).optional().describe('Your own key for the row, echoed back.'),
            fullName: z.string().max(120),
            cohorts: z.array(cohortInput).max(10).optional(),
            emails: z
              .array(z.string().max(200))
              .max(10)
              .optional()
              .describe(
                'Known e-mail addresses. Used to link an account to the profile later; never shown.',
              ),
            status: z
              .enum(['active', 'pending'])
              .optional()
              .describe('active (default) shows the profile in the member directory right away.'),
            city: z.string().max(80).optional(),
            studyBackground: z.string().max(120).optional().describe('Study programme before ES.'),
            bio: z.string().max(1000).optional().describe('Short bio, third person, Norwegian.'),
            linkedinUrl: z.string().max(300).optional(),
            expertise: z
              .array(z.string().max(40))
              .max(10)
              .optional()
              .describe('"Kan hjelpe med" topics.'),
            industries: z.array(z.string().max(40)).max(10).optional(),
            esCompany: z.string().max(120).optional().describe('The company the person had at ES.'),
            esCompanyId: z.uuid().optional(),
            experience: z.array(experienceInput).max(30).optional(),
            contactEmail: z
              .string()
              .max(200)
              .optional()
              .describe(
                'E-mail shown to members (like the cohort phone list). Also becomes a known address.',
              ),
            contactEmailVisible: z.boolean().optional(),
            phone: z.string().max(30).optional().describe('Phone shown to members.'),
            phoneVisible: z.boolean().optional(),
            photoUrl: z.string().max(2000).optional().describe('Public URL of a portrait photo.'),
            sources: z.array(sourceInput).max(30).optional(),
          }),
        )
        .min(1)
        .max(PROFILE_BATCH_MAX),
      dryRun: z.boolean().default(true).describe('Only report what would happen. Default true.'),
      allowDuplicates: z
        .boolean()
        .default(false)
        .describe('Also create rows that look like existing people.'),
    }),
    effect: 'write',
    run: async (args, ctx) => {
      const rows = args.profiles.map(({ photoUrl: _photo, experience, ...p }) => ({
        ...p,
        ...(experience ? { experience: experience.map(toExperience) } : {}),
      }))
      if (args.dryRun) {
        const plan = await planProfileBatch(ctx.db, ctx.viewer, rows)
        return {
          dryRun: true,
          ...plan,
          photos: args.profiles.filter((p) => p.photoUrl).length,
          next: 'Check duplicates and errors, then call again with dryRun=false.',
        }
      }
      // Bildene hentes før profilene lages, fire om gangen.
      const photos = new Map<number, Uint8Array>()
      const fetchWarnings = new Map<number, string>()
      const queue = args.profiles.flatMap((p, row) =>
        p.photoUrl ? [{ row, url: p.photoUrl }] : [],
      )
      await Promise.all(
        Array.from({ length: Math.min(4, queue.length) }, async () => {
          for (let next = queue.shift(); next; next = queue.shift()) {
            try {
              photos.set(next.row, await ctx.fetchImage(next.url))
            } catch (error) {
              if (!(error instanceof DomainError)) throw error
              fetchWarnings.set(next.row, `Bildet ble ikke hentet: ${error.message}`)
            }
          }
        }),
      )
      const result = await createProfileBatch(ctx.db, ctx.storage, ctx.viewer, rows, {
        allowDuplicates: args.allowDuplicates,
        photos,
      })
      return {
        dryRun: false,
        created: result.created,
        skipped: result.skipped,
        rows: result.rows.map((r) => ({
          ...r,
          warnings: [
            ...(r.personId && fetchWarnings.has(r.row) ? [fetchWarnings.get(r.row)!] : []),
            ...r.warnings,
          ],
          link: r.personId ? links.person(ctx, r.personId) : null,
        })),
      }
    },
  })

  defineTool(server, ctx, {
    name: 'update_person',
    title: 'Update person',
    description:
      'Change profile fields on anyone (admin edit, logged as profile.admin_edit). Only the fields you send change. ' +
      'experience replaces the whole list; use add_experience/remove_experience for single changes. ' +
      'Never changes contact details of a claimed profile. On an unclaimed profile you can show/hide contact details, ' +
      'and fill in contactEmail/phone only where they are empty. Add sources for researched data.',
    input: z.object({
      personId: id('The person'),
      fullName: z.string().max(120).optional(),
      city: z.string().max(80).nullable().optional(),
      studyBackground: z.string().max(120).nullable().optional(),
      bio: z.string().max(1000).nullable().optional(),
      linkedinUrl: z.string().max(300).nullable().optional(),
      expertise: z.array(z.string().max(40)).max(10).optional(),
      industries: z.array(z.string().max(40)).max(10).optional(),
      esCompany: z
        .string()
        .max(120)
        .nullable()
        .optional()
        .describe('Company at ES by name; null removes it.'),
      esCompanyId: z.uuid().nullable().optional(),
      experience: z.array(experienceInput).max(30).optional(),
      contactEmailVisible: z.boolean().optional().describe('Unclaimed profiles only.'),
      phoneVisible: z.boolean().optional().describe('Unclaimed profiles only.'),
      contactEmail: z
        .string()
        .max(200)
        .optional()
        .describe('Unclaimed profiles only, and only when empty.'),
      phone: z
        .string()
        .max(30)
        .optional()
        .describe('Unclaimed profiles only, and only when empty.'),
      sources: sourcesField,
    }),
    effect: 'write',
    idempotent: true,
    run: async (args, ctx) => {
      const { personId, sources, contactEmail, phone, experience, ...changes } = args
      const current = await getEditableProfile(ctx.db, ctx.viewer, personId)
      if (current.contactAccess !== 'visibility') {
        if (
          contactEmail ||
          phone ||
          changes.contactEmailVisible !== undefined ||
          changes.phoneVisible !== undefined
        ) {
          throw new DomainError(
            'Profilen er tatt i bruk, og bare personen selv endrer kontaktinfoen.',
          )
        }
      }
      const fields = Object.fromEntries(
        Object.entries(changes).filter(([, v]) => v !== undefined),
      ) as Partial<ProfileInput>
      const next: ProfileInput = {
        ...inputFrom(current),
        ...fields,
        // Et nytt ES-selskap uten id finnes på navnet; den gamle id-en ville ellers vunnet.
        ...(changes.esCompany !== undefined && changes.esCompanyId === undefined
          ? { esCompanyId: null }
          : {}),
        ...(experience ? { experience: experience.map(toExperience) } : {}),
      }
      // Alt eller ingenting: avviser `fillUnclaimedContact` en kontaktinfo som
      // står der fra før, eller en kilde er ugyldig, lagres heller ikke resten.
      const filled = await ctx.db.transaction(async (tx) => {
        await updateProfile(tx, ctx.viewer, personId, next)
        const filled =
          contactEmail || phone
            ? await fillUnclaimedContact(tx, ctx.viewer, personId, { contactEmail, phone })
            : null
        if (sources?.length) {
          await addFieldSources(tx, ctx.viewer, {
            entityType: 'person',
            entityId: personId,
            sources,
          })
        }
        return filled
      })
      return {
        updated: true,
        ...(filled ? { contactFilled: filled.filled } : {}),
        person: await personDetails(ctx, personId),
      }
    },
  })

  defineTool(server, ctx, {
    name: 'add_experience',
    title: 'Add experience',
    description:
      'Add one job or founded company to a person. The company is matched by id or name (same slug), or created with unknown status.',
    input: experienceInput.extend({
      personId: id('The person'),
      position: z
        .enum(['first', 'last'])
        .default('first')
        .describe('Where in the list. The first current role is shown under the name.'),
      sources: sourcesField,
    }),
    effect: 'write',
    run: async ({ personId, position, sources, ...role }, ctx) => {
      const current = await getEditableProfile(ctx.db, ctx.viewer, personId)
      const list = experienceFrom(current)
      const entry = toExperience(role)
      await updateProfile(ctx.db, ctx.viewer, personId, {
        ...inputFrom(current),
        experience: position === 'first' ? [entry, ...list] : [...list, entry],
      })
      if (sources?.length) {
        await addFieldSources(ctx.db, ctx.viewer, {
          entityType: 'person',
          entityId: personId,
          sources,
        })
      }
      return (await personDetails(ctx, personId)).experience
    },
  })

  defineTool(server, ctx, {
    name: 'remove_experience',
    title: 'Remove experience',
    description: 'Remove one experience entry (experienceId from get_person).',
    input: z.object({ personId: id('The person'), experienceId: id('The experience entry') }),
    effect: 'destructive',
    run: async ({ personId, experienceId }, ctx) => {
      const current = await getEditableProfile(ctx.db, ctx.viewer, personId)
      const index = current.experience.findIndex((e) => e.id === experienceId)
      if (index < 0) throw new DomainError('Fant ikke erfaringen.')
      const list = experienceFrom(current).filter((_, i) => i !== index)
      await updateProfile(ctx.db, ctx.viewer, personId, { ...inputFrom(current), experience: list })
      return (await personDetails(ctx, personId)).experience
    },
  })

  defineTool(server, ctx, {
    name: 'set_person_cohorts',
    title: 'Set cohorts',
    description: 'Replace the cohorts a person belongs to (student, staff or mentor per cohort).',
    input: z.object({ personId: id('The person'), cohorts: z.array(cohortInput).max(10) }),
    effect: 'write',
    idempotent: true,
    run: async ({ personId, cohorts }, ctx) => {
      await setPersonCohorts(ctx.db, ctx.viewer, personId, cohorts)
      return { personId, cohorts }
    },
  })

  defineTool(server, ctx, {
    name: 'add_person_email',
    title: 'Add known e-mail',
    description:
      'Add a known e-mail address to a person. An account signing up or invited with it is linked to this profile. Never shown to members.',
    input: z.object({ personId: id('The person'), email: z.string().max(200) }),
    effect: 'write',
    run: async ({ personId, email }, ctx) => {
      await addPersonEmail(ctx.db, ctx.viewer, personId, email)
      return (await getPersonAdmin(ctx.db, ctx.viewer, personId)).emails
    },
  })

  defineTool(server, ctx, {
    name: 'remove_person_email',
    title: 'Remove known e-mail',
    description:
      'Remove a known e-mail address. The address the account signs in with cannot be removed.',
    input: z.object({ personId: id('The person'), email: z.string().max(200) }),
    effect: 'destructive',
    run: async ({ personId, email }, ctx) => {
      await removePersonEmail(ctx.db, ctx.viewer, personId, email)
      return (await getPersonAdmin(ctx.db, ctx.viewer, personId)).emails
    },
  })

  defineTool(server, ctx, {
    name: 'set_profile_photo',
    title: 'Set profile photo',
    description:
      'Upload or replace a profile photo for an active member or unclaimed profile, from a public image URL or base64. ' +
      'The photo is cropped to a square from the top, stripped of all metadata and stored as WebP. ' +
      'Use a clear portrait of the right person, from a source the person controls (company site, ES site, LinkedIn).',
    input: z.object({
      personId: id('The person'),
      ...imageInput,
      source: sourceInput
        .omit({ field: true })
        .optional()
        .describe('Where the photo came from; shown on the profile until the person confirms.'),
    }),
    effect: 'write',
    run: async ({ personId, source, ...image }, ctx) => {
      const file = await readImage(ctx, image, decodeBase64Image)
      const photo = await setProfilePhoto(ctx.db, ctx.storage, ctx.viewer, personId, file)
      if (source) {
        await addFieldSources(ctx.db, ctx.viewer, {
          entityType: 'person',
          entityId: personId,
          sources: [{ ...source, field: 'photo' }],
        })
      }
      return { personId, photo: links.asset(ctx, photo.large) }
    },
  })

  defineTool(server, ctx, {
    name: 'remove_profile_photo',
    title: 'Remove profile photo',
    description: 'Remove a profile photo, so initials are shown again.',
    input: z.object({ personId: id('The person') }),
    effect: 'destructive',
    idempotent: true,
    run: async ({ personId }, ctx) => {
      await removeProfilePhoto(ctx.db, ctx.storage, ctx.viewer, personId)
      return { personId, photo: null }
    },
  })

  defineTool(server, ctx, {
    name: 'merge_people',
    title: 'Merge duplicate people',
    description:
      'Merge a duplicate (sourceId) into another person (targetId). Everything moves over: experience, cohorts, ' +
      'e-mails, quotes, sources, posts, events, representative terms; empty fields are filled from the duplicate, ' +
      "and filled fields keep the kept profile's value unless listed in useSource. Check both with get_person first. " +
      'If one has an account, that one is kept. Two accounts are never merged. Cannot be undone.',
    input: z.object({
      sourceId: id('The duplicate, which disappears'),
      targetId: id('The person to keep'),
      useSource: z
        .array(z.enum(mergeChoiceFields))
        .optional()
        .describe(
          "Fields where the duplicate's value should win when both have different values " +
            '(e.g. a better bio or the correct name). Ignored for fields that are empty or equal.',
        ),
    }),
    effect: 'destructive',
    run: async (args, ctx) => {
      const { personId } = await mergePeople(ctx.db, ctx.storage, ctx.viewer, args)
      return { keptPersonId: personId, link: links.person(ctx, personId) }
    },
  })

  defineTool(server, ctx, {
    name: 'delete_profile',
    title: 'Delete unclaimed profile',
    description:
      'Delete a profile nobody has claimed, e.g. one created by mistake. Prefer merge_people for duplicates. ' +
      'Profiles with an account, posts or comments are never deleted. Requires a reason. Cannot be undone.',
    input: z.object({ personId: id('The profile'), reason }),
    effect: 'destructive',
    run: async (args, ctx) => {
      await deleteProfile(ctx.db, ctx.storage, ctx.viewer, args)
      return { deleted: args.personId }
    },
  })
}
