CREATE TABLE "database_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"database_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "database_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"database_id" uuid NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"body_version" integer DEFAULT 1 NOT NULL,
	"position" double precision DEFAULT 0 NOT NULL,
	"created_by_id" uuid NOT NULL,
	"updated_by_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "database_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"database_id" uuid NOT NULL,
	"name" text NOT NULL,
	"layout" text DEFAULT 'table' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "databases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp (3) with time zone
);
--> statement-breakpoint
ALTER TABLE "database_fields" ADD CONSTRAINT "database_fields_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_fields" ADD CONSTRAINT "database_fields_workspace_org_fk" FOREIGN KEY ("workspace_id","organisation_id") REFERENCES "public"."workspaces"("id","organisation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_rows" ADD CONSTRAINT "database_rows_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_rows" ADD CONSTRAINT "database_rows_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_rows" ADD CONSTRAINT "database_rows_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_rows" ADD CONSTRAINT "database_rows_workspace_org_fk" FOREIGN KEY ("workspace_id","organisation_id") REFERENCES "public"."workspaces"("id","organisation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_views" ADD CONSTRAINT "database_views_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_views" ADD CONSTRAINT "database_views_workspace_org_fk" FOREIGN KEY ("workspace_id","organisation_id") REFERENCES "public"."workspaces"("id","organisation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "databases" ADD CONSTRAINT "databases_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "databases" ADD CONSTRAINT "databases_workspace_org_fk" FOREIGN KEY ("workspace_id","organisation_id") REFERENCES "public"."workspaces"("id","organisation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "database_fields_db_idx" ON "database_fields" USING btree ("database_id");--> statement-breakpoint
CREATE INDEX "database_rows_db_idx" ON "database_rows" USING btree ("database_id","position");--> statement-breakpoint
CREATE INDEX "database_views_db_idx" ON "database_views" USING btree ("database_id");--> statement-breakpoint
CREATE INDEX "databases_workspace_idx" ON "databases" USING btree ("workspace_id");