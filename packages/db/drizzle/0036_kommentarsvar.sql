CREATE TYPE "public"."comment_reaction_kind" AS ENUM('like', 'heart', 'laugh', 'party', 'eyes');--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'comment_reply' BEFORE 'mention';--> statement-breakpoint
CREATE TABLE "comment_reaction" (
	"comment_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"kind" "comment_reaction_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comment_reaction_comment_id_person_id_kind_pk" PRIMARY KEY("comment_id","person_id","kind")
);
--> statement-breakpoint
ALTER TABLE "comment" ADD COLUMN "parent_comment_id" uuid;--> statement-breakpoint
ALTER TABLE "comment_reaction" ADD CONSTRAINT "comment_reaction_comment_id_comment_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_reaction" ADD CONSTRAINT "comment_reaction_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comment_reaction_person_id_index" ON "comment_reaction" USING btree ("person_id");--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comment_parent_comment_id_comment_id_fk" FOREIGN KEY ("parent_comment_id") REFERENCES "public"."comment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comment_parent_comment_id_index" ON "comment" USING btree ("parent_comment_id");