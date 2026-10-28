CREATE TYPE "public"."email_source" AS ENUM('signup', 'import', 'admin');--> statement-breakpoint
CREATE TABLE "person_email" (
	"email" text PRIMARY KEY NOT NULL,
	"person_id" uuid NOT NULL,
	"source" "email_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "study_background" text;--> statement-breakpoint
ALTER TABLE "person_email" ADD CONSTRAINT "person_email_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "person_email_person_id_index" ON "person_email" USING btree ("person_id");--> statement-breakpoint
-- Flytt eksisterende e-poster over i den nye tabellen før kolonnen fjernes.
INSERT INTO "person_email" ("email", "person_id", "source", "created_at")
SELECT lower("email"), "id", CASE WHEN "source" = 'import' THEN 'import'::"email_source" ELSE 'signup'::"email_source" END, "created_at"
FROM "person" WHERE "email" IS NOT NULL
ON CONFLICT DO NOTHING;
