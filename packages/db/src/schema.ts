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
  type AnyPgColumn,
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
     * SHA-256 av profilteksten søkeordene ble skrevet fra. Null: aldri vurdert.
     * Er teksten endret siden, er søkeordene kanskje utdaterte og personen
     * står i lista over dem som trenger nye (`listPeopleForTopics`).
     */
    searchTopicsSource: text(),
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
    /**
     * Navn selskapet hadde før, nyeste først («Tidligere Bølgepost»). Fylles ved
     * navnebytte, når et duplikat slås sammen som et tidligere navn, og for hånd.
     */
    formerNames: text()
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
    /**
     * Flere kilder for samme hendelse, når like hendelser fra flere saker er slått
     * sammen til én (Gjennomgang → «Slå sammen like og godta alle»).
     */
    moreSources: jsonb()
      .$type<{ url: string | null; label: string | null }[]>()
      .notNull()
      .default([]),
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
    /**
     * Skiller kilder med samme navn. Tom for enkeltfelt (én kilde per navn, en ny
     * lenke erstatter den gamle); lenken for lister som erfaring, der samme kilde
     * kan dekke flere oppføringer (Brønnøysundregistrene for to selskaper).
     */
    sourceKey: text().notNull().default(''),
    createdAt: timestamps.createdAt,
  },
  (t) => [uniqueIndex().on(t.entityType, t.entityId, t.field, t.sourceLabel, t.sourceKey)],
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
 * Rollen i styret. `member` er et vanlig styremedlem, og er standard: styret
 * fordeler gjerne rollene internt etter generalforsamlingen.
 */
export const boardRole = pgEnum('board_role', ['chair', 'vice_chair', 'member', 'deputy'])

/**
 * Styret i ESAF, med historikk. Én rad er ett verv: en person i en rolle fra
 * `startYear` til `endYear`. Uten `endYear` sitter personen i styret nå. Bytter
 * noen rolle, avsluttes det gamle vervet og et nytt startes, så historikken
 * står. Reglene står i @esaf/core (board.ts).
 */
