CREATE TYPE "public"."notification_type" AS ENUM('comment_on_post', 'comment_on_thread', 'mention', 'welcome', 'cohort_joined');--> statement-breakpoint
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_person_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"actor_person_id" uuid,
	"post_id" uuid,
	"comment_id" uuid,
	"event_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"emailed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_recipient_person_id_person_id_fk" FOREIGN KEY ("recipient_person_id") REFERENCES "public"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_actor_person_id_person_id_fk" FOREIGN KEY ("actor_person_id") REFERENCES "public"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_comment_id_comment_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_recipient_person_id_event_key_index" ON "notification" USING btree ("recipient_person_id","event_key");--> statement-breakpoint
CREATE INDEX "notification_recipient_person_id_created_at_index" ON "notification" USING btree ("recipient_person_id","created_at");--> statement-breakpoint
CREATE INDEX "notification_unread_index" ON "notification" USING btree ("recipient_person_id","created_at") WHERE "notification"."read_at" is null;