-- CRM records follow their workspace.
ALTER TABLE crm_companies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY crm_companies_isolation ON crm_companies
  USING (app_is_system() OR organisation_id IN (SELECT app_user_admin_org_ids()) OR workspace_id IN (SELECT app_user_member_workspace_ids()))
  WITH CHECK (app_is_system() OR organisation_id IN (SELECT app_user_admin_org_ids()) OR workspace_id IN (SELECT app_user_member_workspace_ids()));
--> statement-breakpoint
ALTER TABLE crm_contacts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY crm_contacts_isolation ON crm_contacts
  USING (app_is_system() OR organisation_id IN (SELECT app_user_admin_org_ids()) OR workspace_id IN (SELECT app_user_member_workspace_ids()))
  WITH CHECK (app_is_system() OR organisation_id IN (SELECT app_user_admin_org_ids()) OR workspace_id IN (SELECT app_user_member_workspace_ids()));
--> statement-breakpoint
ALTER TABLE crm_deals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY crm_deals_isolation ON crm_deals
  USING (app_is_system() OR organisation_id IN (SELECT app_user_admin_org_ids()) OR workspace_id IN (SELECT app_user_member_workspace_ids()))
  WITH CHECK (app_is_system() OR organisation_id IN (SELECT app_user_admin_org_ids()) OR workspace_id IN (SELECT app_user_member_workspace_ids()));
--> statement-breakpoint
ALTER TABLE crm_activities ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY crm_activities_isolation ON crm_activities
  USING (app_is_system() OR organisation_id IN (SELECT app_user_admin_org_ids()) OR workspace_id IN (SELECT app_user_member_workspace_ids()))
  WITH CHECK (app_is_system() OR organisation_id IN (SELECT app_user_admin_org_ids()) OR workspace_id IN (SELECT app_user_member_workspace_ids()));
--> statement-breakpoint
ALTER TABLE crm_quotes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY crm_quotes_isolation ON crm_quotes
  USING (app_is_system() OR organisation_id IN (SELECT app_user_admin_org_ids()) OR workspace_id IN (SELECT app_user_member_workspace_ids()))
  WITH CHECK (app_is_system() OR organisation_id IN (SELECT app_user_admin_org_ids()) OR workspace_id IN (SELECT app_user_member_workspace_ids()));
--> statement-breakpoint
ALTER TABLE crm_companies ADD COLUMN search tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(name || ' ' || website || ' ' || industry || ' ' || notes, ''))) STORED;
--> statement-breakpoint
CREATE INDEX crm_companies_search_idx ON crm_companies USING gin (search);
--> statement-breakpoint
ALTER TABLE crm_contacts ADD COLUMN search tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(name || ' ' || email || ' ' || job_title || ' ' || notes, ''))) STORED;
--> statement-breakpoint
CREATE INDEX crm_contacts_search_idx ON crm_contacts USING gin (search);
--> statement-breakpoint
ALTER TABLE crm_deals ADD COLUMN search tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(title || ' ' || notes, ''))) STORED;
--> statement-breakpoint
CREATE INDEX crm_deals_search_idx ON crm_deals USING gin (search);
