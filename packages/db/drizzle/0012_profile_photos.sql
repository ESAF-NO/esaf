ALTER TABLE "person" ADD COLUMN "photo_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "person_photo_key_index" ON "person" USING btree ("photo_key");