export const boardMember = pgTable(
  'board_member',
  {
    id: uuid().primaryKey().defaultRandom(),
    personId: uuid()
      .notNull()
      .references(() => person.id, { onDelete: 'cascade' }),
    role: boardRole().notNull().default('member'),
    /** Ansvarsområde, f.eks. «Økonomi» eller «Arrangementer». Vises for medlemmer. */
    responsibility: text(),
    /** Null når det ikke er kjent når vervet startet (f.eks. fra en gammel liste). */
    startYear: integer(),
    /** Null betyr at personen sitter i styret nå. */
    endYear: integer(),
    /** Notat fra styret, f.eks. «Valgt for to år». Vises bare for admins. */
    note: text(),
    ...timestamps,
  },
  (t) => [
    index().on(t.personId),
    // Samme person sitter bare én gang i styret om gangen.
    uniqueIndex('board_member_current_index')
      .on(t.personId)
      .where(sql`${t.endYear} is null`),
    // Styret har én leder og én nestleder om gangen.
    uniqueIndex('board_member_current_lead_index')
      .on(t.role)
      .where(sql`${t.endYear} is null and ${t.role} in ('chair', 'vice_chair')`),
    check(
      'board_member_years',
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

/**
 * Et merke er utkast mens admins lager det, publisert når det deles ut og vises,
 * og arkivert når det ikke lenger brukes. Arkiverte merker vises ikke, men
 * hvem som hadde dem, blir stående.
 */
export const badgeStatus = pgEnum('badge_status', ['draft', 'published', 'archived'])

/**
 * Merker (achievements) admins lager: «ESAF-helgen ×5», «Grunnla selskap på ES»,
 * «Mentor». Hvem som får et merke, avgjøres av regelen, som leser dataene som
 * allerede finnes (arrangementer, kull, styret, selskaper, profilen), eller en
 * admin deler det ut for hånd. Regelen valideres og forklares i @esaf/core
 * (badges.ts); her lagres den som JSON.
 */
export const badge = pgTable(
  'badge',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Adressen (`/merker/<slug>`), fra navnet. Endres ikke, så lenker virker. */
    slug: text().notNull().unique(),
    name: text().notNull(),
    /** Hva som skal til, slik medlemmene ser det: «Vært på fem ESAF-helger». */
    description: text().notNull(),
    /** Et ikon fra listen i @esaf/core (`badgeIcons`). */
    icon: text().notNull(),
    /** En farge fra listen i @esaf/core (`badgeColors`). */
    color: text().notNull(),
    rule: jsonb().$type<Record<string, unknown>>().notNull(),
    status: badgeStatus().notNull().default('draft'),
    /**
     * Merker i samme serie er trinn på samme stige (×1, ×3, ×5). Profilen viser
     * bare det høyeste trinnet personen har nådd: det sist i rekkefølgen.
     */
    series: text(),
    /** Lavest først. */
    sortOrder: integer().notNull().default(100),
    publishedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [check('badge_slug', sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`)],
)

/** Fra regelen, regnet ut av serveren, eller delt ut av en admin. */
export const badgeAwardSource = pgEnum('badge_award_source', ['rule', 'manual'])

/**
 * Hvem som har et merke. Merker med regel holdes oppdatert av serveren
 * (`syncBadges`): rader legges til og fjernes når dataene endres. Merker som
 * deles ut for hånd, endres bare av admins.
 */
export const badgeAward = pgTable(
  'badge_award',
  {
    badgeId: uuid()
      .notNull()
      .references(() => badge.id, { onDelete: 'cascade' }),
    personId: uuid()
      .notNull()
      .references(() => person.id, { onDelete: 'cascade' }),
    source: badgeAwardSource().notNull(),
    /**
     * Når merket ble fortjent, når dataene sier det: datoen for arrangementet
     * som gjorde at regelen slo til. Null når det ikke er kjent.
     */
    achievedOn: date({ mode: 'string' }),
    /** Hvorfor, for merker delt ut for hånd: «For innsatsen med ESAF-helgen 2024». Vises for medlemmer. */
    citation: text(),
    awardedByPersonId: uuid().references(() => person.id, { onDelete: 'set null' }),
    /** Personen har skjult merket fra profilen og listene. */
    hidden: boolean().notNull().default(false),
    createdAt: timestamps.createdAt,
  },
  (t) => [primaryKey({ columns: [t.badgeId, t.personId] }), index().on(t.personId)],
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
 * velge nytt passord.
 */
export const invitationKind = pgEnum('invitation_kind', ['invite', 'password_reset'])

/**
 * Lenker en admin (eller en operatør på kommandolinjen) lager, og som sendes på
 * e-post eller deles for eksempel på SMS, og lenker for nytt passord personen
 * ber om selv («Glemt passord?»). Bare SHA-256 av tokenet lagres; selve tokenet
 * vises eller sendes én gang når lenken lages. En lenke er bundet til én
 * e-postadresse, virker én gang og går ut etter sju dager (en time når personen
 * ba om den selv). Se `invitations.ts` i @esaf/core for reglene.
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
    /**
     * Null betyr lokal operatør (admin-CLI), eller at personen ba om lenken selv
     * og ikke har noen person ennå (se `requestedBySelf`).
     */
    createdByPersonId: uuid().references(() => person.id, { onDelete: 'set null' }),
    /** Personen ba om lenken for nytt passord selv, fra «Glemt passord?». Da er `createdByPersonId` dem selv. */
    requestedBySelf: boolean().notNull().default(false),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    usedAt: timestamp({ withTimezone: true }),
    usedByUserId: text().references(() => user.id, { onDelete: 'set null' }),
    revokedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [index().on(t.email), index().on(t.createdAt)],
)

/**
 * MCP-nøkler: personlige nøkler en admin lager på adminsiden «MCP» for å
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

// ---------------------------------------------------------------------------
// OAuth for MCP-klienter (Better Auths oauth-provider-plugin)
// ---------------------------------------------------------------------------
//
// Appen er sin egen OAuth-server, så MCP-klienter (Claude, ChatGPT, Codex) kan
// kobles til adminverktøyene med vanlig innlogging i nettleseren i stedet for en
// nøkkel. Tabellene og feltene er pluginens; navnene må stemme med den. Tilgangs-
// og fornyelsesnøkler er ugjennomsiktige og lagres bare som SHA-256, så de kan
// trekkes tilbake med en gang. Se `auth-config.server.ts` i appen og
// `oauth-mcp.ts` i @esaf/core for reglene.

/** En MCP-klient, som regel registrert av klienten selv (RFC 7591). */
export const oauthClient = pgTable(
  'oauth_client',
  {
    id: text().primaryKey(),
    clientId: text().notNull().unique(),
    clientSecret: text(),
    clientDiscoveryId: text(),
    disabled: boolean().default(false),
    skipConsent: boolean(),
    enableEndSession: boolean(),
    subjectType: text(),
    scopes: text().array(),
    clientCredentialsScopes: text().array().default([]),
    userId: text().references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp({ withTimezone: true }),
    updatedAt: timestamp({ withTimezone: true }),
    /** Navnet klienten oppgir selv, f.eks. «Claude Code». Ikke bekreftet av noen. */
    name: text(),
    uri: text(),
    icon: text(),
    contacts: text().array(),
    tos: text(),
    policy: text(),
    softwareId: text(),
    softwareVersion: text(),
    softwareStatement: text(),
    redirectUris: text().array().notNull(),
    postLogoutRedirectUris: text().array(),
    backchannelLogoutUri: text(),
    backchannelLogoutSessionRequired: boolean(),
    tokenEndpointAuthMethod: text(),
    applicationType: text(),
    jwks: text(),
    jwksUri: text(),
    grantTypes: text().array(),
    responseTypes: text().array(),
    requirePKCE: boolean(),
    dpopBoundAccessTokens: boolean().default(false),
    referenceId: text(),
    metadata: jsonb(),
  },
  (t) => [index().on(t.userId), index().on(t.createdAt)],
)

/** Ressursene det lages tilgangsnøkler for (RFC 8707). Her bare `/api/mcp`. */
export const oauthResource = pgTable('oauth_resource', {
  id: text().primaryKey(),
  identifier: text().notNull().unique(),
  name: text().notNull(),
  accessTokenTtl: integer(),
  refreshTokenTtl: integer(),
  signingAlgorithm: text(),
  signingKeyId: text(),
  allowedScopes: text().array(),
  customClaims: jsonb(),
  dpopBoundAccessTokensRequired: boolean().default(false),
  disabled: boolean().default(false),
  createdAt: timestamp({ withTimezone: true }),
  updatedAt: timestamp({ withTimezone: true }),
  policyVersion: integer().default(1),
  metadata: jsonb(),
})

export const oauthClientResource = pgTable(
  'oauth_client_resource',
  {
    id: text().primaryKey(),
    clientId: text()
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    resourceId: text()
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: 'cascade' }),
    metadata: jsonb(),
    createdAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.resourceId), uniqueIndex().on(t.clientId, t.resourceId)],
)

/** Fornyelsesnøkler (med `offline_access`). `token` er SHA-256 av nøkkelen. */
export const oauthRefreshToken = pgTable(
  'oauth_refresh_token',
  {
    id: text().primaryKey(),
    token: text().notNull().unique(),
    clientId: text()
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    sessionId: text().references(() => session.id, { onDelete: 'set null' }),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    referenceId: text(),
    authorizationCodeId: text(),
    resources: text().array(),
    requestedUserInfoClaims: text().array(),
    expiresAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }),
    revoked: timestamp({ withTimezone: true }),
    rotatedAt: timestamp({ withTimezone: true }),
    rotationReplayResponse: text(),
    rotationReplayExpiresAt: timestamp({ withTimezone: true }),
    authTime: timestamp({ withTimezone: true }),
    confirmation: jsonb(),
    scopes: text().array().notNull(),
  },
  (t) => [
    index().on(t.clientId),
    index().on(t.sessionId),
    index().on(t.userId),
    index().on(t.authorizationCodeId),
    index().on(t.expiresAt),
  ],
)

/** Tilgangsnøkler, gyldige en time. `token` er SHA-256 av nøkkelen. */
export const oauthAccessToken = pgTable(
  'oauth_access_token',
  {
    id: text().primaryKey(),
    token: text().unique(),
    clientId: text()
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    sessionId: text().references(() => session.id, { onDelete: 'set null' }),
    userId: text().references(() => user.id, { onDelete: 'cascade' }),
    referenceId: text(),
    authorizationCodeId: text(),
    resources: text().array(),
    requestedUserInfoClaims: text().array(),
    refreshId: text().references(() => oauthRefreshToken.id, { onDelete: 'cascade' }),
    expiresAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }),
    revoked: timestamp({ withTimezone: true }),
    confirmation: jsonb(),
    scopes: text().array().notNull(),
  },
  (t) => [
    index().on(t.clientId),
    index().on(t.sessionId),
    index().on(t.userId),
    index().on(t.authorizationCodeId),
    index().on(t.refreshId),
    index().on(t.expiresAt),
  ],
)

/** At en admin har godkjent en klient, med hvilke rettigheter (`scopes`). */
export const oauthConsent = pgTable(
  'oauth_consent',
  {
    id: text().primaryKey(),
    clientId: text()
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    userId: text().references(() => user.id, { onDelete: 'cascade' }),
    referenceId: text(),
    resources: text().array(),
    requestedUserInfoClaims: text().array(),
    scopes: text().array().notNull(),
    createdAt: timestamp({ withTimezone: true }),
    updatedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.clientId), index().on(t.userId)],
)

/** Engangsmerker for klientpåstander (`private_key_jwt`). Brukes ikke av MCP-klientene i dag. */
export const oauthClientAssertion = pgTable('oauth_client_assertion', {
  id: text().primaryKey(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
})

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
     * transaksjon for forespørsler med nøkkel (`withMcpAudit`). Da kan ingen
     * hendelse fra MCP havne i loggen uten merket, uansett hvor den skrives.
     */
    apiTokenId: uuid()
      .references(() => apiToken.id, { onDelete: 'set null' })
      .default(sql`nullif(current_setting('esaf.api_token_id', true), '')::uuid`),
    /**
     * MCP-klienten koblet til med OAuth som gjorde handlingen, ellers null. Settes
     * av databasen fra `esaf.oauth_client_id` på samme måte (`withMcpAudit`).
     */
    oauthClientId: text()
      .references(() => oauthClient.clientId, { onDelete: 'set null' })
      .default(sql`nullif(current_setting('esaf.oauth_client_id', true), '')`),
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
export type BoardRole = (typeof boardRole.enumValues)[number]
export type BadgeStatus = (typeof badgeStatus.enumValues)[number]
export type BadgeAwardSource = (typeof badgeAwardSource.enumValues)[number]

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
    /**
     * Kommentaren dette er et svar på, alltid den øverste i tråden: svar har ett nivå.
     * Forsvinner den helt, blir svaret stående som en vanlig kommentar.
     */
    parentCommentId: uuid().references((): AnyPgColumn => comment.id, { onDelete: 'set null' }),
    body: text().notNull(),
    /** Satt når forfatteren har redigert kommentaren. */
    editedAt: timestamp({ withTimezone: true }),
    deletedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [index().on(t.postId, t.createdAt), index().on(t.parentCommentId)],
)

/** Reaksjonene på en kommentar. Hver reaksjon er ett tegn i appen (`reactionEmoji`). */
export const commentReactionKind = pgEnum('comment_reaction_kind', [
  'like',
  'heart',
  'laugh',
  'party',
  'eyes',
])

/** En person kan gi flere ulike reaksjoner på samme kommentar, men hver bare én gang. */
export const commentReaction = pgTable(
  'comment_reaction',
  {
    commentId: uuid()
      .notNull()
      .references(() => comment.id, { onDelete: 'cascade' }),
    personId: uuid()
      .notNull()
      .references(() => person.id, { onDelete: 'cascade' }),
    kind: commentReactionKind().notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [primaryKey({ columns: [t.commentId, t.personId, t.kind] }), index().on(t.personId)],
)

export type CommentReactionKind = (typeof commentReactionKind.enumValues)[number]

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
  /** Noen svarte på en kommentar mottakeren skrev. */
  'comment_reply',
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
  /** Velkomsten etter at en admin godkjente forespørselen: sendes også på e-post. */
  emailWelcome?: boolean
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
    // E-postutsendingen leter etter varsler som verken er lest eller sendt.
    index('notification_unsent_index')
      .on(t.createdAt)
      .where(sql`${t.readAt} is null and ${t.emailedAt} is null`),
  ],
)

export type NotificationType = (typeof notificationType.enumValues)[number]

/**
 * Hvor ofte varsler sendes på e-post: med en gang (samlet noen minutter),
 * i en daglig eller ukentlig oppsummering, eller ikke.
 */
export const notificationEmailFrequency = pgEnum('notification_email_frequency', [
  'instant',
  'daily',
  'weekly',
  'off',
])

/**
 * Hva hvert medlem vil ha på e-post, per kategori (se `notificationCategories`
 * i @esaf/core). Uten rad gjelder standarden for kategorien.
 */
export const notificationEmailPreference = pgTable(
  'notification_email_preference',
  {
    personId: uuid()
      .notNull()
      .references(() => person.id, { onDelete: 'cascade' }),
    category: text().notNull(),
    frequency: notificationEmailFrequency().notNull(),
    updatedAt: timestamps.updatedAt,
  },
  (t) => [primaryKey({ columns: [t.personId, t.category] })],
)

export type NotificationEmailFrequency = (typeof notificationEmailFrequency.enumValues)[number]

// ---------------------------------------------------------------------------
// Sendte e-poster
// ---------------------------------------------------------------------------

/** Hvilken e-post det var. Se `emailCatalog` i @esaf/core for når hver sendes. */
export const emailKind = pgEnum('email_kind', [
  'invitation',
  'password_link',
  'password_reset',
  'verification',
  'welcome',
  'notification',
  'digest',
  'test',
])

/** Hvordan det gikk: levert til leverandøren, avvist av mottakeren, eller feilet. */
export const emailStatus = pgEnum('email_status', ['sent', 'bounced', 'failed'])

/**
 * Hver e-post appen har prøvd å sende, til admins oversikt. Bare emnet lagres,
 * ikke innholdet: lenkene i e-postene er hemmeligheter. Slettes etter ett år
 * (`pruneEmailLog`).
 */
export const emailLog = pgTable(
  'email_log',
  {
    id: uuid().primaryKey().defaultRandom(),
    kind: emailKind().notNull(),
    toEmail: text().notNull(),
    /** Profilen adressen hører til, om den finnes. */
    personId: uuid().references(() => person.id, { onDelete: 'set null' }),
    subject: text().notNull(),
    status: emailStatus().notNull(),
    /** Hvorfor det feilet (`EmailErrorReason`, eller `error` for ukjente feil). */
    errorReason: text(),
    /** For varsler: kategorien, eller `all` når e-posten har flere. */
    category: text(),
    /** For varsler: hvor mange varsler e-posten hadde. */
    items: integer().notNull().default(0),
    provider: text().notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [index().on(t.createdAt), index().on(t.personId, t.createdAt), index().on(t.toEmail)],
)

/**
 * Innstillinger admins endrer i appen, uten deploy, som at e-post er satt på
 * pause. Én rad per innstilling; verdien er JSON med typen fra @esaf/core.
 */
export const appSetting = pgTable('app_setting', {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  updatedByPersonId: uuid().references(() => person.id, { onDelete: 'set null' }),
  updatedAt: timestamps.updatedAt,
})

/** Adresser appen ikke sender til, satt av en admin (Admin → E-post). */
export const emailBlock = pgTable('email_block', {
  /** Normalisert til små bokstaver. */
  email: text().primaryKey(),
  reason: text(),
  createdByPersonId: uuid().references(() => person.id, { onDelete: 'set null' }),
  createdAt: timestamps.createdAt,
})

export type EmailKind = (typeof emailKind.enumValues)[number]
export type EmailStatus = (typeof emailStatus.enumValues)[number]

// ---------------------------------------------------------------------------
// Vedlegg: bilder og dokumenter på innlegg, kommentarer, arrangementer og selskaper
// ---------------------------------------------------------------------------

/** Bilder behandles og lagres som WebP i to størrelser; dokumenter lagres som de er. */
export const assetKind = pgEnum('asset_kind', ['image', 'document'])

/**
 * Hva fila ble lastet opp til. Bestemmes ved opplasting, så tilgangen kan sjekkes
 * før fila leses, og avgjør hvilken forelder den kan festes til.
 */
export const assetPurpose = pgEnum('asset_purpose', [
  /** Vedlegg i et innlegg. */
  'post',
  /** Vedlegg i en kommentar. */
  'comment',
  /** «Bilder» på et arrangement. */
  'event_photo',
  /** «Dokumenter» på et arrangement (program, referat). */
  'event_document',
  /** «Dokumenter» på et selskap (pitch deck, pressemateriale). */
  'company_document',
])

/**
 * En opplastet fil. Hører til høyst én forelder (innlegg, kommentar, arrangement
 * eller selskap). Vedlegg til innlegg og kommentarer lastes opp før innlegget
 * finnes, og står uten forelder til det lagres; de som aldri blir festet, ryddes
 * bort etter et døgn. Slettes forelderen, blir nøkkelen null, og filene ryddes
 * bort på samme måte (se `assets.ts` i @esaf/core).
 *
 * Sletting er myk: `deleted_at` skjuler fila med en gang, og `purged_at` settes
 * når filene er fjernet fra lagringen. Raden blir stående, så grensen per døgn
 * ikke kan omgås ved å slette og laste opp på nytt.
 */
export const asset = pgTable(
  'asset',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Tilfeldig nøkkel (128 bit) i adressene: `/api/vedlegg/<nøkkel>…`. */
    fileKey: text().notNull().unique(),
    /** Den som lastet opp. Null hvis personen er slettet. */
    ownerPersonId: uuid().references(() => person.id, { onDelete: 'set null' }),
    purpose: assetPurpose().notNull(),
    kind: assetKind().notNull(),
    postId: uuid().references(() => post.id, { onDelete: 'set null' }),
    commentId: uuid().references(() => comment.id, { onDelete: 'set null' }),
    eventId: uuid().references(() => event.id, { onDelete: 'set null' }),
    companyId: uuid().references(() => company.id, { onDelete: 'set null' }),
    /** Rekkefølgen blant vedleggene til samme forelder. */
    position: integer().notNull().default(0),
    /** Filnavnet slik det vises og lastes ned, renset og med riktig filendelse. */
    originalName: text().notNull(),
    /**
     * GIF-er fra søket: id-en hos GIPHY og tittelen. De kan søkes opp igjen her når
     * GIPHY ikke svarer. Settes til null når en moderator fjerner GIF-en.
     */
    gifId: text(),
    gifTitle: text(),
    /** Typen fila serveres med, avgjort ut fra innholdet. */
    contentType: text().notNull(),
    /** Størrelsen på fila som ble lastet opp. */
    byteSize: integer().notNull(),
    /** Nøklene i lagringen per variant: `400` og `1600` for bilder, `original` for dokumenter. */
    storageKeys: jsonb().$type<Record<string, string>>().notNull(),
    /** Den store varianten av bildet, slik det står. Null for dokumenter. */
    width: integer(),
    height: integer(),
    /** SHA-256 av fila som ble lastet opp. */
    sha256: text().notNull(),
    /** Når fila ble festet til en forelder. */
    attachedAt: timestamp({ withTimezone: true }),
    createdAt: timestamps.createdAt,
    deletedAt: timestamp({ withTimezone: true }),
    /** Når filene ble slettet fra lagringen. */
    purgedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index().on(t.postId),
    index().on(t.commentId),
    index('asset_gif_index')
      .on(t.gifId)
      .where(sql`${t.gifId} is not null`),
    index().on(t.eventId),
    index().on(t.companyId),
    // Grensen per døgn teller det personen har lastet opp.
    index().on(t.ownerPersonId, t.createdAt),
    // Oppryddingen ser bare på filer som fortsatt ligger i lagringen.
    index('asset_unpurged_index')
      .on(t.createdAt)
      .where(sql`${t.purgedAt} is null`),
    check(
      'asset_one_parent',
      sql`num_nonnulls(${t.postId}, ${t.commentId}, ${t.eventId}, ${t.companyId}) <= 1`,
    ),
    check(
      'asset_parent_purpose',
      sql`(${t.postId} is null or ${t.purpose} = 'post') and (${t.commentId} is null or ${t.purpose} = 'comment') and (${t.eventId} is null or ${t.purpose} in ('event_photo', 'event_document')) and (${t.companyId} is null or ${t.purpose} = 'company_document')`,
    ),
    check('asset_album_images', sql`${t.purpose} <> 'event_photo' or ${t.kind} = 'image'`),
    check('asset_byte_size', sql`${t.byteSize} > 0`),
    check(
      'asset_image_size',
      sql`(${t.kind} = 'image') = (${t.width} is not null and ${t.height} is not null)`,
    ),
  ],
)

export type AssetKind = (typeof assetKind.enumValues)[number]
export type AssetPurpose = (typeof assetPurpose.enumValues)[number]
