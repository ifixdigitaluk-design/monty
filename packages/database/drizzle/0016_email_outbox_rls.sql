-- Outbound email is only ever read or written by the server's mail worker (system context).
-- Request transactions (app.user_id set, app.system off) can neither read queued messages nor their recipients.
ALTER TABLE email_outbox ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY email_outbox_system ON email_outbox USING (app_is_system()) WITH CHECK (app_is_system());
--> statement-breakpoint
ALTER TABLE email_delivery_attempts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY email_delivery_attempts_system ON email_delivery_attempts USING (app_is_system()) WITH CHECK (app_is_system());
