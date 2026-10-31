CREATE TABLE "meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"starts_at" timestamp (3) with time zone NOT NULL,
	"duration_minutes" integer DEFAULT 30 NOT NULL,
	"video_url" text DEFAULT '' NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"agenda" text DEFAULT '' NOT NULL,
	"minutes" text DEFAULT '' NOT NULL,
	"attendee_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"action_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"organizer_id" uuid NOT NULL,
	"cancelled_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_organizer_id_users_id_fk" FOREIGN KEY ("organizer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_workspace_org_fk" FOREIGN KEY ("workspace_id","organisation_id") REFERENCES "public"."workspaces"("id","organisation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meetings_ws_start_idx" ON "meetings" USING btree ("workspace_id","starts_at");