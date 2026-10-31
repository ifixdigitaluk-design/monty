ALTER TABLE ai_proposals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY ai_proposals_isolation ON ai_proposals
  USING (app_is_system() OR organisation_id IN (SELECT app_user_admin_org_ids()) OR workspace_id IN (SELECT app_user_member_workspace_ids()))
  WITH CHECK (app_is_system() OR organisation_id IN (SELECT app_user_admin_org_ids()) OR workspace_id IN (SELECT app_user_member_workspace_ids()));
