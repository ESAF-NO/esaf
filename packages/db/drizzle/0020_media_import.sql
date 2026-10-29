CREATE TYPE "public"."company_article_source" AS ENUM('import', 'member', 'admin');--> statement-breakpoint
CREATE TYPE "public"."import_record_kind" AS ENUM('company', 'company_field', 'company_logo', 'company_event', 'company_article', 'person', 'person_field', 'person_photo', 'quote');--> statement-breakpoint
ALTER TYPE "public"."company_suggestion_kind" ADD VALUE 'article';--> statement-breakpoint
CREATE TABLE "company_article" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"publisher" text,
	"published_at" date,
	"published_precision" date_precision DEFAULT 'day' NOT NULL,
	"paywall" boolean DEFAULT false NOT NULL,
	"mentions_es" boolean DEFAULT false NOT NULL,
	"source" "company_article_source" NOT NULL,
	"added_by_person_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_record" (
	"kind" "import_record_kind" NOT NULL,
	"key_hash" text NOT NULL,
	"entity_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_record_kind_key_hash_pk" PRIMARY KEY("kind","key_hash")
);
--> statement-breakpoint
ALTER TABLE "company_article" ADD CONSTRAINT "company_article_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_article" ADD CONSTRAINT "company_article_added_by_person_id_person_id_fk" FOREIGN KEY ("added_by_person_id") REFERENCES "public"."person"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_article_company_id_url_index" ON "company_article" USING btree ("company_id","url");--> statement-breakpoint
CREATE INDEX "company_article_company_id_published_at_index" ON "company_article" USING btree ("company_id","published_at");