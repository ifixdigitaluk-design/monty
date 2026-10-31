-- A user can only ever see their own exports; the maintenance job (system) purges expired ones.
ALTER TABLE data_exports ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY data_exports_owner ON data_exports
  USING (app_is_system() OR user_id = app_current_user_id())
  WITH CHECK (app_is_system() OR user_id = app_current_user_id());
