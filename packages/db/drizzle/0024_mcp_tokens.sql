CREATE TABLE "api_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"read_only" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_token_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "audit_event" ADD COLUMN "api_token_id" uuid DEFAULT nullif(current_setting('esaf.api_token_id', true), '')::uuid;--> statement-breakpoint
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_token_user_id_index" ON "api_token" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_api_token_id_api_token_id_fk" FOREIGN KEY ("api_token_id") REFERENCES "public"."api_token"("id") ON DELETE set null ON UPDATE no action;