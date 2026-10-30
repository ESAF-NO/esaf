CREATE TABLE "person_search_index" (
	"person_id" uuid PRIMARY KEY NOT NULL,
	"content_hash" text NOT NULL,
	"model" text NOT NULL,
	"chunks" jsonb NOT NULL,
	"vectors" "bytea" NOT NULL,
	"dims" integer NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "search_topics" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "person_search_index" ADD CONSTRAINT "person_search_index_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE cascade ON UPDATE no action;