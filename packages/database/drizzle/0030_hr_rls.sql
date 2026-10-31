-- HR records are visible at the database level only inside their organisation; the API applies the finer rules
-- (private details: the person, HR admins and their management chain).
ALTER TABLE hr_roles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY hr_roles_isolation ON hr_roles
  USING (app_is_system() OR organisation_id IN (SELECT app_user_org_ids()))
  WITH CHECK (app_is_system() OR organisation_id IN (SELECT app_user_org_ids()));
--> statement-breakpoint
ALTER TABLE hr_profiles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY hr_profiles_isolation ON hr_profiles
  USING (app_is_system() OR organisation_id IN (SELECT app_user_org_ids()))
  WITH CHECK (app_is_system() OR organisation_id IN (SELECT app_user_org_ids()));
--> statement-breakpoint
ALTER TABLE hr_leave_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY hr_leave_requests_isolation ON hr_leave_requests
  USING (app_is_system() OR organisation_id IN (SELECT app_user_org_ids()))
  WITH CHECK (app_is_system() OR organisation_id IN (SELECT app_user_org_ids()));
--> statement-breakpoint
ALTER TABLE hr_checklists ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY hr_checklists_isolation ON hr_checklists
  USING (app_is_system() OR organisation_id IN (SELECT app_user_org_ids()))
  WITH CHECK (app_is_system() OR organisation_id IN (SELECT app_user_org_ids()));
--> statement-breakpoint
ALTER TABLE hr_checklist_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY hr_checklist_items_isolation ON hr_checklist_items
  USING (app_is_system() OR organisation_id IN (SELECT app_user_org_ids()))
  WITH CHECK (app_is_system() OR organisation_id IN (SELECT app_user_org_ids()));
--> statement-breakpoint
ALTER TABLE hr_documents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY hr_documents_isolation ON hr_documents
  USING (app_is_system() OR organisation_id IN (SELECT app_user_org_ids()))
  WITH CHECK (app_is_system() OR organisation_id IN (SELECT app_user_org_ids()));
--> statement-breakpoint
ALTER TABLE hr_reviews ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY hr_reviews_isolation ON hr_reviews
  USING (app_is_system() OR organisation_id IN (SELECT app_user_org_ids()))
  WITH CHECK (app_is_system() OR organisation_id IN (SELECT app_user_org_ids()));
