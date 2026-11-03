CREATE TYPE "public"."email_kind" AS ENUM('invitation', 'password_link', 'password_reset', 'verification', 'welcome', 'notification', 'digest', 'test');--> statement-breakpoint
CREATE TYPE "public"."email_status" AS ENUM('sent', 'bounced', 'failed');--> statement-breakpoint
CREATE TABLE "email_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "email_kind" NOT NULL,
	"to_email" text NOT NULL,
	"person_id" uuid,
	"subject" text NOT NULL,
	"status" "email_status" NOT NULL,
	"error_reason" text,
	"category" text,
	"items" integer DEFAULT 0 NOT NULL,
	"provider" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_log_created_at_index" ON "email_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "email_log_person_id_created_at_index" ON "email_log" USING btree ("person_id","created_at");--> statement-breakpoint
CREATE INDEX "email_log_to_email_index" ON "email_log" USING btree ("to_email");