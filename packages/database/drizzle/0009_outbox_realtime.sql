ALTER TABLE "outbox_events" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "actor_id" uuid;--> statement-breakpoint
CREATE INDEX "outbox_workspace_idx" ON "outbox_events" USING btree ("workspace_id","created_at");