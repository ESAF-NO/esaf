ALTER TABLE "cohort" RENAME COLUMN "start_year" TO "graduation_year";--> statement-breakpoint
ALTER TABLE "cohort" DROP CONSTRAINT "cohort_startYear_unique";--> statement-breakpoint
ALTER TABLE "cohort" DROP CONSTRAINT "cohort_start_year_range";--> statement-breakpoint
-- Kull var lagret med opptaksår. ES navngir kull etter uteksamineringsåret, to år senere.
-- Gjøres før unik-kravet legges på igjen, så +2 ikke kolliderer underveis.
UPDATE "cohort" SET "graduation_year" = "graduation_year" + 2;--> statement-breakpoint
ALTER TABLE "cohort" ADD CONSTRAINT "cohort_graduationYear_unique" UNIQUE("graduation_year");--> statement-breakpoint
ALTER TABLE "cohort" ADD CONSTRAINT "cohort_graduation_year_range" CHECK ("cohort"."graduation_year" between 1990 and 2100);