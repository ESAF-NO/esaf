CREATE TYPE "public"."company_link_role" AS ENUM('founder', 'es', 'employee');--> statement-breakpoint
CREATE TYPE "public"."company_suggestion_kind" AS ENUM('info', 'event');--> statement-breakpoint
CREATE TYPE "public"."contribution_status" AS ENUM('pending', 'accepted', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."review_dismissal_kind" AS ENUM('company_duplicate', 'person_duplicate');--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'company_suggestion';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'suggestion_accepted';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'suggestion_rejected';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'company_link_request';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'company_link_confirmed';--> statement-breakpoint
ALTER TYPE "public"."person_source" ADD VALUE 'admin';--> statement-breakpoint
CREATE TABLE "company_link_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"requested_by_person_id" uuid NOT NULL,
	"role" "company_link_role" NOT NULL,
	"title" text,
	"start_year" integer,
	"end_year" integer,
	"status" "contribution_status" DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_person_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_link_request_years" CHECK (("company_link_request"."start_year" is null or "company_link_request"."start_year" between 1950 and 2100) and ("company_link_request"."end_year" is null or "company_link_request"."end_year" between 1950 and 2100) and ("company_link_request"."start_year" is null or "company_link_request"."end_year" is null or "company_link_request"."end_year" >= "company_link_request"."start_year"))
);
--> statement-breakpoint
CREATE TABLE "company_suggestion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"suggested_by_person_id" uuid NOT NULL,
	"kind" "company_suggestion_kind" NOT NULL,
	"changes" jsonb NOT NULL,
	"note" text,
	"status" "contribution_status" DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_person_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_dismissal" (
	"kind" "review_dismissal_kind" NOT NULL,
	"first_id" uuid NOT NULL,
	"second_id" uuid NOT NULL,
	"dismissed_by_person_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_dismissal_kind_first_id_second_id_pk" PRIMARY KEY("kind","first_id","second_id"),
	CONSTRAINT "review_dismissal_order" CHECK ("review_dismissal"."first_id" < "review_dismissal"."second_id")
);
--> statement-breakpoint
ALTER TABLE "field_source" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "company_link_request" ADD CONSTRAINT "company_link_request_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_link_request" ADD CONSTRAINT "company_link_request_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_link_request" ADD CONSTRAINT "company_link_request_requested_by_person_id_person_id_fk" FOREIGN KEY ("requested_by_person_id") REFERENCES "public"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_link_request" ADD CONSTRAINT "company_link_request_decided_by_person_id_person_id_fk" FOREIGN KEY ("decided_by_person_id") REFERENCES "public"."person"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_suggestion" ADD CONSTRAINT "company_suggestion_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_suggestion" ADD CONSTRAINT "company_suggestion_suggested_by_person_id_person_id_fk" FOREIGN KEY ("suggested_by_person_id") REFERENCES "public"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_suggestion" ADD CONSTRAINT "company_suggestion_decided_by_person_id_person_id_fk" FOREIGN KEY ("decided_by_person_id") REFERENCES "public"."person"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_dismissal" ADD CONSTRAINT "review_dismissal_dismissed_by_person_id_person_id_fk" FOREIGN KEY ("dismissed_by_person_id") REFERENCES "public"."person"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_link_request_person_id_status_index" ON "company_link_request" USING btree ("person_id","status");--> statement-breakpoint
CREATE INDEX "company_link_request_requested_by_person_id_status_created_at_index" ON "company_link_request" USING btree ("requested_by_person_id","status","created_at");--> statement-breakpoint
CREATE INDEX "company_link_request_company_id_index" ON "company_link_request" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "company_link_request_pending_index" ON "company_link_request" USING btree ("company_id","person_id","role") WHERE "company_link_request"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "company_suggestion_company_id_status_index" ON "company_suggestion" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "company_suggestion_suggested_by_person_id_status_created_at_index" ON "company_suggestion" USING btree ("suggested_by_person_id","status","created_at");--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_company_id_index" ON "notification" USING btree ("company_id");