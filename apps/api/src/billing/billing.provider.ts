/**
 * Replaceable payment-provider boundary (Stripe, Paddle, Chargebee, …). Not implemented: no provider has been
 * chosen and no credentials exist. When one is, implement this interface, verify webhook signatures, and update
 * `organisations.plan` only from verified webhook events — never from the browser.
 */
export interface BillingProvider {
  createCheckoutSession(organisationId: string, plan: string, returnUrl: string): Promise<{ url: string }>;
  createPortalSession(organisationId: string, returnUrl: string): Promise<{ url: string }>;
  /** Verifies the signature and returns the plan change to apply, or null to ignore the event. */
  parseWebhook(rawBody: Buffer, signatureHeader: string): Promise<{ organisationId: string; plan: string } | null>;
}
