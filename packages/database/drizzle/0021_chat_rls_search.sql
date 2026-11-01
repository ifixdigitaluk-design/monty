-- Team chat: row-level security that follows channel visibility, not just workspace membership.
-- Public channels: visible to everyone with access to the workspace. Private channels and direct messages:
-- visible only to their members (who must still have access to the workspace).
CREATE OR REPLACE FUNCTION app_user_visible_channel_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id FROM channels c
   WHERE c.kind = 'public'
     AND (c.workspace_id IN (SELECT app_user_member_workspace_ids()) OR c.organisation_id IN (SELECT app_user_admin_org_ids()))
  UNION
  SELECT cm.channel_id FROM channel_members cm
   WHERE cm.user_id = app_current_user_id()
     AND (cm.workspace_id IN (SELECT app_user_member_workspace_ids()) OR cm.organisation_id IN (SELECT app_user_admin_org_ids()))
$$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'monty_app') THEN
    GRANT EXECUTE ON FUNCTION app_user_visible_channel_ids() TO monty_app;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE channels ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY channels_visibility ON channels
  USING (app_is_system() OR id IN (SELECT app_user_visible_channel_ids()))
  WITH CHECK (app_is_system() OR workspace_id IN (SELECT app_user_member_workspace_ids()) OR organisation_id IN (SELECT app_user_admin_org_ids()));
--> statement-breakpoint
ALTER TABLE channel_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY channel_members_visibility ON channel_members
  USING (app_is_system() OR user_id = app_current_user_id() OR channel_id IN (SELECT app_user_visible_channel_ids()))
  WITH CHECK (app_is_system() OR workspace_id IN (SELECT app_user_member_workspace_ids()) OR organisation_id IN (SELECT app_user_admin_org_ids()));
--> statement-breakpoint
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY messages_visibility ON messages
  USING (app_is_system() OR channel_id IN (SELECT app_user_visible_channel_ids()))
  WITH CHECK (app_is_system() OR channel_id IN (SELECT app_user_visible_channel_ids()));
--> statement-breakpoint
ALTER TABLE message_reactions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY message_reactions_visibility ON message_reactions
  USING (app_is_system() OR EXISTS (SELECT 1 FROM messages m WHERE m.id = message_reactions.message_id))
  WITH CHECK (app_is_system() OR EXISTS (SELECT 1 FROM messages m WHERE m.id = message_reactions.message_id));
--> statement-breakpoint
ALTER TABLE messages ADD COLUMN search tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(body, ''))) STORED;
--> statement-breakpoint
CREATE INDEX messages_search_idx ON messages USING gin (search);
