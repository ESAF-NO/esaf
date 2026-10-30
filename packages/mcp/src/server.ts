import {
  withApiTokenAudit,
  type Embedder,
  type ObjectStorage,
  type SearchAi,
  type Viewer,
} from '@esaf/core'
import type { Db } from '@esaf/db'
import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { ToolContext } from './context.ts'
import { fetchPublicImage, type ImageFetcher } from './images.ts'
import { registerAccountTools } from './tools/accounts.ts'
import { registerAdminTools } from './tools/admin.ts'
import { registerCompanyTools } from './tools/companies.ts'
import { registerContentTools } from './tools/content.ts'
import { registerDiscoveryTools } from './tools/discovery.ts'
import { registerCohortAndEventTools } from './tools/events.ts'
import { registerPeopleTools } from './tools/people.ts'

export const SERVER_NAME = 'esaf-admin'
export const SERVER_VERSION = '1.0.0'

/**
 * Det modellen får vite om ESAF og reglene før den bruker verktøyene. Engelsk,
 * fordi det er for modellen; tekst som havner i appen, skrives på norsk.
 */
export const instructions = `
ESAF admin MCP: manage the member app of ESAF (Entreprenørskolens Alumniforening), the independent alumni
association of NTNU's School of Entrepreneurship (Entreprenørskolen, "ES"). ESAF is run by alumni and is not part
of NTNU or the school. The app is at the appUrl returned by \`overview\`.

You act as the admin who created the MCP key, with exactly their current role and permissions. Every change is
checked by the same rules as the web app and written to the audit log, tagged with the key. Start with \`overview\`.

Data model:
- person: someone ESAF knows about. Without an account it is an unclaimed *profile* (from the cohort list, or created
  by an admin); with an account it is *claimed*. Membership status: active (shown to members), pending, inactive.
  Roles: member, moderator, admin, owner ("hovedadmin").
- cohort: identified by graduation year, as ES names them: "ES 2024" ran 2022–2024. A person can be student in one
  cohort and mentor/staff in another.
- company: unique slug from the name; renames and merges keep old slugs as aliases. Status active/acquired/closed/
  unknown. People are linked through experience (job title, years, founder) or as their ES company ("ES-selskap").
- events (ESAF-helgen etc.) with participants and roles; cohort representatives with terms; quotes; feed posts.
- field sources: where a field on a profile or company came from. Members see "Fra <source> · ikke bekreftet"
  until the person confirms. Confidence (high/medium/low) is only visible to admins.

Finding people: \`find_people\` searches on what people know and have done (jobs with what the companies do, bio,
topics), by words and by meaning, and says why each person matched. Use it for questions like "who knows about
space?". Search topics are written automatically from each profile when the server has Claude configured; admins can
override them with \`set_search_topics\` (see \`list_people_for_tagging\` and the \`tag_people\` prompt). \`show_universe\` shows an interactive map of everyone and their companies over time in
clients that support MCP Apps.

Rules that matter:
- Search before you create (\`search\`, \`list_people\`, \`list_companies\`). Merge duplicates instead of deleting.
- Bulk changes: \`create_profiles\` with dryRun=true first, show the admin the plan, then run it.
- Profiles never give anyone access. Only \`create_invitation\` does, and only when the admin asks for it.
  Invitation and password links are secrets: give them to the admin, never post them anywhere else.
- Contact details (e-mail, phone) belong to the person. You can set them when creating unclaimed profiles and fill
  empty ones on unclaimed profiles; you can never change them on a claimed profile.
- Destructive tools (delete, merge, deactivate) cannot be undone. Confirm with the admin first.

Researching and enriching people and companies (use your own web search/fetch tools):
- Only professional, public information relevant to an alumni network: current and past roles, companies founded,
  city, study background, a short professional bio, LinkedIn URL, a professional portrait, company facts, funding,
  awards, press coverage, quotes from interviews.
- Never store sensitive or private data: health, religion, politics, union membership, ethnicity, sexuality,
  private addresses, birth dates, national ID numbers, family, finances of private persons. ESAF has not been given
  this data by the people themselves (GDPR art. 14), so keep to what is needed.
- Make sure it is the right person (name + ES cohort/company/city must fit). If unsure, do not write it, or use
  confidence "low" so it lands in the review queue instead of being shown.
- Always attach sources (URL + honest confidence) to researched fields, history events, articles and quotes.
  Prefer primary sources: the company website, Brønnøysundregistrene / proff.no, entreprenorskolen.no, the person's
  own LinkedIn or website. News articles are "medium".
- Write text that ends up in the app (bio, tagline, description, event text) in Norwegian bokmål: short, factual,
  neutral, third person, no marketing language, no invented facts.
- Images: use a clear, recent, professional portrait of the right person, or the company's own logo (PNG/JPEG/WebP,
  not SVG). The server downloads it from the URL; only public URLs work.
`.trim()

