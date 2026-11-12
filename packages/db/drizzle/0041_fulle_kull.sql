CREATE TABLE "cohort_completion" (
	"cohort_id" uuid PRIMARY KEY NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"members" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cohort_completion" ADD CONSTRAINT "cohort_completion_cohort_id_cohort_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohort"("id") ON DELETE cascade ON UPDATE no action;