CREATE TYPE "public"."weekend_attendance_source" AS ENUM('self', 'admin', 'import');--> statement-breakpoint
CREATE TABLE "cohort_representative" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cohort_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"start_year" integer,
	"end_year" integer,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cohort_representative_years" CHECK (("cohort_representative"."start_year" is null or "cohort_representative"."start_year" between 1990 and 2100) and ("cohort_representative"."end_year" is null or "cohort_representative"."end_year" between 1990 and 2100) and ("cohort_representative"."start_year" is null or "cohort_representative"."end_year" is null or "cohort_representative"."end_year" >= "cohort_representative"."start_year"))
);
--> statement-breakpoint
CREATE TABLE "esaf_weekend" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"location" text,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "esaf_weekend_dates" CHECK ("esaf_weekend"."end_date" is null or "esaf_weekend"."end_date" >= "esaf_weekend"."start_date")
);
--> statement-breakpoint
CREATE TABLE "esaf_weekend_attendance" (
	"weekend_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"source" "weekend_attendance_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "esaf_weekend_attendance_weekend_id_person_id_pk" PRIMARY KEY("weekend_id","person_id")
);
--> statement-breakpoint
ALTER TABLE "cohort_representative" ADD CONSTRAINT "cohort_representative_cohort_id_cohort_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohort"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cohort_representative" ADD CONSTRAINT "cohort_representative_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "esaf_weekend_attendance" ADD CONSTRAINT "esaf_weekend_attendance_weekend_id_esaf_weekend_id_fk" FOREIGN KEY ("weekend_id") REFERENCES "public"."esaf_weekend"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "esaf_weekend_attendance" ADD CONSTRAINT "esaf_weekend_attendance_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cohort_representative_cohort_id_index" ON "cohort_representative" USING btree ("cohort_id");--> statement-breakpoint
CREATE INDEX "cohort_representative_person_id_index" ON "cohort_representative" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cohort_representative_current_index" ON "cohort_representative" USING btree ("cohort_id","person_id") WHERE "cohort_representative"."end_year" is null;--> statement-breakpoint
CREATE INDEX "esaf_weekend_start_date_index" ON "esaf_weekend" USING btree ("start_date");--> statement-breakpoint
CREATE INDEX "esaf_weekend_attendance_person_id_index" ON "esaf_weekend_attendance" USING btree ("person_id");