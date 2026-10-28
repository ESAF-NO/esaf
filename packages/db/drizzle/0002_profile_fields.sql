ALTER TABLE "person" ADD COLUMN "current_company" text;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "job_title" text;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "es_company" text;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "bio" text;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "expertise" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "linkedin_url" text;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "contact_email" text;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "contact_email_visible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "phone_visible" boolean DEFAULT false NOT NULL;