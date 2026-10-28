ALTER TABLE "comment" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "pinned_at" timestamp with time zone;