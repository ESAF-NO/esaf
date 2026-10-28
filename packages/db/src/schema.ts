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
 * egenskaper (opptaksår, senere navn, syretester, kontaktperson), en person kan
 * ha flere tilknytninger (f.eks. student i ett kull og mentor for et annet),
 * og import, invitasjon og oversikter skjer per kull.
 */
export const cohort = pgTable(
  'cohort',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Opptaksåret til kullet ved NTNUs Entreprenørskole. */
    startYear: integer().notNull().unique(),
    /** Valgfritt kallenavn kullet selv bruker. */
    name: text(),
    ...timestamps,
  },
  (t) => [check('cohort_start_year_range', sql`${t.startYear} between 1990 and 2100`)],
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
    /** Normalisert til små bokstaver. Brukes til å koble kulliste mot konto. */
    email: text(),
    userId: text().references(() => user.id, { onDelete: 'set null' }),
    /** Når personen selv tok i bruk profilen. Null for profiler uten konto. */
    claimedAt: timestamp({ withTimezone: true }),
    source: personSource().notNull().default('signup'),
    ...timestamps,
  },
  (t) => [uniqueIndex().on(t.email), uniqueIndex().on(t.userId)],
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
export const memberRole = pgEnum('member_role', ['member', 'admin'])

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
