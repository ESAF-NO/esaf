CREATE TYPE "public"."asset_kind" AS ENUM('image', 'document');--> statement-breakpoint
CREATE TYPE "public"."asset_purpose" AS ENUM('post', 'comment', 'event_photo', 'event_document', 'company_document');--> statement-breakpoint
CREATE TABLE "asset" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_key" text NOT NULL,
	"owner_person_id" uuid,
	"purpose" "asset_purpose" NOT NULL,
	"kind" "asset_kind" NOT NULL,
	"post_id" uuid,
	"comment_id" uuid,
	"event_id" uuid,
	"company_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"original_name" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"storage_keys" jsonb NOT NULL,
	"width" integer,
	"height" integer,
	"sha256" text NOT NULL,
	"attached_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	CONSTRAINT "asset_fileKey_unique" UNIQUE("file_key"),
	CONSTRAINT "asset_one_parent" CHECK (num_nonnulls("asset"."post_id", "asset"."comment_id", "asset"."event_id", "asset"."company_id") <= 1),
	CONSTRAINT "asset_parent_purpose" CHECK (("asset"."post_id" is null or "asset"."purpose" = 'post') and ("asset"."comment_id" is null or "asset"."purpose" = 'comment') and ("asset"."event_id" is null or "asset"."purpose" in ('event_photo', 'event_document')) and ("asset"."company_id" is null or "asset"."purpose" = 'company_document')),
	CONSTRAINT "asset_album_images" CHECK ("asset"."purpose" <> 'event_photo' or "asset"."kind" = 'image'),
	CONSTRAINT "asset_byte_size" CHECK ("asset"."byte_size" > 0),
	CONSTRAINT "asset_image_size" CHECK (("asset"."kind" = 'image') = ("asset"."width" is not null and "asset"."height" is not null))
);
--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_owner_person_id_person_id_fk" FOREIGN KEY ("owner_person_id") REFERENCES "public"."person"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_comment_id_comment_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_post_id_index" ON "asset" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "asset_comment_id_index" ON "asset" USING btree ("comment_id");--> statement-breakpoint
CREATE INDEX "asset_event_id_index" ON "asset" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "asset_company_id_index" ON "asset" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "asset_owner_person_id_created_at_index" ON "asset" USING btree ("owner_person_id","created_at");--> statement-breakpoint
CREATE INDEX "asset_unpurged_index" ON "asset" USING btree ("created_at") WHERE "asset"."purged_at" is null;