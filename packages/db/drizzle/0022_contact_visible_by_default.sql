-- Kontaktinfo fra kullisten vises for medlemmer som standard. Til nå har `false`
-- vært standarden, så det finnes ingen registrering av hvem som har valgt å
-- skjule noe. Profiler ingen har tatt i bruk, har ikke valgt: de blir synlige.
-- For profiler med konto som kom fra importen (kullisten/telefonlista) kan vi ikke
-- se om personen slo av synligheten med vilje eller bare lot standarden stå;
-- de blir synlige, og kan skjule feltet selv. Profiler fra egen registrering
-- skrev kontaktinfoen sin selv med bryterne av, og røres ikke.
ALTER TABLE "person" ALTER COLUMN "contact_email_visible" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "person" ALTER COLUMN "phone_visible" SET DEFAULT true;--> statement-breakpoint
UPDATE "person" SET "contact_email_visible" = true, "phone_visible" = true WHERE "user_id" IS NULL OR "source" = 'import';
