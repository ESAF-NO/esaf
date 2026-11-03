CREATE TABLE "app_setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by_person_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_setting" ADD CONSTRAINT "app_setting_updated_by_person_id_person_id_fk" FOREIGN KEY ("updated_by_person_id") REFERENCES "public"."person"("id") ON DELETE set null ON UPDATE no action;