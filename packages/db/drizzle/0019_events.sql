CREATE TYPE "public"."participation_role" AS ENUM('attended', 'organizer', 'speaker', 'volunteer');--> statement-breakpoint
CREATE TYPE "public"."participation_source" AS ENUM('self', 'admin', 'import');--> statement-breakpoint
CREATE TABLE "event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type_id" uuid NOT NULL,
	"name" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"location" text,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_dates" CHECK ("event"."end_date" is null or "event"."end_date" >= "event"."start_date")
);
--> statement-breakpoint
CREATE TABLE "event_participation" (
	"event_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"role" "participation_role",
	"source" "participation_source" NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_participation_event_id_person_id_pk" PRIMARY KEY("event_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "event_type" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"plural" text,
	"description" text,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_type_slug_unique" UNIQUE("slug"),
	CONSTRAINT "event_type_slug" CHECK ("event_type"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_type_id_event_type_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."event_type"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_participation" ADD CONSTRAINT "event_participation_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_participation" ADD CONSTRAINT "event_participation_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_type_id_start_date_index" ON "event" USING btree ("type_id","start_date");--> statement-breakpoint
CREATE INDEX "event_start_date_index" ON "event" USING btree ("start_date");--> statement-breakpoint
CREATE INDEX "event_participation_person_id_index" ON "event_participation" USING btree ("person_id");--> statement-breakpoint
-- Data: ESAF-helgen blir den første arrangementstypen, og helgene og oppmøtet
-- flyttes over med samme id-er, så gamle lenker (/esaf-helgen/:id) kan sendes videre.
INSERT INTO "event_type" ("slug", "name", "plural", "description", "sort_order") VALUES ('esaf-helgen', 'ESAF-helgen', 'ESAF-helgene', 'Samlingen for alle fra Entreprenørskolen, som regel én gang i året.', 0);--> statement-breakpoint
INSERT INTO "event" ("id", "type_id", "name", "start_date", "end_date", "location", "description", "created_at", "updated_at")
SELECT w."id", t."id", w."name", w."start_date", w."end_date", w."location", w."description", w."created_at", w."updated_at"
FROM "esaf_weekend" w CROSS JOIN "event_type" t WHERE t."slug" = 'esaf-helgen';--> statement-breakpoint
INSERT INTO "event_participation" ("event_id", "person_id", "role", "source", "created_at")
SELECT a."weekend_id", a."person_id", NULL, a."source"::text::"participation_source", a."created_at"
FROM "esaf_weekend_attendance" a;--> statement-breakpoint
DROP TABLE "esaf_weekend_attendance";--> statement-breakpoint
DROP TABLE "esaf_weekend";--> statement-breakpoint
DROP TYPE "public"."weekend_attendance_source";
