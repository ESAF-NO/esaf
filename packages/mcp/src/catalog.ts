/**
 * Oversikten over hva admin-MCP-en kan, til adminsiden «MCP» i appen. Ingen
 * importer, så den kan brukes i nettleseren. En test sjekker at verktøyene og
 * oppskriftene her er nøyaktig de serveren har.
 */

export type McpToolGroup = {
  id: string
  title: string
  description: string
  tools: readonly string[]
}

export const MCP_TOOL_GROUPS: readonly McpToolGroup[] = [
  {
    id: 'people',
    title: 'Personer og profiler',
    description:
      'Legge inn et helt kull som profiler uten konto (med bilder fra en adresse), rette og berike profiler, kull og stillinger, slå sammen duplikater.',
    tools: [
      'list_people',
      'get_person',
      'create_profiles',
      'update_person',
      'add_experience',
      'remove_experience',
      'set_person_cohorts',
      'add_person_email',
      'remove_person_email',
      'set_profile_photo',
      'remove_profile_photo',
      'merge_people',
      'delete_profile',
    ],
  },
  {
    id: 'companies',
    title: 'Selskaper',
    description:
      'Opprette, rette og slå sammen selskaper, logoer, historikk (stiftet, investeringer, oppkjøp) og omtale i media.',
    tools: [
      'list_companies',
      'get_company',
      'create_company',
      'update_company',
      'delete_company',
      'merge_companies',
      'set_company_former_names',
      'set_company_logo',
      'remove_company_logo',
      'add_company_event',
      'update_company_event',
      'confirm_company_event',
      'delete_company_event',
      'add_company_article',
      'update_company_article',
      'delete_company_article',
    ],
  },
  {
    id: 'events',
    title: 'Kull og arrangementer',
    description:
      'Kullrepresentanter, arrangementstyper, arrangementer med deltakere og roller, og historikk fra gamle lister.',
    tools: [
      'list_cohorts',
      'get_cohort',
      'add_cohort_representative',
      'update_cohort_representative',
      'end_cohort_representative',
      'remove_cohort_representative',
      'list_event_types',
      'create_event_type',
      'update_event_type',
      'delete_event_type',
      'list_events',
      'get_event',
      'create_event',
      'update_event',
      'delete_event',
      'match_event_participants',
      'add_event_participants',
      'add_event_cohort',
      'update_event_participant',
      'remove_event_participant',
      'preview_event_history',
      'create_event_history',
    ],
  },
  {
    id: 'accounts',
    title: 'Kontoer og tilgang',
    description:
      'Roller, medlemskap, forespørsler om tilgang, invitasjoner og lenker for nytt passord. Lenkene gis bare til deg.',
    tools: [
      'list_accounts',
      'change_role',
      'set_member_access',
      'remove_passkeys',
      'list_access_requests',
      'decide_access_request',
      'describe_invite_target',
      'list_invitations',
      'create_invitation',
      'revoke_invitation',
      'create_password_reset_link',
    ],
  },
  {
    id: 'review',
    title: 'Gjennomgang og logg',
    description:
      'Oversikt, søk i alt, køen i Gjennomgang (usikre data, duplikater, forslag), kilder på felt og loggen.',
    tools: [
      'overview',
      'search',
      'list_review',
      'mark_sources_reviewed',
      'clear_imported_field',
      'dismiss_duplicate',
      'decide_suggestion',
      'decide_company_link',
      'add_field_sources',
      'list_audit_log',
    ],
  },
  {
    id: 'content',
    title: 'Sitater og innlegg',
    description: 'Sitater på profiler og selskaper, og moderering av innlegg og kommentarer.',
    tools: [
      'add_quote',
      'update_quote',
      'confirm_quote',
      'delete_quote',
      'list_posts',
      'get_post',
      'remove_post',
      'remove_comment',
      'set_post_pinned',
    ],
  },
  {
    id: 'badges',
    title: 'Merker',
    description:
      'Merker på profilene: lage og forhåndsvise regler, hele stiger (×1, ×3, ×5), publisere, og dele ut merker for hånd med begrunnelse.',
    tools: [
      'badge_options',
      'list_badges',
      'get_badge',
      'preview_badge',
      'create_badge',
      'create_badge_series',
      'update_badge',
      'set_badge_status',
      'delete_badge',
      'award_badge',
      'revoke_badge',
      'sync_badges',
    ],
  },
  {
    id: 'email',
    title: 'E-post',
    description:
      'Alle e-postene appen sender, med eksempler og når de sendes, tall for hva som er sendt og feilet, loggen over hvem som har fått hva, test til deg selv, og å sette all e-post på pause.',
    tools: [
      'email_templates',
      'email_preview',
      'email_stats',
      'list_sent_emails',
      'send_test_email',
      'set_email_paused',
    ],
  },
  {
    id: 'discovery',
    title: 'Søk og ES-universet',
    description:
      'Finne folk på hva de kan, skrive søkeord til personsøket, og ES-universet: et interaktivt kart over alle og selskapene deres.',
    tools: ['find_people', 'list_people_for_tagging', 'set_search_topics', 'show_universe'],
  },
]

export type McpRecipe = {
  name: string
  title: string
  description: string
  /** Slik kan man be om det i klienten. */
  example: string
}

/** Oppskriftene (MCP-prompts): ferdige arbeidsflyter klienten kan starte. */
export const MCP_RECIPES: readonly McpRecipe[] = [
  {
    name: 'onboard_cohort',
    title: 'Nytt kull',
    description:
      'Legger inn et helt kull fra en liste eller et regneark: viser en plan (ny, mulig duplikat, ugyldig) før noe lagres.',
    example: 'Legg inn ES 2026 fra dette regnearket, med bilder fra LinkedIn-lenkene.',
  },
  {
    name: 'enrich_person',
    title: 'Berik en person',
    description:
      'Finner offentlig, faglig informasjon på nettet og fyller inn profilen, alltid med kilde.',
    example: 'Berik profilen til Kari Nordmann fra ES 2019.',
  },
  {
    name: 'enrich_company',
    title: 'Berik et selskap',
    description: 'Beskrivelse, logo, historikk og omtale i media, med kilder.',
    example: 'Fyll ut alt vi mangler om Rakettverket.',
  },
  {
    name: 'tag_people',
    title: 'Søkeord til personsøket',
    description:
      'Skriver søkeord for dem som mangler eller har endret profilen siden sist, så de blir funnet på hva de kan.',
    example: 'Skriv søkeord for alle som trenger det.',
  },
  {
    name: 'design_badges',
    title: 'Lag merker',
    description:
      'Foreslår et sett med merker ut fra dataene, viser hvor mange som får hvert, og lager dem når du har godkjent.',
    example: 'Lag merker for ESAF-helgen og for gründere.',
  },
  {
    name: 'work_review_queue',
    title: 'Gå gjennom Gjennomgang',
    description:
      'Går gjennom usikre data, duplikater og forslag, og foreslår hva som skal gjøres i grupper du godkjenner.',
    example: 'Hjelp meg å rydde i Gjennomgang.',
  },
]

export const MCP_TOOL_COUNT = MCP_TOOL_GROUPS.reduce((n, g) => n + g.tools.length, 0)
