CREATE TYPE "public"."notification_email_frequency" AS ENUM('instant', 'daily', 'weekly', 'off');--> statement-breakpoint
CREATE TABLE "notification_email_preference" (
	"person_id" uuid NOT NULL,
	"category" text NOT NULL,
	"frequency" "notification_email_frequency" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_email_preference_person_id_category_pk" PRIMARY KEY("person_id","category")
);
--> statement-breakpoint
ALTER TABLE "notification_email_preference" ADD CONSTRAINT "notification_email_preference_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_unsent_index" ON "notification" USING btree ("created_at") WHERE "notification"."read_at" is null and "notification"."emailed_at" is null;