export type AdminMcpOptions = {
  db: Db
  storage: ObjectStorage
  /** Den som står bak nøkkelen, fra `authenticateApiToken`. Må være aktivt medlem med `mcp.access`. */
  viewer: NonNullable<Viewer>
  /** Adressen til appen, for lenker, f.eks. `https://app.esaf.no`. */
  appUrl: string
  /** Henter bilder fra nettet. Byttes ut i tester. */
  fetchImage?: ImageFetcher
  /** Embedding-modellen for personsøket. */
  embedder?: Embedder | null
  /** Claude i personsøket. */
  ai?: SearchAi | null
}

/** En MCP-server med adminverktøyene, for én forespørsel og én innlogget admin. */
export function createAdminMcpServer(options: AdminMcpOptions): McpServer {
  const { viewer } = options
  const ctx: ToolContext = {
    db: viewer.apiToken ? withApiTokenAudit(options.db, viewer.apiToken.id) : options.db,
    storage: options.storage,
    viewer,
    fetchImage: options.fetchImage ?? fetchPublicImage,
    embedder: options.embedder ?? null,
    ai: options.ai ?? null,
    appUrl: options.appUrl.replace(/\/$/, ''),
  }
  const server = new McpServer(
    { name: SERVER_NAME, title: 'ESAF admin', version: SERVER_VERSION },
    {
      instructions: viewer.apiToken?.readOnly
        ? `${instructions}\n\nThis key is read-only: only tools that read are available.`
        : instructions,
    },
  )
  registerAdminTools(server, ctx)
  registerPeopleTools(server, ctx)
  registerCompanyTools(server, ctx)
  registerCohortAndEventTools(server, ctx)
  registerContentTools(server, ctx)
  registerAccountTools(server, ctx)
  registerDiscoveryTools(server, ctx)
  registerPrompts(server)
  return server
}

const prompt = (text: string) => ({
  messages: [{ role: 'user' as const, content: { type: 'text' as const, text: text.trim() } }],
})

