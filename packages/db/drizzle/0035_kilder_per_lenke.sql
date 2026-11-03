DROP INDEX "field_source_entity_type_entity_id_field_source_label_index";--> statement-breakpoint
ALTER TABLE "field_source" ADD COLUMN "source_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "field_source" SET "source_key" = coalesce("source_url", '') WHERE "field" IN ('experience', 'expertise', 'industries');--> statement-breakpoint
CREATE UNIQUE INDEX "field_source_entity_type_entity_id_field_source_label_source_key_index" ON "field_source" USING btree ("entity_type","entity_id","field","source_label","source_key");