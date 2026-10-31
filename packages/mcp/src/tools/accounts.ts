import {
  changeRole,
  createInvitation,
  createPasswordResetLink,
  decideAccessRequest,
  describeInviteTarget,
  INVITATION_TTL_DAYS,
  listAccessRequests,
  listAccounts,
  listInvitations,
  removePasskeys,
  revokeInvitation,
  roles,
  setMemberAccess,
  type CreatedLink,
} from '@esaf/core'
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { defineTool, id, links, page, paginate, reason, type ToolContext } from '../context.ts'

/** Lenken slik den sendes, som i Admin → Invitasjoner. */
function linkOf(ctx: ToolContext, link: CreatedLink) {
  const path = link.kind === 'invite' ? '/invitasjon/' : '/nytt-passord/'
  return {
    id: link.id,
    kind: link.kind,
    email: link.email,
    role: link.role,
    url: `${ctx.appUrl}${path}${link.token}`,
    expiresAt: link.expiresAt,
    note:
      'The link is shown only once and works once. Send it to the person yourself (SMS, e-mail). ' +
      'Treat it like a password: do not store it or paste it anywhere else.',
  }
}

export function registerAccountTools(server: McpServer, ctx: ToolContext) {
  defineTool(server, ctx, {
    name: 'list_accounts',
    title: 'List accounts',
    description:
      'Everyone with an account who is or has been a member: role, status, 2FA/passkeys, cohorts, last seen. ' +
      'Pending sign-ups are under list_access_requests.',
    input: z.object({
      query: z.string().max(100).optional().describe('Match on name or e-mail.'),
      role: z.enum(roles).optional(),
      status: z.enum(['active', 'pending', 'inactive']).optional(),
      ...page,
    }),
    effect: 'read',
    run: async (args, ctx) => {
      const q = args.query?.trim().toLocaleLowerCase('nb')
      const accounts = (await listAccounts(ctx.db, ctx.viewer)).filter(
        (a) =>
          (!q || [a.fullName, a.email].some((v) => v.toLocaleLowerCase('nb').includes(q))) &&
          (!args.role || a.role === args.role) &&
          (!args.status || a.status === args.status),
      )
      return paginate(accounts, args)
    },
  })

  defineTool(server, ctx, {
    name: 'change_role',
    title: 'Change role',
    description:
      'Give or remove a role (member, moderator, admin, owner) for an active member with an account. Owners only. ' +
      'Nobody can change their own role, and there is always at least one owner. Admin roles need passkey or 2FA to work.',
    input: z.object({
      personId: id('The member'),
      role: z.enum(roles),
      reason: z.string().max(500).optional().describe('Stored in the audit log.'),
    }),
    effect: 'write',
    idempotent: true,
    run: async (args, ctx) => {
      await changeRole(ctx.db, ctx.viewer, args)
      return { personId: args.personId, role: args.role }
    },
  })

  defineTool(server, ctx, {
    name: 'set_member_access',
    title: 'Deactivate or reactivate member',
    description:
      'Deactivate (active=false) or reactivate a member. Deactivation signs them out everywhere, resets the role to ' +
      'member, revokes their MCP keys and connections and hides them from the directory. Only owners can change access for admins. Requires a reason.',
    input: z.object({ personId: id('The member'), active: z.boolean(), reason }),
    effect: 'destructive',
    run: async (args, ctx) => {
      await setMemberAccess(ctx.db, ctx.viewer, args)
      return { personId: args.personId, active: args.active }
    },
  })

  defineTool(server, ctx, {
    name: 'remove_passkeys',
    title: 'Remove passkeys',
    description:
      'Remove all passkeys of a member who has lost them, so they can add new ones after signing in with a password. ' +
      'Signs them out everywhere and revokes their MCP keys and connections. Requires a reason.',
    input: z.object({ personId: id('The member'), reason }),
    effect: 'destructive',
    run: async (args, ctx) => {
      await removePasskeys(ctx.db, ctx.viewer, args)
      return { personId: args.personId, passkeysRemoved: true }
    },
  })

  defineTool(server, ctx, {
    name: 'list_access_requests',
    title: 'List access requests',
    description:
      'Requests for access from people who signed up themselves (only possible with an e-mail provider). ' +
      'Shows what is actually verified: emailOnProfile=true means the verified address is on the chosen cohort-list profile.',
    input: z.object({ status: z.enum(['open', 'approved', 'rejected']).default('open') }),
    effect: 'read',
    run: ({ status }, ctx) => listAccessRequests(ctx.db, ctx.viewer, status),
  })

  defineTool(server, ctx, {
    name: 'decide_access_request',
    title: 'Approve or reject access request',
    description:
      'Approve (optionally linking the account to an unclaimed profile with profilePersonId) or reject an access request. ' +
      'Without strong evidence (emailOnProfile), verify the person first, e.g. by phone.',
    input: z.object({
      requestId: id('The request'),
      decision: z.enum(['approve', 'reject']),
      profilePersonId: z
        .uuid()
        .nullable()
        .optional()
        .describe('Unclaimed profile to link the account to.'),
    }),
    effect: 'write',
    run: async (args, ctx) => {
      await decideAccessRequest(ctx.db, ctx.viewer, args)
      return { requestId: args.requestId, decision: args.decision }
    },
  })

  defineTool(server, ctx, {
    name: 'describe_invite_target',
    title: 'Check an e-mail before inviting',
    description:
      'Which unclaimed profiles have this address, and whether an account already exists for it.',
    input: z.object({ email: z.string().max(254) }),
    effect: 'read',
    run: ({ email }, ctx) => describeInviteTarget(ctx.db, ctx.viewer, email),
  })

  defineTool(server, ctx, {
    name: 'list_invitations',
    title: 'List invitations',
    description:
      'Recent invitation and password links with status (pending, used, expired, revoked).',
    input: z.object({
      status: z.enum(['pending', 'used', 'expired', 'revoked']).optional(),
      kind: z.enum(['invite', 'password_reset']).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }),
    effect: 'read',
    run: async (args, ctx) =>
      (await listInvitations(ctx.db, ctx.viewer, { limit: 200 }))
        .filter(
          (i) => (!args.status || i.status === args.status) && (!args.kind || i.kind === args.kind),
        )
        .slice(0, args.limit),
  })

  defineTool(server, ctx, {
    name: 'create_invitation',
    title: 'Create invitation link',
    description:
      `Create a personal invitation link for an e-mail address, optionally linked to an unclaimed profile (personId). ` +
      `It works once, for that address only, for ${INVITATION_TTL_DAYS} days; a new link to the same address revokes the previous one. ` +
      'Only owners can invite with a role other than member. Check the address with describe_invite_target first. ' +
      'Remember the GDPR information duty: tell the person what ESAF has registered and where it came from.',
    input: z.object({
      email: z.string().max(254),
      personId: z
        .uuid()
        .nullable()
        .optional()
        .describe('Unclaimed profile the account is linked to.'),
      role: z.enum(roles).default('member'),
    }),
    effect: 'write',
    run: async (args, ctx) => {
      const link = await createInvitation(ctx.db, ctx.viewer, {
        email: args.email,
        personId: args.personId ?? null,
        role: args.role,
      })
      return {
        ...linkOf(ctx, link),
        profile: args.personId ? links.person(ctx, args.personId) : null,
      }
    },
  })

  defineTool(server, ctx, {
    name: 'revoke_invitation',
    title: 'Revoke link',
    description: 'Revoke a pending invitation or password link.',
    input: z.object({ invitationId: id('The link') }),
    effect: 'destructive',
    idempotent: true,
    run: async ({ invitationId }, ctx) => {
      await revokeInvitation(ctx.db, ctx.viewer, { id: invitationId })
      return { revoked: invitationId }
    },
  })

  defineTool(server, ctx, {
    name: 'create_password_reset_link',
    title: 'Create password link',
    description:
      'Create a one-time link for a member who forgot their password. It sets a new password and signs out all sessions, ' +
      'but 2FA still applies. Same rules as deactivation; never for yourself. Requires a reason.',
    input: z.object({ personId: id('The member'), reason }),
    effect: 'write',
    run: async (args, ctx) => linkOf(ctx, await createPasswordResetLink(ctx.db, ctx.viewer, args)),
  })
}
