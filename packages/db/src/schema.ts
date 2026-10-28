import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
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
  /** Tofaktor med autentiseringsapp (Better Auths two-factor-plugin). Påkrevd for admins. */
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

export const personSource = pgEnum('person_source', ['signup', 'import'])

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
    /** Selskapet personen startet eller jobbet med på Entreprenørskolen. */
    esCompany: text(),
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
     * Profilbildet: en tilfeldig nøkkel til bildefilene i lagringen (se
     * `photos.ts` i @esaf/core). Hvert nytt bilde får ny nøkkel, så adressene
     * aldri endrer innhold og kan caches lenge. Null betyr initialer.
     */
    photoKey: text(),

    // Kontakt. Vises bare når personen selv har slått det på, og aldri for
    // profiler ingen har tatt i bruk.
    contactEmail: text(),
    contactEmailVisible: boolean().notNull().default(false),
    phone: text(),
    phoneVisible: boolean().notNull().default(false),
    /** Når personen var gjennom (eller hoppet over) velkomststegene etter godkjenning. */
    onboardedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  // Bilderuten slår opp personen på nøkkelen ved hver forespørsel.
  (t) => [uniqueIndex().on(t.userId), uniqueIndex().on(t.photoKey)],
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
    company: text().notNull(),
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
    check(
      'experience_years',
      sql`(${t.startYear} is null or ${t.startYear} between 1950 and 2100) and (${t.endYear} is null or ${t.endYear} between 1950 and 2100) and (${t.startYear} is null or ${t.endYear} is null or ${t.endYear} >= ${t.startYear})`,
    ),
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
    createdAt: timestamps.createdAt,
  },
  (t) => [index().on(t.subjectPersonId)],
)

export type MembershipStatus = (typeof membershipStatus.enumValues)[number]
export type MemberRole = (typeof memberRole.enumValues)[number]
export type CohortRelation = (typeof cohortRelation.enumValues)[number]
export type PersonSource = (typeof personSource.enumValues)[number]
export type AccessRequestStatus = (typeof accessRequestStatus.enumValues)[number]

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
])

export type NotificationPayload = {
  /** Kullet varselet gjelder, for velkomst og nye fra kullet. */
  graduationYear?: number
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
    // Antall uleste hentes ved hver navigering, så de har sin egen lille indeks.
    index('notification_unread_index')
      .on(t.recipientPersonId, t.createdAt)
      .where(sql`${t.readAt} is null`),
  ],
)

export type NotificationType = (typeof notificationType.enumValues)[number]
