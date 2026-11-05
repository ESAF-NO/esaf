ALTER TABLE "comment_reaction" DROP CONSTRAINT "comment_reaction_comment_id_person_id_kind_pk";--> statement-breakpoint
ALTER TABLE "comment_reaction" ALTER COLUMN "kind" SET DATA TYPE text USING (
	CASE "kind"
		WHEN 'like' THEN U&'\+01F44D'
		WHEN 'heart' THEN U&'\2764\FE0F'
		WHEN 'laugh' THEN U&'\+01F602'
		WHEN 'party' THEN U&'\+01F389'
		WHEN 'eyes' THEN U&'\+01F440'
	END
);--> statement-breakpoint
ALTER TABLE "comment_reaction" RENAME COLUMN "kind" TO "emoji";--> statement-breakpoint
ALTER TABLE "comment_reaction" ADD CONSTRAINT "comment_reaction_comment_id_person_id_emoji_pk" PRIMARY KEY("comment_id","person_id","emoji");--> statement-breakpoint
DROP TYPE "public"."comment_reaction_kind";
