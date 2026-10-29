CREATE TABLE "experience" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"company" text NOT NULL,
	"title" text,
	"start_year" integer,
	"end_year" integer,
	"founder" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "experience_years" CHECK (("experience"."start_year" is null or "experience"."start_year" between 1950 and 2100) and ("experience"."end_year" is null or "experience"."end_year" between 1950 and 2100) and ("experience"."start_year" is null or "experience"."end_year" is null or "experience"."end_year" >= "experience"."start_year"))
);
--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "industries" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "experience" ADD CONSTRAINT "experience_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "experience_person_id_index" ON "experience" USING btree ("person_id");--> statement-breakpoint
-- Nåværende stilling og selskap flyttes til erfaring før kolonnene fjernes.
INSERT INTO "experience" ("person_id", "company", "title")
SELECT "id", "current_company", "job_title" FROM "person" WHERE "current_company" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "person" DROP COLUMN "current_company";--> statement-breakpoint
ALTER TABLE "person" DROP COLUMN "job_title";