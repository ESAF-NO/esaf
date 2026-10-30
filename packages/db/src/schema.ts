import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

const timestamps = {
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}

// ---------------------------------------------------------------------------
// Innlogging (Better Auth). En `user` er bare en innloggingsidentitet og gir
// i seg selv ingen tilgang til medlemsdata. Se `membership` under.
// ---------------------------------------------------------------------------

export const user = pgTable('user', {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: boolean().notNull().default(false),
  image: text(),
  /**
   * Tofaktor med autentiseringsapp (Better Auths two-factor-plugin). Da krever
   * all innlogging med passord også koden, så alle øktene regnes som sterke.
   */
  twoFactorEnabled: boolean().notNull().default(false),
  ...timestamps,
})

export const session = pgTable(
  'session',
  {
    id: text().primaryKey(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    token: text().notNull().unique(),
    ipAddress: text(),
    userAgent: text(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /**
     * Økten ble startet med passkey. Settes bare av serveren ved innlogging
     * (se `auth-config.server.ts`) og kan aldri endres etterpå. Sammen med
     * tofaktor avgjør den om økten er sterk nok til adminrettigheter.
     */
    signedInWithPasskey: boolean().notNull().default(false),
    ...timestamps,
  },
  (t) => [index().on(t.userId)],
)

export const account = pgTable(
  'account',
  {
    id: text().primaryKey(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamp({ withTimezone: true }),
    refreshTokenExpiresAt: timestamp({ withTimezone: true }),
    scope: text(),
    password: text(),
    ...timestamps,
  },
  (t) => [index().on(t.userId)],
)

/** Hemmeligheten bak tofaktor og reservekodene, kryptert av Better Auth. */
export const twoFactor = pgTable(
  'two_factor',
  {
    id: text().primaryKey(),
    secret: text().notNull(),
    backupCodes: text().notNull(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Usann til første kode er bekreftet; først da er tofaktor slått på. */
    verified: boolean().notNull().default(true),
    failedVerificationCount: integer().notNull().default(0),
    /** Settes etter for mange feil koder på rad. */
    lockedUntil: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.secret), index().on(t.userId)],
)

/**
 * Passkeys (WebAuthn) fra Better Auths passkey-plugin. Bare den offentlige
 * nøkkelen lagres; den private blir aldri med ut av enheten eller
 * passordhåndtereren. Feltnavnene må være som pluginen forventer.
 */
export const passkey = pgTable(
  'passkey',
  {
    id: text().primaryKey(),
    /** Navnet personen selv har gitt den, eller passordhåndtereren den ligger i. */
    name: text(),
    publicKey: text().notNull(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    credentialID: text().notNull(),
    /** Signaturtelleren fra enheten, mot kopierte nøkler. Mange synkroniserte passkeys sender alltid 0. */
    counter: integer().notNull(),
    /** `multiDevice` (synkroniseres, f.eks. iCloud-nøkkelring) eller `singleDevice` (f.eks. sikkerhetsnøkkel). */
    deviceType: text().notNull(),
    backedUp: boolean().notNull(),
    transports: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow(),
    /** Hvilken type enhet eller passordhåndterer. Ofte nuller (ukjent). */
    aaguid: text(),
  },
  (t) => [index().on(t.userId), uniqueIndex().on(t.credentialID)],
)

export const verification = pgTable(
  'verification',
  {
    id: text().primaryKey(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [index().on(t.identifier)],
)

// ---------------------------------------------------------------------------
// ESAF-domenet
// ---------------------------------------------------------------------------

/**
 * Et kull er en egen enhet, ikke et årstall på personen: kullet har egne
 * egenskaper (årstall, senere navn, syretester, kontaktperson), en person kan
 * ha flere tilknytninger (f.eks. student i ett kull og mentor for et annet),
 * og import, invitasjon og oversikter skjer per kull.
 */
export const cohort = pgTable(
  'cohort',
  {
    id: uuid().primaryKey().defaultRandom(),
    /**
     * Året kullet blir uteksaminert. Slik navngir ES kullene sine: «ES 2024»
     * startet høsten 2022 og ble uteksaminert våren 2024.
     */
    graduationYear: integer().notNull().unique(),
    /** Valgfritt kallenavn kullet selv bruker. */
    name: text(),
    ...timestamps,
  },
  (t) => [check('cohort_graduation_year_range', sql`${t.graduationYear} between 1990 and 2100`)],
)

/** Hvor personen kom fra: registrering, import (kullisten) eller lagt inn av en admin. */
export const personSource = pgEnum('person_source', ['signup', 'import', 'admin'])

/**
 * En person ESAF kjenner til. En person uten `userId` er en *profil*: lagt inn
 * av ESAF (f.eks. fra kullisten), men ikke tatt i bruk av personen selv. Når
 * noen bekrefter en e-post som matcher, eller en admin kobler kontoen, blir
 * profilen gjort krav på (`userId` og `claimedAt` settes).
 */
export const person = pgTable(
  'person',
  {
    id: uuid().primaryKey().defaultRandom(),
    fullName: text().notNull(),
    userId: text().references(() => user.id, { onDelete: 'set null' }),
    /** Når personen selv tok i bruk profilen. Null for profiler uten konto. */
    claimedAt: timestamp({ withTimezone: true }),
    source: personSource().notNull().default('signup'),

    // Profil. Synlig for aktive medlemmer. Stilling og selskap ligger i `experience`.
    city: text(),
    /** Studieretning før Entreprenørskolen. */
    studyBackground: text(),
    /** Selskapet personen startet eller jobbet med på Entreprenørskolen (ES-teamet). */
    esCompanyId: uuid().references(() => company.id, { onDelete: 'restrict' }),
    bio: text(),
    /** Emner personen kan hjelpe andre med. */
    expertise: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Bransjer personen har jobbet i, nå eller tidligere. */
    industries: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    linkedinUrl: text(),
    /**
     * Søkeord til personsøket, satt av admins (ofte via MCP, der Claude leser
     * profilen og selskapene og skriver emner på norsk og engelsk, f.eks.
     * «romfart, space, satellitter» for noen som jobber i NASA). Vises ikke på
     * profilen, bare som grunn til et treff i søket. Se `people-search.ts`.
     */
    searchTopics: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /**
     * Profilbildet: en tilfeldig nøkkel til bildefilene i lagringen (se
     * `photos.ts` i @esaf/core). Hvert nytt bilde får ny nøkkel, så adressene
     * aldri endrer innhold og kan caches lenge. Null betyr initialer.
     */
    photoKey: text(),

    // Kontakt, stort sett fra kullisten som alumni fylte ut selv for å dele med
    // hverandre. Vises for aktive medlemmer som standard, også på profiler ingen
    // har tatt i bruk. `false` betyr at personen (eller en admin, for en profil
    // uten konto) har skjult feltet; da ser medlemmer at det er skjult, men ikke
    // verdien. Importene setter aldri synligheten, så et valg blir stående.
    contactEmail: text(),
    contactEmailVisible: boolean().notNull().default(true),
    phone: text(),
    phoneVisible: boolean().notNull().default(true),
    /** Når personen var gjennom (eller hoppet over) velkomststegene etter godkjenning. */
    onboardedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  // Bilderuten slår opp personen på nøkkelen ved hver forespørsel.
  (t) => [uniqueIndex().on(t.userId), uniqueIndex().on(t.photoKey), index().on(t.esCompanyId)],
)

/**
 * `unknown` er standard for selskaper fra import uten bevis for at de lever. Når
 * noen skriver inn et nytt selskap selv, settes `active` eksplisitt (se
 * `resolveCompanies` i @esaf/core).
 */
export const companyStatus = pgEnum('company_status', ['active', 'acquired', 'closed', 'unknown'])

/**
 * Et selskap ES-alumni har startet, jobber i eller har jobbet i. Erfaring og
 * ES-selskap peker hit, så samme selskap samles uansett skrivemåte, og info om
 * selskapet skrives én gang. Nye navn blir nye selskaper; et navn med samme slug
 * som et eksisterende selskap kobles til det.
 */
export const company = pgTable(
  'company',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** `companySlug(name)` fra @esaf/core, brukt i URL-en. Følger navnet ved navnebytte. */
    slug: text().notNull().unique(),
    name: text().notNull(),
    /**
     * Tidligere slugger (fra før et navnebytte) og sluggene til duplikater som er
     * slått sammen hit. Gamle lenker og gamle skrivemåter finner fram hit.
     */
    aliasSlugs: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Én linje om hva selskapet gjør. */
    tagline: text(),
    /** «Om selskapet». */
    description: text(),
    website: text(),
    foundedYear: integer(),
    location: text(),
    industries: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: companyStatus().notNull().default('unknown'),
    /**
     * Siste gang selskapet sto på entreprenorskolen.no (nettsiden eller arkivet).
     * Settes av importen og vises når statusen er ukjent.
     */
    lastSeenOnEsSite: date({ mode: 'string' }),
    /**
     * Logoen: en tilfeldig nøkkel til logofilene i lagringen (se `logos.ts` i
     * @esaf/core), som `person.photoKey`. Null betyr bokstavflis.
     */
    logoKey: text(),
    /**
     * Sist noen redigerte selskapsinfoen. Null betyr at selskapet bare er opprettet
     * fra et navn; da ryddes det bort når ingen lenger er knyttet til det.
     */
    editedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  // Logoruten slår opp selskapet på nøkkelen ved hver forespørsel.
  (t) => [
    uniqueIndex().on(t.logoKey),
    check(
      'company_founded_year_range',
      sql`${t.foundedYear} is null or ${t.foundedYear} between 1800 and 2100`,
    ),
  ],
)

/**
 * Hvor en person har jobbet eller hva de har bygget, nå og tidligere. Rader uten
 * `endYear` er nåværende; den nyeste av dem vises som stilling under navnet.
 */
export const experience = pgTable(
  'experience',
  {
    id: uuid().primaryKey().defaultRandom(),
    personId: uuid()
      .notNull()
      .references(() => person.id, { onDelete: 'cascade' }),
    companyId: uuid()
      .notNull()
      .references(() => company.id, { onDelete: 'restrict' }),
    title: text(),
    startYear: integer(),
    /** Null betyr at personen fortsatt er der. */
    endYear: integer(),
    /** Personen grunnla eller var med å grunnlegge selskapet. */
    founder: boolean().notNull().default(false),
    /** Rekkefølgen personen la dem inn i. Avgjør ved likt årstall. */
    position: integer().notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index().on(t.personId),
    index().on(t.companyId),
    check(
      'experience_years',
      sql`(${t.startYear} is null or ${t.startYear} between 1950 and 2100) and (${t.endYear} is null or ${t.endYear} between 1950 and 2100) and (${t.startYear} is null or ${t.endYear} is null or ${t.endYear} >= ${t.startYear})`,
    ),
  ],
)

/** Hvor sikker en kilde er. `low` vises bare for dem som kan rette det (se @esaf/core). */
export const sourceConfidence = pgEnum('source_confidence', ['high', 'medium', 'low'])

/** Hvor mye av datoen som er kjent: bare året, året og måneden, eller hele datoen. */
export const datePrecision = pgEnum('date_precision', ['year', 'month', 'day'])

export const companyEventType = pgEnum('company_event_type', [
  'founded',
  'funding',
  'award',
  'launch',
  'acquired',
  'bankrupt',
  'dissolved',
  'closed',
  'other',
])

/**
 * En hendelse i historien til et selskap: stiftet, kapital, priser, lanseringer,
 * oppkjøp, konkurs. Fra import (Brreg, nyhetssaker) eller lagt inn i appen.
 * `date` lagres som en hel dato; `datePrecision` sier hvor mye av den som vises
 * («2019», «juni 2019» eller «4. juni 2019»).
 */
export const companyEvent = pgTable(
  'company_event',
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: uuid()
      .notNull()
      .references(() => company.id, { onDelete: 'cascade' }),
    date: date({ mode: 'string' }).notNull(),
    datePrecision: datePrecision().notNull().default('day'),
    type: companyEventType().notNull(),
    text: text().notNull(),
    sourceUrl: text(),
    /** Kilden slik den vises, f.eks. «Brønnøysundregistrene» eller «tu.no». */
    sourceLabel: text(),
    /** Hendelser lagt inn eller bekreftet i appen er `high`. */
    confidence: sourceConfidence().notNull().default('high'),
    ...timestamps,
  },
  (t) => [index().on(t.companyId, t.date)],
)

/**
 * Et sitat fra en ES-er, fra entreprenorskolen.no eller en nyhetssak. Taleren er
 * en person ESAF kjenner (`personId`), og navnet slik kilden skriver det står
 * alltid i `speakerName`.
 * `confidence` gjelder hvem som sa det: sitater med usikker taler vises ikke for
 * vanlige medlemmer.
 */
export const quote = pgTable(
  'quote',
  {
    id: uuid().primaryKey().defaultRandom(),
    text: text().notNull(),
    personId: uuid().references(() => person.id, { onDelete: 'set null' }),
    companyId: uuid().references(() => company.id, { onDelete: 'set null' }),
    /**
     * Navnet slik kilden skriver det. Vises når taleren ikke er koblet til en
     * person, og blir stående om personen slettes.
     */
    speakerName: text().notNull(),
    /** Rollen slik kilden skriver den, f.eks. «Daglig leder i OptoScale». */
    speakerRole: text(),
    date: date({ mode: 'string' }),
    sourceUrl: text(),
    sourceLabel: text(),
    confidence: sourceConfidence().notNull().default('high'),
    ...timestamps,
  },
  (t) => [index().on(t.personId), index().on(t.companyId)],
)

/** Hvem som la inn en sak under «I media»: importen, noen knyttet til selskapet, eller en admin. */
export const companyArticleSource = pgEnum('company_article_source', ['import', 'member', 'admin'])

/**
 * En sak i media om et selskap (nyhetssak, intervju, portrett). Bare lenken,
 * tittelen, utgiveren og datoen lagres, aldri teksten i saken. `url` er
 * normalisert (se `normalizeArticleUrl` i @esaf/core), og samme sak står bare én
 * gang per selskap. `publishedAt` lagres som en hel dato; `publishedPrecision`
 * sier hvor mye av den som er kjent. Uten dato sorteres saken sist.
 */
export const companyArticle = pgTable(
  'company_article',
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: uuid()
      .notNull()
      .references(() => company.id, { onDelete: 'cascade' }),
    url: text().notNull(),
    title: text().notNull(),
    /** Avisen eller nettstedet, f.eks. «Adresseavisen». */
    publisher: text(),
    publishedAt: date({ mode: 'string' }),
    publishedPrecision: datePrecision().notNull().default('day'),
    /** Saken krever abonnement. */
    paywall: boolean().notNull().default(false),
    /** Saken nevner Entreprenørskolen. */
    mentionsEs: boolean().notNull().default(false),
    source: companyArticleSource().notNull(),
    /** Den som la inn saken, eller foreslo den. Null fra import. */
    addedByPersonId: uuid().references(() => person.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [uniqueIndex().on(t.companyId, t.url), index().on(t.companyId, t.publishedAt)],
)

export const fieldSourceEntity = pgEnum('field_source_entity', ['person', 'company'])

/**
 * Hvor et felt på en profil eller et selskap kom fra, for felt som er importert
 * (f.eks. bio fra entreprenorskolen.no). Ett felt kan ha flere kilder.
 * `confirmedAt` settes når eieren av profilen, eller noen som er knyttet til
 * selskapet, bekrefter eller skriver om feltet. Raden peker på personen eller
 * selskapet med `entityType` og `entityId`, uten fremmednøkkel; @esaf/core
 * flytter og sletter radene når selskaper slås sammen eller ryddes bort.
 */
export const fieldSource = pgTable(
  'field_source',
  {
    id: uuid().primaryKey().defaultRandom(),
    entityType: fieldSourceEntity().notNull(),
    entityId: uuid().notNull(),
    /** Feltet i appen, f.eks. `bio`, `linkedinUrl` eller `website`. */
    field: text().notNull(),
    /** Kilden slik den vises, f.eks. «entreprenorskolen.no» eller «kullisten». */
    sourceLabel: text().notNull(),
    /** Null når kilden ikke har en offentlig adresse (som kullisten). */
    sourceUrl: text(),
    fetchedAt: timestamp({ withTimezone: true }),
    confidence: sourceConfidence().notNull(),
    confirmedAt: timestamp({ withTimezone: true }),
    /**
     * Når en admin så over feltet under Gjennomgang og lot det stå. Er ikke en
     * bekreftelse fra eieren (`confirmedAt`), men tar feltet ut av køen. Hvem
     * som gjorde det, står i revisjonsloggen.
     */
    reviewedAt: timestamp({ withTimezone: true }),
    createdAt: timestamps.createdAt,
  },
  (t) => [uniqueIndex().on(t.entityType, t.entityId, t.field, t.sourceLabel)],
)

// ---------------------------------------------------------------------------
// Bidrag fra medlemmer: forslag til selskapsinfo og historikk, og tilknytninger
// til selskaper som den som er nevnt, må bekrefte. Reglene står i @esaf/core
// (contributions.ts).
// ---------------------------------------------------------------------------

/** Felles livsløp for forslag og tilknytninger. */
export const contributionStatus = pgEnum('contribution_status', [
  'pending',
  /** Godtatt av noen knyttet til selskapet eller en admin, eller bekreftet av personen. */
  'accepted',
  /** Avslått, eller personen sa at det ikke stemmer. */
  'rejected',
  /** Trukket tilbake av den som foreslo det. */
  'withdrawn',
])

/** `info`: endringer i selskapsinfoen. `event`: en ny hendelse i historikken. `article`: en sak i media. */
export const companySuggestionKind = pgEnum('company_suggestion_kind', ['info', 'event', 'article'])

/** Et felt i et forslag til selskapsinfo: verdien da forslaget ble laget, og den foreslåtte. */
export type SuggestedFieldChange = { from: unknown; to: unknown }

/**
 * Data i et forslag. For `info` bare feltene som endres; for `event` hele
 * hendelsen, i samme form som `companyEventInput` i @esaf/core; for `article`
 * saken, i samme form som `companyArticleInput`.
 */
export type CompanySuggestionChanges =
  | { kind: 'info'; fields: Record<string, SuggestedFieldChange> }
  | {
      kind: 'event'
      event: {
        year: number
        month: number | null
        day: number | null
        type: CompanyEventType
        text: string
        sourceUrl: string | null
        sourceLabel: string | null
      }
    }
  | {
      kind: 'article'
      article: {
        url: string
        title: string
        publisher: string | null
        year: number | null
        month: number | null
        day: number | null
        paywall: boolean
        mentionsEs: boolean
      }
    }

/**
 * Et forslag fra et medlem som ikke er knyttet til selskapet. De som kan
 * redigere selskapet (og admins), godtar eller avslår, og den som foreslo får
 * varsel. Endres ikke etter at det er behandlet.
 */
export const companySuggestion = pgTable(
  'company_suggestion',
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: uuid()
      .notNull()
      .references(() => company.id, { onDelete: 'cascade' }),
    suggestedByPersonId: uuid()
      .notNull()
      .references(() => person.id, { onDelete: 'cascade' }),
    kind: companySuggestionKind().notNull(),
    changes: jsonb().$type<CompanySuggestionChanges>().notNull(),
    /** Valgfri forklaring eller kilde fra den som foreslo. */
    note: text(),
    status: contributionStatus().notNull().default('pending'),
    decidedAt: timestamp({ withTimezone: true }),
    decidedByPersonId: uuid().references(() => person.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    index().on(t.companyId, t.status),
    index().on(t.suggestedByPersonId, t.status, t.createdAt),
  ],
)

/** Hva personen var i selskapet: gründer, ES-team eller ansatt (nå eller før). */
export const companyLinkRole = pgEnum('company_link_role', ['founder', 'es', 'employee'])

/**
 * Et medlem sier at en annen person var med i et selskap. Det vises ikke før
 * personen selv har bekreftet (eller en admin, for profiler ingen har tatt i
 * bruk). Ved bekreftelse blir det erfaring eller ES-selskap på profilen.
 */
export const companyLinkRequest = pgTable(
  'company_link_request',
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: uuid()
      .notNull()
      .references(() => company.id, { onDelete: 'cascade' }),
    /** Personen som er nevnt, og som må bekrefte. */
    personId: uuid()
      .notNull()
      .references(() => person.id, { onDelete: 'cascade' }),
    requestedByPersonId: uuid()
      .notNull()
      .references(() => person.id, { onDelete: 'cascade' }),
    role: companyLinkRole().notNull(),
    title: text(),
    startYear: integer(),
    /** Null betyr at personen fortsatt er der. Brukes ikke for ES-team. */
    endYear: integer(),
    status: contributionStatus().notNull().default('pending'),
    decidedAt: timestamp({ withTimezone: true }),
    decidedByPersonId: uuid().references(() => person.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    index().on(t.personId, t.status),
    index().on(t.requestedByPersonId, t.status, t.createdAt),
    index().on(t.companyId),
    // Samme person kan bare ha én åpen forespørsel per selskap og rolle.
    uniqueIndex('company_link_request_pending_index')
      .on(t.companyId, t.personId, t.role)
      .where(sql`${t.status} = 'pending'`),
    check(
      'company_link_request_years',
      sql`(${t.startYear} is null or ${t.startYear} between 1950 and 2100) and (${t.endYear} is null or ${t.endYear} between 1950 and 2100) and (${t.startYear} is null or ${t.endYear} is null or ${t.endYear} >= ${t.startYear})`,
    ),
  ],
)

export const reviewDismissalKind = pgEnum('review_dismissal_kind', [
  'company_duplicate',
  'person_duplicate',
])

/**
 * Mulige duplikater en admin har sett på og sagt at ikke er det samme. Paret
 * lagres med den minste id-en først, så det ikke foreslås igjen. Uten
 * fremmednøkkel, siden paret kan være selskaper eller personer; rader for noe
 * som er slettet eller slått sammen, gjør ingen skade.
 */
export const reviewDismissal = pgTable(
  'review_dismissal',
  {
    kind: reviewDismissalKind().notNull(),
    firstId: uuid().notNull(),
    secondId: uuid().notNull(),
    dismissedByPersonId: uuid().references(() => person.id, { onDelete: 'set null' }),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.kind, t.firstId, t.secondId] }),
    check('review_dismissal_order', sql`${t.firstId} < ${t.secondId}`),
  ],
)

export const emailSource = pgEnum('email_source', ['signup', 'import', 'admin'])

/**
 * Kjente e-postadresser for en person, fra registrering, kullister og andre
 * kilder. Brukes til å koble en konto til riktig profil: en bekreftet konto gjør
 * krav på profilen som har kontoens adresse. Vises aldri for andre medlemmer.
 */
export const personEmail = pgTable(
  'person_email',
  {
    /** Normalisert til små bokstaver. */
    email: text().primaryKey(),
    personId: uuid()
      .notNull()
      .references(() => person.id, { onDelete: 'cascade' }),
    source: emailSource().notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [index().on(t.personId)],
)

export const cohortRelation = pgEnum('cohort_relation', ['student', 'staff', 'mentor'])

export const personCohort = pgTable(
  'person_cohort',
  {
    personId: uuid()
      .notNull()
      .references(() => person.id, { onDelete: 'cascade' }),
    cohortId: uuid()
      .notNull()
      .references(() => cohort.id, { onDelete: 'restrict' }),
    relation: cohortRelation().notNull().default('student'),
    createdAt: timestamps.createdAt,
  },
  (t) => [primaryKey({ columns: [t.personId, t.cohortId] }), index().on(t.cohortId)],
)

/**
 * Kullrepresentantene: dem styret i ESAF snakker med, og som sender videre til
 * kullet sitt. Et kull kan ha flere samtidig, og vervet har en historikk. Uten
 * `endYear` er vervet nåværende. Reglene står i @esaf/core (cohort-reps.ts).
 */
export const cohortRepresentative = pgTable(
  'cohort_representative',
  {
    id: uuid().primaryKey().defaultRandom(),
    cohortId: uuid()
      .notNull()
      .references(() => cohort.id, { onDelete: 'cascade' }),
    personId: uuid()
      .notNull()
      .references(() => person.id, { onDelete: 'cascade' }),
    /** Null når det ikke er kjent når vervet startet (f.eks. fra en gammel liste). */
    startYear: integer(),
    /** Null betyr at personen fortsatt er kullrepresentant. */
    endYear: integer(),
    /** Notat fra styret, f.eks. «Valgt på kullsamlingen». Vises bare for admins. */
    note: text(),
    ...timestamps,
  },
  (t) => [
    index().on(t.cohortId),
    index().on(t.personId),
    // Samme person kan bare ha ett nåværende verv per kull.
    uniqueIndex('cohort_representative_current_index')
      .on(t.cohortId, t.personId)
      .where(sql`${t.endYear} is null`),
    check(
      'cohort_representative_years',
      sql`(${t.startYear} is null or ${t.startYear} between 1990 and 2100) and (${t.endYear} is null or ${t.endYear} between 1990 and 2100) and (${t.startYear} is null or ${t.endYear} is null or ${t.endYear} >= ${t.startYear})`,
    ),
  ],
)

/**
 * Typer arrangementer: ESAF-helgen (lagt inn av migreringen), og det admins
 * legger til, f.eks. «Generalforsamling» eller «Fagkveld». `slug` er adressen
 * (`/arrangementer/esaf-helgen`) og endres ikke etter at typen er laget, så
 * lenker fortsetter å virke.
 */
export const eventType = pgTable(
  'event_type',
  {
    id: uuid().primaryKey().defaultRandom(),
    slug: text().notNull().unique(),
    /** Entall, f.eks. «ESAF-helgen» eller «Fagkveld». */
    name: text().notNull(),
    /** Flertall, f.eks. «Fagkvelder». Null når navnet passer begge steder. */
    plural: text(),
    description: text(),
    /** Lavest først. ESAF-helgen har 0, så den står øverst. */
    sortOrder: integer().notNull().default(100),
    ...timestamps,
  },
  (t) => [check('event_type_slug', sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`)],
)

/**
 * Hvor godt datoen til et arrangement er kjent. Gamle arrangementer har ofte
 * bare et semester («Høst 2018») eller et årstall («2015»).
 */
export const eventDatePrecision = pgEnum('event_date_precision', ['day', 'semester', 'year'])

/**
 * Et arrangement, f.eks. «ESAF-helgen høst 2018». `endDate` er null for
 * arrangementer på én dag eller når sluttdatoen ikke er kjent. Med
 * `datePrecision` `semester` eller `year` er `startDate` første dag i perioden
 * (1. januar for vår og år, 1. juli for høst) og `endDate` alltid null. En type
 * med arrangementer kan ikke slettes.
 */
export const event = pgTable(
  'event',
  {
    id: uuid().primaryKey().defaultRandom(),
    typeId: uuid()
      .notNull()
      .references(() => eventType.id, { onDelete: 'restrict' }),
    name: text().notNull(),
    startDate: date({ mode: 'string' }).notNull(),
    endDate: date({ mode: 'string' }),
    datePrecision: eventDatePrecision().notNull().default('day'),
    location: text(),
    description: text(),
    ...timestamps,
  },
  (t) => [
    index().on(t.typeId, t.startDate),
    index().on(t.startDate),
    check('event_dates', sql`${t.endDate} is null or ${t.endDate} >= ${t.startDate}`),
    check(
      'event_date_precision',
      sql`${t.datePrecision} = 'day' or (${t.endDate} is null and extract(day from ${t.startDate}) = 1 and (extract(month from ${t.startDate}) = 1 or (${t.datePrecision} = 'semester' and extract(month from ${t.startDate}) = 7)))`,
    ),
  ],
)

/**
 * Rollen en person hadde på et arrangement. Null (eller `attended`) betyr at
 * personen deltok uten noen særskilt rolle; appen lagrer alltid null for det.
 */
export const participationRole = pgEnum('participation_role', [
  'attended',
  'organizer',
  'speaker',
  'volunteer',
])

/** Hvem som registrerte deltakelsen: personen selv, en admin, eller en import (liste eller regneark). */
export const participationSource = pgEnum('participation_source', ['self', 'admin', 'import'])

/** Hvem som var på et arrangement, og eventuelt i hvilken rolle. Én rad per person og arrangement. */
export const eventParticipation = pgTable(
  'event_participation',
  {
    eventId: uuid()
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    personId: uuid()
      .notNull()
      .references(() => person.id, { onDelete: 'cascade' }),
    role: participationRole(),
    source: participationSource().notNull(),
    /** Notat fra styret. Vises bare for admins. */
    note: text(),
    createdAt: timestamps.createdAt,
  },
  (t) => [primaryKey({ columns: [t.eventId, t.personId] }), index().on(t.personId)],
)

export const membershipStatus = pgEnum('membership_status', ['pending', 'active', 'inactive'])
/**
 * Roller fra minst til mest. Hva hver rolle får gjøre, står i `permissions` i
 * `@esaf/core` (access.ts). `owner` vises som «hovedadmin» og er den eneste som
 * kan gi og fjerne roller.
 */
export const memberRole = pgEnum('member_role', ['member', 'moderator', 'admin', 'owner'])

/**
 * Medlemskap i ESAF er en ESAF-beslutning, ikke en konsekvens av å ha en konto.
 * Kun `status = 'active'` gir medlemsinnsyn. `role = 'admin'` gir adminhandlinger
 * og settes aldri via offentlig registrering.
 */
export const membership = pgTable('membership', {
  personId: uuid()
    .primaryKey()
    .references(() => person.id, { onDelete: 'cascade' }),
  status: membershipStatus().notNull().default('pending'),
  role: memberRole().notNull().default('member'),
  decidedAt: timestamp({ withTimezone: true }),
  /** Null betyr at avgjørelsen ble tatt av en lokal operatør (admin-CLI). */
  decidedByPersonId: uuid().references(() => person.id, { onDelete: 'set null' }),
  ...timestamps,
})

export const accessRequestStatus = pgEnum('access_request_status', ['open', 'approved', 'rejected'])

/**
 * En forespørsel om tilgang fra en konto med bekreftet e-post. Ingen får
 * medlemsinnsyn uten at en admin har godkjent forespørselen, heller ikke de som
 * står i kullisten: å kjenne en adresse fra lista er ikke nok, og selv en
 * bekreftet adresse er bare et sterkt tegn som en admin vurderer.
 */
export const accessRequest = pgTable(
  'access_request',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: text()
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: 'cascade' }),
    /**
     * Profilen fra kullisten personen sier er dem. Kan bare være en profil med
     * kontoens egen e-postadresse. Null betyr «fant meg ikke i lista».
     */
    profilePersonId: uuid().references(() => person.id, { onDelete: 'set null' }),
    fullName: text().notNull(),
    /** Kullet personen oppgir, som uteksamineringsår. */
    graduationYear: integer(),
    linkedinUrl: text(),
    note: text(),
    status: accessRequestStatus().notNull().default('open'),
    decidedAt: timestamp({ withTimezone: true }),
    decidedByPersonId: uuid().references(() => person.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [index().on(t.status, t.createdAt)],
)

/**
 * `invite` gir tilgang til appen. `password_reset` lar en eksisterende konto
 * velge nytt passord, uten e-post.
 */
export const invitationKind = pgEnum('invitation_kind', ['invite', 'password_reset'])

/**
 * Lenker en admin (eller en operatør på kommandolinjen) lager og deler selv, for
 * eksempel på SMS. Bare SHA-256 av tokenet lagres; selve tokenet vises én gang
 * når lenken lages. En lenke er bundet til én e-postadresse, virker én gang og
 * går ut etter sju dager. Se `invitations.ts` i @esaf/core for reglene.
 */
export const invitation = pgTable(
  'invitation',
  {
    id: uuid().primaryKey().defaultRandom(),
    kind: invitationKind().notNull().default('invite'),
    /** Normalisert til små bokstaver. Kontoen som lages eller brukes, må ha denne adressen. */
    email: text().notNull(),
    /** SHA-256 (hex) av tokenet i lenken. Tokenet selv lagres aldri. */
    tokenHash: text().notNull().unique(),
    /**
     * Invitasjon: profilen kontoen skal kobles til, eller null for en ny person.
     * Nytt passord: personen bak kontoen.
     */
    personId: uuid().references(() => person.id, { onDelete: 'set null' }),
    /** Rollen den inviterte får. Bare hovedadmins kan invitere med en annen rolle enn medlem. */
    role: memberRole().notNull().default('member'),
    /** Null betyr lokal operatør (admin-CLI). */
    createdByPersonId: uuid().references(() => person.id, { onDelete: 'set null' }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    usedAt: timestamp({ withTimezone: true }),
    usedByUserId: text().references(() => user.id, { onDelete: 'set null' }),
    revokedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [index().on(t.email), index().on(t.createdAt)],
)

/**
 * MCP-nøkler: personlige nøkler en admin lager under «Konto og sikkerhet» for å
 * koble en MCP-klient (f.eks. Claude) til adminverktøyene. Som invitasjoner
 * lagres bare SHA-256 av nøkkelen; selve nøkkelen vises én gang. En nøkkel gir
 * aldri mer enn kontoen har akkurat nå: rollen og medlemskapet sjekkes ved hver
 * forespørsel. Se `api-tokens.ts` i @esaf/core for reglene.
 */
export const apiToken = pgTable(
  'api_token',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Navnet personen ga nøkkelen, f.eks. «Claude Code på laptopen». */
    name: text().notNull(),
    /** SHA-256 (hex) av nøkkelen. Nøkkelen selv lagres aldri. */
    tokenHash: text().notNull().unique(),
    /** De første tegnene av nøkkelen, så den kan kjennes igjen i oversikten. */
    prefix: text().notNull(),
    /** Bare lesing: verktøyene som endrer noe, finnes ikke for denne nøkkelen. */
    readOnly: boolean().notNull().default(false),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    /** Oppdateres høyst én gang i minuttet. */
    lastUsedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: timestamps.createdAt,
  },
  (t) => [index().on(t.userId)],
)

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' })

/**
 * Indeksen for personsøket: teksten om personen delt i biter (stillinger med
 * selskapet, bio, emner) og en vektor per bit fra embedding-modellen. Bare felt
 * medlemmer kan se, aldri kontaktinfo. `contentHash` sier om bitene er
 * utdaterte; indeksen bygges på nytt i bakgrunnen når noe endres. Se
 * `people-search.ts` i @esaf/core.
 */
export const personSearchIndex = pgTable('person_search_index', {
  personId: uuid()
    .primaryKey()
    .references(() => person.id, { onDelete: 'cascade' }),
  /** SHA-256 av bitene og modellen. */
  contentHash: text().notNull(),
  /** Modellen vektorene kom fra; ny modell betyr ny indeks. */
  model: text().notNull(),
  /** Bitene i samme rekkefølge som vektorene. */
  chunks: jsonb().$type<{ kind: string; text: string }[]>().notNull(),
  /** Vektorene som float32 (little-endian), bit etter bit. */
  vectors: bytea().notNull(),
  dims: integer().notNull(),
  indexedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})

/**
 * Søkeord skrevet av Claude fra det som står på profilen (se `search-ai.ts` i
 * @esaf/core). Holdes adskilt fra `person.search_topics`, som admins setter: har
 * en person søkeord fra en admin, brukes de i stedet for disse.
 */
export const personAiTopics = pgTable('person_ai_topics', {
  personId: uuid()
    .primaryKey()
    .references(() => person.id, { onDelete: 'cascade' }),
  topics: text()
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  /** SHA-256 av teksten søkeordene ble skrevet fra; ny tekst betyr nye søkeord. */
  sourceHash: text().notNull(),
  model: text().notNull(),
  generatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})

/** Hva i et datasett en rad i `import_record` gjelder. */
export const importRecordKind = pgEnum('import_record_kind', [
  'company',
  /** Et felt på et selskap, `<nøkkel>|<felt>`: importen har fylt det eller kjent det igjen. */
  'company_field',
  'company_logo',
  'company_event',
  'company_article',
  'person',
  /** Et felt på en profil, `<nøkkel>|<felt>`. */
  'person_field',
  'person_photo',
  'quote',
])

/**
 * Hva `pnpm data:import` allerede har tatt inn. Gjør importen idempotent også når
 * noen har rettet eller slettet det som ble importert: en hendelse, sak, sitat,
 * logo eller et bilde som er tatt inn én gang, tas aldri inn igjen, et selskap
 * eller en person som er slettet i appen, lages ikke på nytt, og et felt
 * importen har fylt, oppdateres bare så lenge ingen har rørt det. `keyHash` er
 * SHA-256 av nøkkelen i datasettet, så navn ikke står i klartekst; `entityId` er
 * raden importen laget eller kjente igjen, uten fremmednøkkel.
 */
export const importRecord = pgTable(
  'import_record',
  {
    kind: importRecordKind().notNull(),
    keyHash: text().notNull(),
    entityId: uuid(),
    createdAt: timestamps.createdAt,
  },
  (t) => [primaryKey({ columns: [t.kind, t.keyHash] })],
)

/** Revisjonslogg for tilgangsendringer. Skrives aldri over. */
export const auditEvent = pgTable(
  'audit_event',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Null betyr lokal operatør (admin-CLI), ikke en innlogget person. */
    actorPersonId: uuid().references(() => person.id, { onDelete: 'set null' }),
    action: text().notNull(),
    subjectPersonId: uuid().references(() => person.id, { onDelete: 'set null' }),
    details: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /**
     * MCP-nøkkelen handlingen ble gjort med, ellers null (appen eller CLI-en).
     * Settes av databasen fra `esaf.api_token_id`, som @esaf/core setter i hver
     * transaksjon for forespørsler med nøkkel (`withApiTokenAudit`). Da kan ingen
     * hendelse fra MCP havne i loggen uten merket, uansett hvor den skrives.
     */
    apiTokenId: uuid()
      .references(() => apiToken.id, { onDelete: 'set null' })
      .default(sql`nullif(current_setting('esaf.api_token_id', true), '')::uuid`),
    createdAt: timestamps.createdAt,
  },
  (t) => [index().on(t.subjectPersonId)],
)

export type MembershipStatus = (typeof membershipStatus.enumValues)[number]
export type MemberRole = (typeof memberRole.enumValues)[number]
export type CohortRelation = (typeof cohortRelation.enumValues)[number]
export type PersonSource = (typeof personSource.enumValues)[number]
export type AccessRequestStatus = (typeof accessRequestStatus.enumValues)[number]
export type InvitationKind = (typeof invitationKind.enumValues)[number]
export type CompanyStatus = (typeof companyStatus.enumValues)[number]
export type SourceConfidence = (typeof sourceConfidence.enumValues)[number]
export type DatePrecision = (typeof datePrecision.enumValues)[number]
export type CompanyEventType = (typeof companyEventType.enumValues)[number]
export type FieldSourceEntity = (typeof fieldSourceEntity.enumValues)[number]
export type ContributionStatus = (typeof contributionStatus.enumValues)[number]
export type CompanySuggestionKind = (typeof companySuggestionKind.enumValues)[number]
export type CompanyLinkRole = (typeof companyLinkRole.enumValues)[number]
export type CompanyArticleSource = (typeof companyArticleSource.enumValues)[number]
export type ImportRecordKind = (typeof importRecordKind.enumValues)[number]
export type ReviewDismissalKind = (typeof reviewDismissalKind.enumValues)[number]
export type ParticipationRole = (typeof participationRole.enumValues)[number]
export type EventDatePrecision = (typeof eventDatePrecision.enumValues)[number]
export type ParticipationSource = (typeof participationSource.enumValues)[number]

// ---------------------------------------------------------------------------
// Fellesskap: innlegg, kommentarer og stemmer (Bookface-forum)
// ---------------------------------------------------------------------------

export const postChannel = pgEnum('post_channel', [
  'generelt',
  'sporsmal',
  'intro',
  'lansering',
  'jobb',
  'arrangement',
])

export const post = pgTable(
  'post',
  {
    id: uuid().primaryKey().defaultRandom(),
    authorPersonId: uuid()
      .notNull()
      .references(() => person.id, { onDelete: 'cascade' }),
    channel: postChannel().notNull().default('generelt'),
    title: text().notNull(),
    body: text().notNull().default(''),
    /** Valgfri lenke, f.eks. til en lansering eller stillingsannonse. */
    url: text(),
    /** Satt når forfatteren har redigert innlegget. */
    editedAt: timestamp({ withTimezone: true }),
    /**
     * Satt når en moderator har festet innlegget. Festede innlegg står øverst i
     * «Hjem» og i kanalen sin. Hvem som festet, står i revisjonsloggen.
     */
    pinnedAt: timestamp({ withTimezone: true }),
    /** Myk sletting: innholdet skjules, men kommentarene består. */
    deletedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [index().on(t.channel, t.createdAt), index().on(t.authorPersonId)],
)

export const comment = pgTable(
  'comment',
  {
    id: uuid().primaryKey().defaultRandom(),
    postId: uuid()
      .notNull()
      .references(() => post.id, { onDelete: 'cascade' }),
    authorPersonId: uuid()
      .notNull()
      .references(() => person.id, { onDelete: 'cascade' }),
    body: text().notNull(),
    /** Satt når forfatteren har redigert kommentaren. */
    editedAt: timestamp({ withTimezone: true }),
    deletedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [index().on(t.postId, t.createdAt)],
)

export const postVote = pgTable(
  'post_vote',
  {
    postId: uuid()
      .notNull()
      .references(() => post.id, { onDelete: 'cascade' }),
    personId: uuid()
      .notNull()
      .references(() => person.id, { onDelete: 'cascade' }),
    createdAt: timestamps.createdAt,
  },
  (t) => [primaryKey({ columns: [t.postId, t.personId] })],
)

export type PostChannel = (typeof postChannel.enumValues)[number]

// ---------------------------------------------------------------------------
// Varsler: kommentarer, omtaler (@navn) og nye medlemmer
// ---------------------------------------------------------------------------

export const notificationType = pgEnum('notification_type', [
  /** Noen kommenterte et innlegg mottakeren skrev. */
  'comment_on_post',
  /** Noen kommenterte et innlegg mottakeren selv har kommentert. */
  'comment_on_thread',
  /** Noen nevnte mottakeren i et innlegg eller en kommentar. */
  'mention',
  /** Forespørselen om tilgang ble godkjent. */
  'welcome',
  /** Noen fra mottakerens kull ble godkjent som medlem. */
  'cohort_joined',
  /** Noen foreslo en endring i et selskap mottakeren er knyttet til. */
  'company_suggestion',
  /** Forslaget mottakeren sendte, ble godtatt. */
  'suggestion_accepted',
  /** Forslaget mottakeren sendte, ble avslått. */
  'suggestion_rejected',
  /** Noen sier at mottakeren var med i et selskap; mottakeren må bekrefte. */
  'company_link_request',
  /** Personen mottakeren la til i et selskap, bekreftet det. */
  'company_link_confirmed',
])

export type NotificationPayload = {
  /** Kullet varselet gjelder, for velkomst og nye fra kullet. */
  graduationYear?: number
  /** Forslaget varselet gjelder. */
  suggestionId?: string
  /** Hva forslaget gjaldt: selskapsinfo eller en hendelse. */
  suggestionKind?: CompanySuggestionKind
  /** Tilknytningen varselet gjelder. */
  linkRequestId?: string
  linkRole?: CompanyLinkRole
}

/**
 * Et varsel til ett medlem. Innlegg og kommentarer hentes ved visning, så
 * varselet viser gjeldende tittel og skjules når innholdet er slettet. Bare
 * aktive medlemmer med egen konto får varsler.
 */
export const notification = pgTable(
  'notification',
  {
    id: uuid().primaryKey().defaultRandom(),
    recipientPersonId: uuid()
      .notNull()
      .references(() => person.id, { onDelete: 'cascade' }),
    type: notificationType().notNull(),
    /** Den som utløste varselet. Null for varsler fra ESAF selv, som velkomsten. */
    actorPersonId: uuid().references(() => person.id, { onDelete: 'cascade' }),
    postId: uuid().references(() => post.id, { onDelete: 'cascade' }),
    commentId: uuid().references(() => comment.id, { onDelete: 'cascade' }),
    /** Selskapet varselet gjelder, for forslag og tilknytninger. Navnet hentes ved visning. */
    companyId: uuid().references(() => company.id, { onDelete: 'cascade' }),
    /**
     * Hendelsen varselet gjelder, for eksempel `comment:<id>`. Unik per mottaker:
     * én hendelse gir aldri mer enn ett varsel til samme person, heller ikke når
     * en kommentar både svarer på innlegget ditt og nevner deg.
     */
    eventKey: text().notNull(),
    payload: jsonb().$type<NotificationPayload>().notNull().default({}),
    readAt: timestamp({ withTimezone: true }),
    /** Når varselet ble sendt i en e-postoppsummering. Null til det er sendt. */
    emailedAt: timestamp({ withTimezone: true }),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    uniqueIndex().on(t.recipientPersonId, t.eventKey),
    index().on(t.recipientPersonId, t.createdAt),
    index().on(t.companyId),
    // Antall uleste hentes ved hver navigering, så de har sin egen lille indeks.
    index('notification_unread_index')
      .on(t.recipientPersonId, t.createdAt)
      .where(sql`${t.readAt} is null`),
  ],
)

export type NotificationType = (typeof notificationType.enumValues)[number]
