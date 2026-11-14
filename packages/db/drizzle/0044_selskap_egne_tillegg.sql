ALTER TYPE "public"."notification_type" ADD VALUE 'company_addition';--> statement-breakpoint
ALTER TABLE "company_event" ADD COLUMN "added_by_person_id" uuid;--> statement-breakpoint
ALTER TABLE "company_event" ADD CONSTRAINT "company_event_added_by_person_id_person_id_fk" FOREIGN KEY ("added_by_person_id") REFERENCES "public"."person"("id") ON DELETE set null ON UPDATE no action;