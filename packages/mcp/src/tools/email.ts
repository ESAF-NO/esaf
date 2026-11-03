import {
  assertCan,
  emailCatalog,
  emailKinds,
  emailOverview,
  emailStatuses,
  getEmailSwitch,
  listEmailLog,
  sendTestEmail,
  setEmailPaused,
} from '@esaf/core'
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { defineTool, id, links, type ToolContext } from '../context.ts'

// E-post: malene og når de sendes, tallene, og loggen over hva som er sendt.
// Reglene og rettighetene (`audit.read`) står i @esaf/core (email-log.ts).

const templateKinds = emailKinds.filter((k) => k !== 'test') as [
  Exclude<(typeof emailKinds)[number], 'test'>,
  ...Exclude<(typeof emailKinds)[number], 'test'>[],
]

export function registerEmailTools(server: McpServer, ctx: ToolContext) {
  defineTool(server, ctx, {
    name: 'email_templates',
    title: 'E-mail templates and flows',
    description:
      'Every e-mail the app sends: what triggers it, who gets it, when, and how to stop it, with the subject of ' +
      'a sample. Use email_preview to see the full text of one.',
    input: z.object({}),
    effect: 'read',
    run: async (_args, ctx) => {
      assertCan(ctx.viewer, 'audit.read')
      return {
        sending: ctx.mailer !== null,
        templates: emailCatalog(ctx.appUrl).map(({ sample, ...t }) => ({
          ...t,
          sampleSubject: sample.subject,
        })),
      }
    },
  })

  defineTool(server, ctx, {
    name: 'email_preview',
    title: 'Preview an e-mail',
    description:
      'The sample of one e-mail as it is sent: subject and plain text (HTML on request). Fictional people and ' +
      'links that do not work.',
    input: z.object({
      kind: z.enum(templateKinds),
      html: z.boolean().default(false).describe('Also return the HTML version.'),
    }),
    effect: 'read',
    run: async ({ kind, html }, ctx) => {
      assertCan(ctx.viewer, 'audit.read')
      const template = emailCatalog(ctx.appUrl).find((t) => t.kind === kind)!
      return {
        name: template.name,
        subject: template.sample.subject,
        text: template.sample.text,
        ...(html && { html: template.sample.html }),
      }
    },
  })

  defineTool(server, ctx, {
    name: 'email_stats',
    title: 'E-mail statistics',
    description:
      'How many e-mails were sent, bounced and failed per kind (last 7 and 30 days and in total), per day for ' +
      'the last 30 days, and what members chose for notification e-mails per category.',
    input: z.object({}),
    effect: 'read',
    run: async (_args, ctx) => ({
      sending: ctx.mailer !== null,
      ...(await emailOverview(ctx.db, ctx.viewer)),
      paused: await getEmailSwitch(ctx.db),
      adminPage: `${ctx.appUrl}/admin/e-post`,
    }),
  })

  defineTool(server, ctx, {
    name: 'list_sent_emails',
    title: 'List sent e-mails',
    description:
      'The e-mail log, newest first: kind, recipient address and profile, subject, and outcome. Filter by kind, ' +
      'outcome, person, or search address/name/subject. Page with beforeId (the id of the last entry). ' +
      'Addresses are personal: only show them to the admin.',
    input: z.object({
      kind: z.enum(emailKinds).optional(),
      status: z.enum(emailStatuses).optional(),
      personId: id('Only e-mails to this person').optional(),
      q: z.string().max(200).optional(),
      beforeId: id('Id of the last entry on the previous page').optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }),
    effect: 'read',
    run: async (args, ctx) => {
      const entries = await listEmailLog(ctx.db, ctx.viewer, args)
      return entries.map((e) => ({
        ...e,
        person: e.person ? { ...e.person, link: links.person(ctx, e.person.personId) } : null,
      }))
    },
  })

  defineTool(server, ctx, {
    name: 'send_test_email',
    title: 'Send a test e-mail to yourself',
    description:
      'Sends the sample of one e-mail to the address the admin signs in with, with "[Test]" in the subject, to ' +
      'see it in a real mail client. Never sends to anyone else.',
    input: z.object({ kind: z.enum(templateKinds) }),
    effect: 'write',
    run: async ({ kind }, ctx) =>
      sendTestEmail(ctx.db, ctx.viewer, ctx.mailer, { kind, appUrl: ctx.appUrl }),
  })

  defineTool(server, ctx, {
    name: 'set_email_paused',
    title: 'Pause or resume all e-mail',
    description:
      'Pauses all e-mail from the app at once, or turns it back on. While paused nothing is sent: invitations ' +
      'and password links are still created (the admin shares them), and sign-up and "forgot password" are ' +
      'closed. On resume, notifications from the pause are not sent; welcomes are. Ask the admin first.',
    input: z.object({
      paused: z.boolean(),
      reason: z.string().max(500).optional().describe('Why, shown in the audit log (Norwegian).'),
    }),
    effect: 'write',
    idempotent: true,
    run: async (args, ctx) => setEmailPaused(ctx.db, ctx.viewer, args),
  })
}
