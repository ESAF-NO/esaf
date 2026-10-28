CREATE TYPE "public"."company_status" AS ENUM('active', 'acquired', 'closed');--> statement-breakpoint
CREATE TABLE "company" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"alias_slugs" text[] DEFAULT '{}'::text[] NOT NULL,
	"tagline" text,
	"description" text,
	"website" text,
	"founded_year" integer,
	"location" text,
	"industries" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "company_status" DEFAULT 'active' NOT NULL,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_slug_unique" UNIQUE("slug"),
	CONSTRAINT "company_founded_year_range" CHECK ("company"."founded_year" is null or "company"."founded_year" between 1800 and 2100)
);
--> statement-breakpoint
-- Uten NOT NULL til eksisterende rader er koblet (se under).
ALTER TABLE "experience" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "es_company_id" uuid;--> statement-breakpoint
ALTER TABLE "experience" ADD CONSTRAINT "experience_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_es_company_id_company_id_fk" FOREIGN KEY ("es_company_id") REFERENCES "public"."company"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "experience_company_id_index" ON "experience" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "person_es_company_id_index" ON "person" USING btree ("es_company_id");--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- HÅNDSKREVET (selskaper): selskaper fra dagens navn i erfaring og ES-selskap.
-- Kjøres etter at "company" og de nye kolonnene finnes, og før tekstkolonnene
-- "experience"."company" og "person"."es_company" fjernes. "company_id" legges
-- til uten NOT NULL over og får det til slutt her, når alle rader er koblet.
-- ---------------------------------------------------------------------------
-- Samme regel som companySlug i @esaf/core, så navnene samles slik appen gjør.
-- lower() med pg_c_utf8 gir samme små bokstaver uansett databasens locale.
-- Navn uten latinske bokstaver eller tall får en slug avledet av navnet.
-- Funksjonen beholdes, så en test kan sjekke at den gir samme svar som appen.
CREATE FUNCTION "company_slug"("name" text) RETURNS text
	LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
	RETURN coalesce(
		nullif(
			regexp_replace(
				regexp_replace(
					replace(replace(regexp_replace(normalize(lower("name" COLLATE "pg_c_utf8"), NFD), '[̀-ͯ]', '', 'g'), 'ø', 'o'), 'æ', 'ae'),
					'[^a-z0-9]+', '-', 'g'),
				'^-|-$', '', 'g'),
			''),
		'selskap-' || left(md5(lower(btrim("name") COLLATE "pg_c_utf8")), 8)
	);--> statement-breakpoint
COMMENT ON FUNCTION "company_slug"(text) IS 'Samme regel som companySlug i @esaf/core.';--> statement-breakpoint
-- Ett selskap per slug. Skrivemåten som er brukt flest ganger blir navnet; ved
-- likt antall vinner den som ble lagt inn først. Tomme navn får ikke selskap.
INSERT INTO "company" ("slug", "name")
SELECT DISTINCT ON ("slug") "slug", "name"
FROM (
	SELECT company_slug("name") AS "slug", btrim("name") AS "name", count(*) AS "uses", min("created_at") AS "first_used"
	FROM (
		SELECT "company" AS "name", "created_at" FROM "experience"
		UNION ALL
		SELECT "es_company", "created_at" FROM "person" WHERE "es_company" IS NOT NULL
	) AS "named"
	WHERE btrim("name") <> ''
	GROUP BY 1, 2
) AS "spellings"
ORDER BY "slug", "uses" DESC, "first_used", "name";--> statement-breakpoint
UPDATE "experience" SET "company_id" = "company"."id"
FROM "company" WHERE "company"."slug" = company_slug("experience"."company");--> statement-breakpoint
UPDATE "person" SET "es_company_id" = "company"."id"
FROM "company" WHERE "company"."slug" = company_slug("person"."es_company");--> statement-breakpoint
-- Feiler (og hele migreringen rulles tilbake) hvis en erfaring ikke fikk selskap.
ALTER TABLE "experience" ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint
-- SLUTT HÅNDSKREVET (selskaper)
ALTER TABLE "experience" DROP COLUMN "company";--> statement-breakpoint
ALTER TABLE "person" DROP COLUMN "es_company";
