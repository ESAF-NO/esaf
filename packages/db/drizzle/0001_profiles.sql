CREATE TYPE "public"."person_source" AS ENUM('signup', 'import');--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "source" "person_source" DEFAULT 'signup' NOT NULL;--> statement-breakpoint
-- Eksisterende personer med konto har allerede tatt i bruk profilen sin.
UPDATE "person" SET "claimed_at" = "created_at" WHERE "user_id" IS NOT NULL;
