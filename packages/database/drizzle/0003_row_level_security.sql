-- Row-level security (ADR-009, backlog B-03): defence in depth behind the API's permission checks.
--
-- Model:
--   * Migrations run as the schema owner. The owner bypasses RLS (it is ENABLED, not FORCED).
--   * The API connects as the non-owner role `monty_app` (NOBYPASSRLS), so every query it runs is filtered.
--   * Each authenticated request runs in one transaction with `app.user_id` set (SET LOCAL semantics).
--   * A few explicitly marked system operations (invitation preview/accept by token) set `app.system = on`.
--   * Membership tables are the source of truth for these checks and are not themselves row-filtered.

-- ---------- helpers ----------
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_is_system() RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('app.system', true), '') = 'on' $$;
--> statement-breakpoint
-- Organisations the current user belongs to.
CREATE OR REPLACE FUNCTION app_user_org_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT m.organisation_id FROM organisation_memberships m WHERE m.user_id = app_current_user_id()
  $$;
--> statement-breakpoint
-- Organisations where the current user is OWNER or ADMIN (they reach every workspace in them).
CREATE OR REPLACE FUNCTION app_user_admin_org_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT m.organisation_id FROM organisation_memberships m
    WHERE m.user_id = app_current_user_id() AND m.role IN ('OWNER', 'ADMIN')
  $$;
--> statement-breakpoint
-- Workspaces the current user was explicitly added to, while still a member of the organisation.
CREATE OR REPLACE FUNCTION app_user_member_workspace_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT wm.workspace_id FROM workspace_memberships wm
    JOIN workspaces w ON w.id = wm.workspace_id
    JOIN organisation_memberships om ON om.organisation_id = w.organisation_id AND om.user_id = wm.user_id
    WHERE wm.user_id = app_current_user_id()
  $$;
--> statement-breakpoint
-- Workspace access mirrors effectiveWorkspaceRole() in packages/domain:
--   org OWNER/ADMIN → every workspace in the org; anyone else → explicit workspace membership.
-- Policies use these two functions (never a lookup of the row being written), so INSERT ... RETURNING
-- works within the same statement.
REVOKE ALL ON FUNCTION app_user_org_ids() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_user_admin_org_ids() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_user_member_workspace_ids() FROM PUBLIC;
--> statement-breakpoint

-- ---------- workspace-scoped content ----------
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspaces_isolation ON workspaces
  USING (app_is_system() OR organisation_id IN (SELECT app_user_admin_org_ids()) OR id IN (SELECT app_user_member_workspace_ids()))
  WITH CHECK (app_is_system() OR organisation_id IN (SELECT app_user_admin_org_ids()));
--> statement-breakpoint
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY projects_isolation ON projects
  USING (app_is_system() OR organisation_id IN (SELECT app_user_admin_org_ids()) OR workspace_id IN (SELECT app_user_member_workspace_ids()))
  WITH CHECK (app_is_system() OR organisation_id IN (SELECT app_user_admin_org_ids()) OR workspace_id IN (SELECT app_user_member_workspace_ids()));
--> statement-breakpoint
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tasks_isolation ON tasks
  USING (app_is_system() OR organisation_id IN (SELECT app_user_admin_org_ids()) OR workspace_id IN (SELECT app_user_member_workspace_ids()))
  WITH CHECK (app_is_system() OR organisation_id IN (SELECT app_user_admin_org_ids()) OR workspace_id IN (SELECT app_user_member_workspace_ids()));
--> statement-breakpoint

-- ---------- organisation-scoped content ----------
ALTER TABLE task_dependencies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY task_dependencies_isolation ON task_dependencies
  USING (app_is_system() OR organisation_id IN (SELECT app_user_org_ids()))
  WITH CHECK (app_is_system() OR organisation_id IN (SELECT app_user_org_ids()));
--> statement-breakpoint
ALTER TABLE activity_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY activity_events_isolation ON activity_events
  USING (app_is_system() OR organisation_id IN (SELECT app_user_org_ids()))
  WITH CHECK (app_is_system() OR organisation_id IN (SELECT app_user_org_ids()));
--> statement-breakpoint
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY outbox_events_isolation ON outbox_events
  USING (app_is_system() OR organisation_id IN (SELECT app_user_org_ids()))
  WITH CHECK (app_is_system() OR organisation_id IN (SELECT app_user_org_ids()));
--> statement-breakpoint
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY invitations_isolation ON invitations
  USING (app_is_system() OR organisation_id IN (SELECT app_user_org_ids()))
  WITH CHECK (app_is_system() OR organisation_id IN (SELECT app_user_org_ids()));
--> statement-breakpoint
-- Account-level audit rows (no organisation) are visible only to the user they are about.
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY audit_logs_isolation ON audit_logs
  USING (
    app_is_system()
    OR organisation_id IN (SELECT app_user_org_ids())
    OR (organisation_id IS NULL AND actor_id = app_current_user_id())
  )
  WITH CHECK (app_is_system() OR organisation_id IS NULL OR organisation_id IN (SELECT app_user_org_ids()));
--> statement-breakpoint

-- ---------- runtime role grants ----------
-- The role is created by infrastructure (infra/db/create-app-role.sql), not by migrations.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'monty_app') THEN
    GRANT USAGE ON SCHEMA public TO monty_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO monty_app;
    GRANT EXECUTE ON FUNCTION app_current_user_id(), app_is_system(), app_user_org_ids(), app_user_admin_org_ids(), app_user_member_workspace_ids() TO monty_app;
    -- Tables added by later migrations (created by this same owner) are granted automatically.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO monty_app;
  ELSE
    RAISE WARNING 'Role monty_app does not exist: create it (infra/db/create-app-role.sql) and re-run grants before starting the API.';
  END IF;
END $$;
