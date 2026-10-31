CREATE TABLE "login_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"used_at" timestamp (3) with time zone,
	CONSTRAINT "login_challenges_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "mfa_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp (3) with time zone
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_secret" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_enabled_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_last_step" integer;--> statement-breakpoint
ALTER TABLE "login_challenges" ADD CONSTRAINT "login_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mfa_recovery_user_idx" ON "mfa_recovery_codes" USING btree ("user_id");