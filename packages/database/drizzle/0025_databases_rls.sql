-- Databases follow their workspace, exactly like documents.
ALTER TABLE databases ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY databases_isolation ON databases
  USING (app_is_system() OR organisation_id IN (SELECT app_user_admin_org_ids()) OR workspace_id IN (SELECT app_user_member_workspace_ids()))
  WITH CHECK (app_is_system() OR organisation_id IN (SELECT app_user_admin_org_ids()) OR workspace_id IN (SELECT app_user_member_workspace_ids()));
--> statement-breakpoint
ALTER TABLE database_fields ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY database_fields_isolation ON database_fields
  USING (app_is_system() OR organisation_id IN (SELECT app_user_admin_org_ids()) OR workspace_id IN (SELECT app_user_member_workspace_ids()))
  WITH CHECK (app_is_system() OR organisation_id IN (SELECT app_user_admin_org_ids()) OR workspace_id IN (SELECT app_user_member_workspace_ids()));
--> statement-breakpoint
ALTER TABLE database_rows ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY database_rows_isolation ON database_rows
  USING (app_is_system() OR organisation_id IN (SELECT app_user_admin_org_ids()) OR workspace_id IN (SELECT app_user_member_workspace_ids()))
  WITH CHECK (app_is_system() OR organisation_id IN (SELECT app_user_admin_org_ids()) OR workspace_id IN (SELECT app_user_member_workspace_ids()));
--> statement-breakpoint
ALTER TABLE database_views ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY database_views_isolation ON database_views
  USING (app_is_system() OR organisation_id IN (SELECT app_user_admin_org_ids()) OR workspace_id IN (SELECT app_user_member_workspace_ids()))
  WITH CHECK (app_is_system() OR organisation_id IN (SELECT app_user_admin_org_ids()) OR workspace_id IN (SELECT app_user_member_workspace_ids()));
--> statement-breakpoint
ALTER TABLE database_rows ADD COLUMN search tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple', coalesce(title, '')), 'A') || setweight(to_tsvector('simple', coalesce(body, '')), 'B')
) STORED;
--> statement-breakpoint
CREATE INDEX database_rows_search_idx ON database_rows USING gin (search);
