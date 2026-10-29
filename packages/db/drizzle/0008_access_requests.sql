CREATE TYPE "public"."access_request_status" AS ENUM('open', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "access_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"profile_person_id" uuid,
	"full_name" text NOT NULL,
	"graduation_year" integer,
	"linkedin_url" text,
	"note" text,
	"status" "access_request_status" DEFAULT 'open' NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_person_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_request_userId_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "onboarded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "access_request" ADD CONSTRAINT "access_request_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_request" ADD CONSTRAINT "access_request_profile_person_id_person_id_fk" FOREIGN KEY ("profile_person_id") REFERENCES "public"."person"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_request" ADD CONSTRAINT "access_request_decided_by_person_id_person_id_fk" FOREIGN KEY ("decided_by_person_id") REFERENCES "public"."person"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_request_status_created_at_index" ON "access_request" USING btree ("status","created_at");