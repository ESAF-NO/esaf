CREATE TYPE "public"."programme_kind" AS ENUM('accelerator', 'incubator', 'pre_incubator', 'other');--> statement-breakpoint
ALTER TYPE "public"."company_event_type" ADD VALUE 'programme';--> statement-breakpoint
ALTER TABLE "company_event" ADD COLUMN "programme_company_id" uuid;--> statement-breakpoint
ALTER TABLE "company_event" ADD COLUMN "programme_kind" "programme_kind";--> statement-breakpoint
ALTER TABLE "company_event" ADD COLUMN "programme_batch" text;--> statement-breakpoint
ALTER TABLE "company_event" ADD CONSTRAINT "company_event_programme_company_id_company_id_fk" FOREIGN KEY ("programme_company_id") REFERENCES "public"."company"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_event_programme_company_id_index" ON "company_event" USING btree ("programme_company_id");--> statement-breakpoint
ALTER TABLE "company_event" ADD CONSTRAINT "company_event_programme" CHECK ("company_event"."type"::text = 'programme' or ("company_event"."programme_company_id" is null and "company_event"."programme_kind" is null and "company_event"."programme_batch" is null));--> statement-breakpoint
ALTER TABLE "company_event" ADD CONSTRAINT "company_event_not_own_programme" CHECK ("company_event"."programme_company_id" is null or "company_event"."programme_company_id" <> "company_event"."company_id");