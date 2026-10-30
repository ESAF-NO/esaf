CREATE TYPE "public"."board_role" AS ENUM('chair', 'vice_chair', 'member', 'deputy');--> statement-breakpoint
CREATE TABLE "board_member" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"role" "board_role" DEFAULT 'member' NOT NULL,
	"responsibility" text,
	"start_year" integer,
	"end_year" integer,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_member_years" CHECK (("board_member"."start_year" is null or "board_member"."start_year" between 1990 and 2100) and ("board_member"."end_year" is null or "board_member"."end_year" between 1990 and 2100) and ("board_member"."start_year" is null or "board_member"."end_year" is null or "board_member"."end_year" >= "board_member"."start_year"))
);
--> statement-breakpoint
ALTER TABLE "board_member" ADD CONSTRAINT "board_member_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_member_person_id_index" ON "board_member" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "board_member_current_index" ON "board_member" USING btree ("person_id") WHERE "board_member"."end_year" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "board_member_current_lead_index" ON "board_member" USING btree ("role") WHERE "board_member"."end_year" is null and "board_member"."role" in ('chair', 'vice_chair');