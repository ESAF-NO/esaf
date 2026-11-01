CREATE TYPE "public"."badge_award_source" AS ENUM('rule', 'manual');--> statement-breakpoint
CREATE TYPE "public"."badge_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TABLE "badge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"icon" text NOT NULL,
	"color" text NOT NULL,
	"rule" jsonb NOT NULL,
	"status" "badge_status" DEFAULT 'draft' NOT NULL,
	"series" text,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "badge_slug_unique" UNIQUE("slug"),
	CONSTRAINT "badge_slug" CHECK ("badge"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "badge_award" (
	"badge_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"source" "badge_award_source" NOT NULL,
	"achieved_on" date,
	"citation" text,
	"awarded_by_person_id" uuid,
	"hidden" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "badge_award_badge_id_person_id_pk" PRIMARY KEY("badge_id","person_id")
);
--> statement-breakpoint
ALTER TABLE "badge_award" ADD CONSTRAINT "badge_award_badge_id_badge_id_fk" FOREIGN KEY ("badge_id") REFERENCES "public"."badge"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "badge_award" ADD CONSTRAINT "badge_award_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "badge_award" ADD CONSTRAINT "badge_award_awarded_by_person_id_person_id_fk" FOREIGN KEY ("awarded_by_person_id") REFERENCES "public"."person"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "badge_award_person_id_index" ON "badge_award" USING btree ("person_id");