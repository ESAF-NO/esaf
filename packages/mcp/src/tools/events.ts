import {
  addCohortRepresentative,
  addEventCohort,
  addEventParticipants,
  createEvent,
  createEventHistory,
  createEventType,
  deleteEvent,
  deleteEventType,
  endCohortRepresentative,
  eventDatePrecisions,
  getEditableEvent,
  getEvent,
  getEventTypeOverview,
  historyFrequencies,
  listCohortRepresentatives,
  listEventTypes,
  listPeopleIndex,
  listRepresentativeOverview,
  matchEventParticipants,
  previewEventHistory,
  removeCohortRepresentative,
  removeEventParticipant,
  updateCohortRepresentative,
  updateEvent,
  updateEventParticipant,
  updateEventType,
} from '@esaf/core'
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { defineTool, id, links, type ToolContext } from '../context.ts'

const role = z
  .enum(['organizer', 'speaker', 'volunteer'])
  .nullable()
  .default(null)
  .describe('organizer, speaker or volunteer; null = participant.')

const eventFields = {
  typeId: id('The event type'),
  name: z.string().max(120).describe('E.g. "ESAF-helgen høst 2018".'),
  startDate: z
    .string()
    .describe('YYYY-MM-DD. With semester/year precision, any date in the period.'),
  endDate: z.string().nullable().default(null).describe('YYYY-MM-DD, for multi-day events.'),
  datePrecision: z
    .enum(eventDatePrecisions)
    .default('day')
    .describe(
      'day, semester (stored as 1 Jan / 1 Jul) or year — for old events where only that is known.',
    ),
  location: z.string().max(120).nullable().default(null),
  description: z.string().max(2000).nullable().default(null),
}

async function eventDetails(ctx: ToolContext, eventId: string) {
  const e = await getEvent(ctx.db, ctx.viewer, eventId)
  return {
    eventId: e.id,
    link: links.event(ctx, e.type.slug, e.id),
    name: e.name,
    type: e.type,
    startDate: e.startDate,
    endDate: e.endDate,
    datePrecision: e.datePrecision,
    location: e.location,
    description: e.description,
    upcoming: e.upcoming,
    participants: e.participants,
    roles: e.roles,
    groups: e.groups.map((g) => ({
      cohort: g.graduationYear,
      people: g.people.map((p) => ({
        personId: p.personId,
        fullName: p.fullName,
        role: p.role,
        status: p.status,
        source: p.source,
        note: p.note,
      })),
    })),
  }
}

