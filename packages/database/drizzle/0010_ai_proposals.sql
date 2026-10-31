CREATE TYPE "public"."ai_proposal_status" AS ENUM('PENDING', 'APPLIED', 'REJECTED');--> statement-breakpoint
CREATE TABLE "ai_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" "ai_proposal_status" DEFAULT 'PENDING' NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"requested_by_id" uuid NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb NOT NULL,
	"decided_by_id" uuid,
	"decided_at" timestamp (3) with time zone,
	"applied_entity_ids" jsonb,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_proposals" ADD CONSTRAINT "ai_proposals_requested_by_id_users_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_proposals" ADD CONSTRAINT "ai_proposals_decided_by_id_users_id_fk" FOREIGN KEY ("decided_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_proposals" ADD CONSTRAINT "ai_proposals_project_workspace_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."projects"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_proposals_project_idx" ON "ai_proposals" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_proposals_org_idx" ON "ai_proposals" USING btree ("organisation_id","created_at");