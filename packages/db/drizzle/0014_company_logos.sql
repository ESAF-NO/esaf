ALTER TABLE "company" ADD COLUMN "logo_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "company_logo_key_index" ON "company" USING btree ("logo_key");