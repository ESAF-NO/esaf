CREATE TABLE "person_ai_topics" (
	"person_id" uuid PRIMARY KEY NOT NULL,
	"topics" text[] DEFAULT '{}'::text[] NOT NULL,
	"source_hash" text NOT NULL,
	"model" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "person_ai_topics" ADD CONSTRAINT "person_ai_topics_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE cascade ON UPDATE no action;