function registerPrompts(server: McpServer) {
  server.registerPrompt(
    'onboard_cohort',
    {
      title: 'Add a new cohort',
      description:
        'Create unclaimed profiles for everyone in a new cohort, with photos and basic info.',
      argsSchema: z.object({
        graduationYear: z.string().describe('Graduation year, e.g. 2027 for ES 2027.'),
        source: z
          .string()
          .optional()
          .describe('Where the list of people comes from: pasted text, a URL, a file.'),
      }),
    },
    ({ graduationYear, source }) =>
      prompt(`
Add the new cohort ES ${graduationYear} (ran ${Number(graduationYear) - 2}–${graduationYear}) to ESAF as unclaimed profiles.
${source ? `The people are here: ${source}` : 'Ask me for the list of people (names, e-mails, phones, photos) if you do not have it.'}

1. Call overview, then get_cohort for ${graduationYear} to see who is already there.
2. Build one row per person for create_profiles: fullName, cohorts [{graduationYear: ${graduationYear}}], known e-mails,
   contactEmail/phone only if they shared them for the alumni list, studyBackground, linkedinUrl, photoUrl, and sources.
3. Run create_profiles with dryRun=true. Show me a short table of create / duplicate / invalid, with the matches.
4. After I confirm, run it with dryRun=false (allowDuplicates only for rows I say are different people).
5. Report what was created and any photo warnings. Do not send invitations unless I ask.
`),
  )

  server.registerPrompt(
    'enrich_person',
    {
      title: 'Research and enrich a person',
      description:
        'Find public professional information about a person and fill in their profile, with sources.',
      argsSchema: z.object({ person: z.string().describe('Name or personId.') }),
    },
    ({ person }) =>
      prompt(`
Research and enrich the ESAF profile of ${person}.

1. Find them with search or get_person. Note cohort, companies and what is missing.
2. Research public professional information (role, company, city, LinkedIn, short bio, portrait) with your web tools.
   Make sure it is the same person (cohort, ES company, city should fit). Follow the privacy rules in the server instructions.
3. Show me what you found, with sources, before writing. Then use update_person / add_experience / set_profile_photo
   with sources and honest confidence. Never overwrite something the person wrote themselves unless it is clearly outdated.
`),
  )

  server.registerPrompt(
    'enrich_company',
    {
      title: 'Research and enrich a company',
      description: 'Fill in company info, logo, history and press coverage, with sources.',
      argsSchema: z.object({ company: z.string().describe('Name, slug or companyId.') }),
    },
    ({ company }) =>
      prompt(`
Research and enrich the company ${company} in ESAF.

1. Find it with search, list_companies or get_company. Check for duplicates.
2. Research: website, what it does (tagline + short description in Norwegian), founded year, location, status
   (active/acquired/closed), industries, logo, key history events (founding, funding, awards, acquisition, closure)
   and press coverage. Prefer the company site, Brønnøysundregistrene/proff.no and reputable news.
3. Show me the findings with sources. Then use update_company (with sources), set_company_logo, add_company_event
   and add_company_article. Mark anything uncertain as confidence "low".
`),
  )

  server.registerPrompt(
    'tag_people',
    {
      title: 'Tag people with search topics',
      description: 'Write search topics for people, so they are found on what they know.',
      argsSchema: z.object({
        cohort: z.string().optional().describe('Only this cohort (graduation year), e.g. 2019.'),
      }),
    },
    ({ cohort }) =>
      prompt(`
Write search topics for ESAF profiles${cohort ? ` in ES ${cohort}` : ''}, so people are found on what they know.

1. Call list_people_for_tagging${cohort ? ` with cohort ${cohort}` : ''} (40 at a time, missingOnly=true).
2. For each person, read their text (jobs with what each company does, bio, study) and write 5–15 short topics,
   in BOTH Norwegian and English: the fields, industries, technologies and roles, plus broader concepts and synonyms
   the text does not spell out (NASA → romfart, space, aerospace, satellitter; salmon farming → oppdrett,
   aquaculture, havbruk, sjømat). Only what the text supports. Never health, religion, politics, family or other
   private matters, and nothing about hobbies unless it is clearly professional.
3. Save with set_search_topics (up to 200 people per call), then continue with the next page until done.
4. Finish with a few find_people checks (e.g. "space", "fintech") and report what you tagged.
`),
  )

  server.registerPrompt(
    'work_review_queue',
    {
      title: 'Work through the review queue',
      description: 'Go through uncertain data (Gjennomgang) and propose decisions.',
      argsSchema: z.object({}),
    },
    () =>
      prompt(`
Help me work through the ESAF review queue (Gjennomgang).

1. Call overview to see the counts, then list_review for each kind with items.
2. For each item, check the facts (get_person, get_company, the source URL) and propose: confirm, edit, clear, merge or dismiss.
3. Group your proposals so I can approve them in batches, then carry out what I approve.
`),
  )
}
