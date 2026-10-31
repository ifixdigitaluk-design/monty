-- Attachments follow their workspace; chat files additionally follow channel visibility (private channels, DMs).
ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY attachments_visibility ON attachments
  USING (
    app_is_system() OR (
      (workspace_id IN (SELECT app_user_member_workspace_ids()) OR organisation_id IN (SELECT app_user_admin_org_ids()))
      AND (channel_id IS NULL OR channel_id IN (SELECT app_user_visible_channel_ids()))
    )
  )
  WITH CHECK (
    app_is_system() OR (
      (workspace_id IN (SELECT app_user_member_workspace_ids()) OR organisation_id IN (SELECT app_user_admin_org_ids()))
      AND (channel_id IS NULL OR channel_id IN (SELECT app_user_visible_channel_ids()))
    )
  );
