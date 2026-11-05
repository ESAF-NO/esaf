ALTER TYPE "public"."email_kind" ADD VALUE 'access_request' BEFORE 'test';--> statement-breakpoint
ALTER TABLE "access_request" ADD COLUMN "admin_alerted_at" timestamp with time zone;