export function registerCohortAndEventTools(server: McpServer, ctx: ToolContext) {
  // -------------------------------------------------------------------------
  // Kull og kullrepresentanter
  // -------------------------------------------------------------------------

  defineTool(server, ctx, {
    name: 'list_cohorts',
    title: 'List cohorts',
    description:
      'All cohorts (by graduation year) with people counts, how many have claimed their profile, and current representatives.',
    input: z.object({}),
    effect: 'read',
    run: async (_args, ctx) => {
      const [people, reps] = await Promise.all([
        listPeopleIndex(ctx.db, ctx.viewer),
        listRepresentativeOverview(ctx.db, ctx.viewer),
      ])
      const byYear = new Map<
        number,
        { total: number; claimed: number; active: number; staffOrMentors: number }
      >()
      for (const p of people) {
        for (const c of p.cohorts) {
          const row = byYear.get(c.graduationYear) ?? {
            total: 0,
            claimed: 0,
            active: 0,
            staffOrMentors: 0,
          }
          if (c.relation === 'student') {
            row.total++
            if (p.claimed) row.claimed++
            if (p.status === 'active') row.active++
          } else row.staffOrMentors++
          byYear.set(c.graduationYear, row)
        }
      }
      const repsByYear = new Map(reps.map((r) => [r.graduationYear, r]))
      return [...new Set([...byYear.keys(), ...repsByYear.keys()])]
        .sort((a, b) => b - a)
        .map((year) => ({
          graduationYear: year,
          name: `ES ${year}`,
          period: `${year - 2}–${year}`,
          students: byYear.get(year)?.total ?? 0,
          activeStudents: byYear.get(year)?.active ?? 0,
          claimed: byYear.get(year)?.claimed ?? 0,
          staffOrMentors: byYear.get(year)?.staffOrMentors ?? 0,
          representatives: (repsByYear.get(year)?.current ?? []).map((r) => ({
            representativeId: r.id,
            personId: r.personId,
            fullName: r.fullName,
          })),
        }))
    },
  })

  defineTool(server, ctx, {
    name: 'get_cohort',
    title: 'Get cohort',
    description:
      'One cohort: everyone in it (students, staff, mentors; claimed or not, any status), and current and past representatives with ids.',
    input: z.object({ graduationYear: z.number().int() }),
    effect: 'read',
    run: async ({ graduationYear }, ctx) => {
      const [people, reps] = await Promise.all([
        listPeopleIndex(ctx.db, ctx.viewer),
        listCohortRepresentatives(ctx.db, ctx.viewer, graduationYear),
      ])
      const members = people.flatMap((p) => {
        const c = p.cohorts.find((c) => c.graduationYear === graduationYear)
        return c
          ? [
              {
                personId: p.personId,
                fullName: p.fullName,
                relation: c.relation,
                claimed: p.claimed,
                status: p.status,
                jobTitle: p.jobTitle,
                currentCompany: p.currentCompany,
                missing: Object.entries(p.has)
                  .filter(([, v]) => !v)
                  .map(([k]) => k),
              },
            ]
          : []
      })
      const rep = (r: (typeof reps.current)[number]) => ({
        representativeId: r.id,
        personId: r.personId,
        fullName: r.fullName,
        startYear: r.startYear,
        endYear: r.endYear,
        note: r.note,
      })
      return {
        graduationYear,
        name: `ES ${graduationYear}`,
        counts: {
          students: members.filter((m) => m.relation === 'student').length,
          claimed: members.filter((m) => m.relation === 'student' && m.claimed).length,
        },
        representatives: { current: reps.current.map(rep), past: reps.past.map(rep) },
        people: members,
      }
    },
  })

  defineTool(server, ctx, {
    name: 'add_cohort_representative',
    title: 'Add cohort representative',
    description:
      'Make a person representative for a cohort from startYear (default this year). A person from another cohort ' +
      'requires otherCohort=true. Several representatives per cohort are allowed.',
    input: z.object({
      graduationYear: z.number().int(),
      personId: id('The person'),
      startYear: z.number().int().nullable().default(null),
      note: z.string().max(300).nullable().default(null).describe('Only admins see it.'),
      otherCohort: z.boolean().default(false),
    }),
    effect: 'write',
    run: async (args, ctx) => {
      const { id: representativeId } = await addCohortRepresentative(ctx.db, ctx.viewer, args)
      return { representativeId }
    },
  })

  defineTool(server, ctx, {
    name: 'update_cohort_representative',
    title: 'Update cohort representative',
    description:
      'Change the years and note of a representative term (send all fields; endYear null = current).',
    input: z.object({
      representativeId: id('The term'),
      startYear: z.number().int().nullable(),
      endYear: z.number().int().nullable(),
      note: z.string().max(300).nullable(),
    }),
    effect: 'write',
    idempotent: true,
    run: async ({ representativeId, ...term }, ctx) => {
      await updateCohortRepresentative(ctx.db, ctx.viewer, representativeId, term)
      return { representativeId, updated: true }
    },
  })

  defineTool(server, ctx, {
    name: 'end_cohort_representative',
    title: 'End cohort representative term',
    description:
      'End a current term, through endYear (default this year). The term stays as history.',
    input: z.object({
      representativeId: id('The term'),
      endYear: z.number().int().nullable().optional(),
    }),
    effect: 'write',
    run: async ({ representativeId, endYear }, ctx) => {
      await endCohortRepresentative(ctx.db, ctx.viewer, representativeId, { endYear })
      return { representativeId, ended: true }
    },
  })

  defineTool(server, ctx, {
    name: 'remove_cohort_representative',
    title: 'Remove cohort representative term',
    description:
      'Delete a term that was added by mistake. To end a real term, use end_cohort_representative.',
    input: z.object({ representativeId: id('The term') }),
    effect: 'destructive',
    run: async ({ representativeId }, ctx) => {
      await removeCohortRepresentative(ctx.db, ctx.viewer, representativeId)
      return { removed: representativeId }
    },
  })

  // -------------------------------------------------------------------------
  // Arrangementer
  // -------------------------------------------------------------------------

  defineTool(server, ctx, {
    name: 'list_event_types',
    title: 'List event types',
    description: 'Event types (ESAF-helgen first) with ids, counts and the latest event.',
    input: z.object({}),
    effect: 'read',
    run: async (_args, ctx) => (await listEventTypes(ctx.db, ctx.viewer)).types,
  })

  defineTool(server, ctx, {
    name: 'create_event_type',
    title: 'Create event type',
    description:
      'Add an event type, e.g. "Generalforsamling". The URL slug comes from the name and never changes.',
    input: z.object({
      name: z.string().max(60),
      plural: z.string().max(60).nullable().default(null),
      description: z.string().max(500).nullable().default(null),
      sortOrder: z.number().int().min(0).max(1000).default(100),
    }),
    effect: 'write',
    run: (args, ctx) => createEventType(ctx.db, ctx.viewer, args),
  })

  defineTool(server, ctx, {
    name: 'update_event_type',
    title: 'Update event type',
    description: 'Change name, plural, description and order of an event type (send all fields).',
    input: z.object({
      typeId: id('The event type'),
      name: z.string().max(60),
      plural: z.string().max(60).nullable(),
      description: z.string().max(500).nullable(),
      sortOrder: z.number().int().min(0).max(1000),
    }),
    effect: 'write',
    idempotent: true,
    run: async ({ typeId, ...input }, ctx) => {
      await updateEventType(ctx.db, ctx.viewer, typeId, input)
      return { typeId, updated: true }
    },
  })

  defineTool(server, ctx, {
    name: 'delete_event_type',
    title: 'Delete event type',
    description: 'Delete an event type without events. ESAF-helgen cannot be deleted.',
    input: z.object({ typeId: id('The event type') }),
    effect: 'destructive',
    run: async ({ typeId }, ctx) => {
      await deleteEventType(ctx.db, ctx.viewer, typeId)
      return { deleted: typeId }
    },
  })

  defineTool(server, ctx, {
    name: 'list_events',
    title: 'List events',
    description:
      'Events of one type (by type slug, e.g. "esaf-helgen"), newest first, with participant counts and cohort stats.',
    input: z.object({ typeSlug: z.string().max(80) }),
    effect: 'read',
    run: async ({ typeSlug }, ctx) => {
      const o = await getEventTypeOverview(ctx.db, ctx.viewer, typeSlug)
      return {
        type: o.type,
        people: o.people,
        participations: o.participations,
        roles: o.roles,
        cohorts: o.cohorts,
        events: o.events.map((e) => ({
          eventId: e.id,
          name: e.name,
          startDate: e.startDate,
          endDate: e.endDate,
          datePrecision: e.datePrecision,
          location: e.location,
          participants: e.participants,
          roles: e.roles,
          upcoming: e.upcoming,
        })),
      }
    },
  })

  defineTool(server, ctx, {
    name: 'get_event',
    title: 'Get event',
    description:
      'One event with all participants grouped by cohort, including role, how they were added and admin notes.',
    input: z.object({ eventId: id('The event') }),
    effect: 'read',
    run: ({ eventId }, ctx) => eventDetails(ctx, eventId),
  })

  defineTool(server, ctx, {
    name: 'create_event',
    title: 'Create event',
    description:
      'Create an event. Past dates are fine; participation can only be added once it has started.',
    input: z.object(eventFields),
    effect: 'write',
    run: async (args, ctx) => {
      const { id: eventId, typeSlug } = await createEvent(ctx.db, ctx.viewer, args)
      return { eventId, link: links.event(ctx, typeSlug, eventId) }
    },
  })

  defineTool(server, ctx, {
    name: 'update_event',
    title: 'Update event',
    description:
      'Change an event. Only the fields you send change; changing typeId moves it to another type.',
    input: z.object({
      eventId: id('The event'),
      typeId: z.uuid().optional(),
      name: z.string().max(120).optional(),
      startDate: z.string().optional(),
      endDate: z.string().nullable().optional(),
      datePrecision: z.enum(eventDatePrecisions).optional(),
      location: z.string().max(120).nullable().optional(),
      description: z.string().max(2000).nullable().optional(),
    }),
    effect: 'write',
    idempotent: true,
    run: async ({ eventId, ...changes }, ctx) => {
      const { id: _id, ...current } = await getEditableEvent(ctx.db, ctx.viewer, eventId)
      const set = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined))
      await updateEvent(ctx.db, ctx.viewer, eventId, { ...current, ...set })
      return eventDetails(ctx, eventId)
    },
  })

  defineTool(server, ctx, {
    name: 'delete_event',
    title: 'Delete event',
    description: 'Delete an event and its participation records. Cannot be undone.',
    input: z.object({ eventId: id('The event') }),
    effect: 'destructive',
    run: async ({ eventId }, ctx) => {
      await deleteEvent(ctx.db, ctx.viewer, eventId)
      return { deleted: eventId }
    },
  })

  defineTool(server, ctx, {
    name: 'match_event_participants',
    title: 'Match a list of names to people',
    description:
      'Match a pasted list (one person per line: name, e-mail or both, optionally with a year like "Kari Nordmann 2019") ' +
      'to people, for an event. Shows found, several possible, possible match, not found, already registered. Writes nothing; ' +
      'add the chosen personIds with add_event_participants.',
    input: z.object({ eventId: id('The event'), text: z.string().max(100_000) }),
    effect: 'read',
    run: ({ eventId, text }, ctx) => matchEventParticipants(ctx.db, ctx.viewer, eventId, text),
  })

  defineTool(server, ctx, {
    name: 'add_event_participants',
    title: 'Add event participants',
    description:
      'Register people as participants of an event that has started, optionally with a role. Existing roles are kept.',
    input: z.object({
      eventId: id('The event'),
      personIds: z.array(z.uuid()).min(1).max(500),
      role,
    }),
    effect: 'write',
    idempotent: true,
    run: async ({ eventId, personIds, role }, ctx) =>
      addEventParticipants(ctx.db, ctx.viewer, eventId, { personIds, role, source: 'admin' }),
  })

  defineTool(server, ctx, {
    name: 'add_event_cohort',
    title: 'Add a whole cohort to an event',
    description: 'Register all active members who were students in a cohort as participants.',
    input: z.object({ eventId: id('The event'), graduationYear: z.number().int() }),
    effect: 'write',
    idempotent: true,
    run: ({ eventId, graduationYear }, ctx) =>
      addEventCohort(ctx.db, ctx.viewer, eventId, graduationYear),
  })

  defineTool(server, ctx, {
    name: 'update_event_participant',
    title: 'Update event participant',
    description: 'Change the role and admin note of a participant.',
    input: z.object({
      eventId: id('The event'),
      personId: id('The participant'),
      role,
      note: z.string().max(300).nullable().default(null),
    }),
    effect: 'write',
    idempotent: true,
    run: async ({ eventId, personId, ...input }, ctx) => {
      await updateEventParticipant(ctx.db, ctx.viewer, eventId, personId, input)
      return { eventId, personId, updated: true }
    },
  })

  defineTool(server, ctx, {
    name: 'remove_event_participant',
    title: 'Remove event participant',
    description: 'Remove a person from an event they were registered for by mistake.',
    input: z.object({ eventId: id('The event'), personId: id('The participant') }),
    effect: 'destructive',
    run: async ({ eventId, personId }, ctx) => {
      await removeEventParticipant(ctx.db, ctx.viewer, eventId, personId)
      return { eventId, removed: personId }
    },
  })

  defineTool(server, ctx, {
    name: 'preview_event_history',
    title: 'Preview event history',
    description:
      'Plan past events of a type for a range of years ("every autumn 2010–2019"). Each period is new, exists, ' +
      'overlap (another event in the same period) or future. Writes nothing; create with create_event_history.',
    input: z.object({
      typeId: id('The event type'),
      fromYear: z.number().int(),
      toYear: z.number().int(),
      frequency: z.enum(historyFrequencies),
    }),
    effect: 'read',
    run: (args, ctx) => previewEventHistory(ctx.db, ctx.viewer, args),
  })

  defineTool(server, ctx, {
    name: 'create_event_history',
    title: 'Create event history',
    description:
      'Create past events for the chosen periods (from preview_event_history), in one transaction. Existing names are skipped.',
    input: z.object({
      typeId: id('The event type'),
      items: z
        .array(z.object({ year: z.number().int(), period: z.enum(['year', 'spring', 'autumn']) }))
        .min(1)
        .max(100),
      location: z.string().max(120).nullable().default(null),
    }),
    effect: 'write',
    idempotent: true,
    run: (args, ctx) => createEventHistory(ctx.db, ctx.viewer, args),
  })
}
