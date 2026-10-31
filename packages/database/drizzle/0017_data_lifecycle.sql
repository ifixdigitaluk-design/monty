ALTER TYPE "public"."user_token_purpose" ADD VALUE 'ACCOUNT_DELETION';--> statement-breakpoint
CREATE TABLE "data_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"content" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"download_token_hash" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"downloaded_at" timestamp (3) with time zone,
	CONSTRAINT "data_exports_download_token_hash_unique" UNIQUE("download_token_hash")
);
--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "deletion_requested_by_id" uuid;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "purge_after" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_exports_user_idx" ON "data_exports" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_deletion_requested_by_id_users_id_fk" FOREIGN KEY ("deletion_requested_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;