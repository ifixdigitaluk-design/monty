-- Row-level security for Phase 2a tables (see 0003 for the model).
ALTER TABLE milestones ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY milestones_isolation ON milestones
  USING (app_is_system() OR organisation_id IN (SELECT app_user_admin_org_ids()) OR workspace_id IN (SELECT app_user_member_workspace_ids()))
  WITH CHECK (app_is_system() OR organisation_id IN (SELECT app_user_admin_org_ids()) OR workspace_id IN (SELECT app_user_member_workspace_ids()));
--> statement-breakpoint
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY comments_isolation ON comments
  USING (app_is_system() OR organisation_id IN (SELECT app_user_admin_org_ids()) OR workspace_id IN (SELECT app_user_member_workspace_ids()))
  WITH CHECK (app_is_system() OR organisation_id IN (SELECT app_user_admin_org_ids()) OR workspace_id IN (SELECT app_user_member_workspace_ids()));
--> statement-breakpoint
-- Notifications: only the recipient can read or update them; anyone in the organisation may create them.
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY notifications_read ON notifications FOR SELECT USING (app_is_system() OR user_id = app_current_user_id());
--> statement-breakpoint
CREATE POLICY notifications_update ON notifications FOR UPDATE
  USING (app_is_system() OR user_id = app_current_user_id())
  WITH CHECK (app_is_system() OR user_id = app_current_user_id());
--> statement-breakpoint
CREATE POLICY notifications_delete ON notifications FOR DELETE USING (app_is_system() OR user_id = app_current_user_id());
--> statement-breakpoint
CREATE POLICY notifications_insert ON notifications FOR INSERT
  WITH CHECK (app_is_system() OR organisation_id IN (SELECT app_user_org_ids()));
