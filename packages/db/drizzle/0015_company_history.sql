CREATE TYPE "public"."company_event_type" AS ENUM('founded', 'funding', 'award', 'launch', 'acquired', 'bankrupt', 'dissolved', 'closed', 'other');--> statement-breakpoint
CREATE TYPE "public"."date_precision" AS ENUM('year', 'month', 'day');--> statement-breakpoint
CREATE TYPE "public"."field_source_entity" AS ENUM('person', 'company');--> statement-breakpoint
CREATE TYPE "public"."source_confidence" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
CREATE TABLE "company_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"date" date NOT NULL,
	"date_precision" date_precision DEFAULT 'day' NOT NULL,
	"type" "company_event_type" NOT NULL,
	"text" text NOT NULL,
	"source_url" text,
	"source_label" text,
	"confidence" "source_confidence" DEFAULT 'high' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" "field_source_entity" NOT NULL,
	"entity_id" uuid NOT NULL,
	"field" text NOT NULL,
	"source_label" text NOT NULL,
	"source_url" text,
	"fetched_at" timestamp with time zone,
	"confidence" "source_confidence" NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"text" text NOT NULL,
	"person_id" uuid,
	"company_id" uuid,
	"speaker_name" text NOT NULL,
	"speaker_role" text,
	"date" date,
	"source_url" text,
	"source_label" text,
	"confidence" "source_confidence" DEFAULT 'high' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- HÅNDSKREVET (ukjent status): drizzle-kit lager `ALTER TYPE … ADD VALUE`, men en
-- ny enum-verdi kan ikke brukes (her som standardverdi) i samme transaksjon, og
-- migratoren kjører alle migreringer i én transaksjon. Typen lages derfor på nytt
-- med den nye verdien. Eksisterende selskaper beholder statusen sin.
ALTER TYPE "public"."company_status" RENAME TO "company_status_old";--> statement-breakpoint
CREATE TYPE "public"."company_status" AS ENUM('active', 'acquired', 'closed', 'unknown');--> statement-breakpoint
ALTER TABLE "company" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "company" ALTER COLUMN "status" SET DATA TYPE "public"."company_status" USING "status"::text::"public"."company_status";--> statement-breakpoint
ALTER TABLE "company" ALTER COLUMN "status" SET DEFAULT 'unknown';--> statement-breakpoint
DROP TYPE "public"."company_status_old";--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN "last_seen_on_es_site" date;--> statement-breakpoint
ALTER TABLE "company_event" ADD CONSTRAINT "company_event_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote" ADD CONSTRAINT "quote_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote" ADD CONSTRAINT "quote_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_event_company_id_date_index" ON "company_event" USING btree ("company_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "field_source_entity_type_entity_id_field_source_label_index" ON "field_source" USING btree ("entity_type","entity_id","field","source_label");--> statement-breakpoint
CREATE INDEX "quote_person_id_index" ON "quote" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "quote_company_id_index" ON "quote" USING btree ("company_id");