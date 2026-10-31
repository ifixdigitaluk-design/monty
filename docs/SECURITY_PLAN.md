# Security Plan

No compliance or certification is claimed. Items marked ✅ are implemented and covered by automated tests; others are planned. No external security review or penetration test has been performed.

## 1. Authentication & sessions
- ✅ Argon2id password hashing (`@node-rs/argon2`), minimum 10 characters, max 200.
- ✅ Opaque 256-bit session tokens; only SHA-256 hash stored; 30-day sliding expiry; revocation; session list.
- ✅ Cookie: HttpOnly, SameSite=Lax, Secure in production, path `/`.
- ✅ Constant-time-ish login: same error for unknown email and wrong password; dummy hash when user missing.
- ✅ Password reset:
  - The response is identical whether or not the account exists, and the email is sent asynchronously so response time doesn't reveal it either.
  - Links last 1 hour, work once, are stored hashed, and only the newest one works.
  - A link is bound to the account email at the time it was sent.
  - A successful reset revokes every session and is audited.
- ✅ Email verification: sent at sign-up, can be resent, valid for 7 days, works once. A successful password reset also counts as verification.
- ✅ Email templates HTML-escape every user-controlled value. Logs record the recipient domain and email type only, never links.
- Known trade-off: sign-up returns `EMAIL_TAKEN`, which reveals that an account exists. Revisit with CAPTCHA or rate limits before public launch.
- Planned: MFA (TOTP + WebAuthn) Phase 2; enterprise SSO (SAML/OIDC) + SCIM Phase 5+.

## 2. Authorisation & tenant isolation
- ✅ Central permission function in `packages/domain` (role × action matrix), called by every service method.
- ✅ 404 for unreadable resources (no existence leak).
- ✅ Tenant columns + composite FKs.
- ✅ Automated cross-tenant tests (user B cannot read/modify user A's workspace/project/task).
- ✅ Postgres row-level security as defence in depth (ADR-009). The API runs as a restricted role and refuses to start if RLS wouldn't apply. Tests run as that role and include SQL-level isolation tests and a simulated "missing permission check" test.

## 3. Web protections
- ✅ CSRF: SameSite=Lax + required `X-Monty-Client` header on mutations + Origin allowlist.
- ✅ Helmet security headers on API; Next.js headers (CSP, frame-ancestors none, referrer policy) on web.
- ✅ Input validation with Zod on every body; unknown fields rejected.
- ✅ Output encoding: React escapes by default; no `dangerouslySetInnerHTML`.
- ✅ Rate limiting (Nest throttler), stricter on auth. In memory per instance and keyed by IP: users behind one NAT share limits (seen in the load test on search, 120/min), and limits don't add up across instances. A shared store (Redis) is needed before horizontal scaling.
- Planned: CSP nonces once editor embeds arrive.

## 4. Data protection
- TLS everywhere in production (terminated at load balancer); HSTS.
- Encryption at rest via managed Postgres/S3; application-level encryption (AES-256-GCM, key from KMS) for OAuth tokens and secrets (Phase 5).
- Attachments via short-lived pre-signed URLs after permission check (Phase 2).
- Secrets only in environment/secret manager; `.env` git-ignored; `.env.example` has no real values.
- Logs exclude passwords, tokens, document content.

## 4b. Encryption at rest and data lifecycle (session 5)
- ✅ Queued emails (which contain one-time links) and personal data exports are AES-256-GCM encrypted with `DATA_ENCRYPTION_KEY` (required in production, 32 bytes), with the row id/idempotency key as authenticated data. Email bodies are wiped once delivery is final.
- ✅ Exports need the owner's session **and** a one-time token; 24 h expiry; `no-store`; isolation tested against other users.
- ✅ Account deletion needs the password, then an emailed single-use link opened in the same signed-in account; erasure is one transaction and scrubs IP/user agent/email from audit entries (DATA_LIFECYCLE.md).
- ✅ Organisation deletion is owner-only with name + password confirmation and a 30-day restore window.
- ✅ Production refuses insecure SMTP TLS settings and non-HTTPS error webhooks; `/metrics` requires a ≥ 24-character bearer token (constant-time comparison) and exposes no identifiers.
- Key management: rotating `DATA_ENCRYPTION_KEY` is not implemented (ciphertexts carry a `v1` prefix for that). Losing the key makes queued emails and pending exports unreadable (they fail safely; users resend/re-export).

## 5. AI security (Phase 4)
- ✅ Context sent to a provider is limited to the requesting user's permitted project (permission check before assembly).
- ✅ Workspace content is wrapped in `<project_data>` and declared untrusted in the system prompt; provider output must match a strict Zod schema (unknown fields, bad indexes and oversize values rejected).
- ✅ Nothing changes without approval: output is stored as a PENDING proposal; applying is permission-checked, row-locked (no double apply) and audited (`ai.plan_proposed/applied/rejected`).
- ✅ Default provider is a local deterministic planner, so no data leaves the server unless `AI_PROVIDER=anthropic` is configured.
- Not verified: behaviour against the real Anthropic API (no key in this environment); red-team prompt-injection suite.
- Before enabling a hosted provider: review its data-processing terms (training opt-out, retention, region).

## 5b. Automations and webhooks (Phase 5)
- ✅ Only workspace admins create rules; rules act as their author and are skipped if the author is no longer an admin.
- ✅ Automation-made changes are tagged in the database transaction (`app.origin`) and never re-trigger rules (no loops); runs are idempotent per (rule, event).
- ✅ Webhooks: HTTPS only; destination IPs checked at connect time against private, loopback, link-local, CGNAT, multicast and documentation ranges (IPv4 and IPv6, incl. IPv4-mapped), which also blocks DNS rebinding; no redirects; 5 s timeout; HMAC-SHA256 signature with timestamp. Webhook secrets are visible only to workspace admins.

## 6. Audit
- ✅ Product activity events for project/task changes.
- ✅ Separate `audit_logs` table for security and admin events, written in the same transaction as the change. Covers register, login, failed login, logout, session revoke, org/workspace create, invitation create/revoke/accept, role change, member removal/leave, and workspace access changes. Records IP and user agent; no tokens or passwords. Failed logins store an email only when it matches a real account.
- ✅ Invitations: 256-bit one-time tokens stored as SHA-256, 7-day expiry, bound to the invited email address, rate-limited preview and accept, single use, revocable.
- ✅ Ownership safeguards: last-owner protection with row locks (tested under concurrency); admins can't grant or remove ownership.

## 7. Legal review before launch
UK GDPR / EU GDPR (lawful basis, DPA, sub-processors, data residency options), US state privacy laws, accessibility obligations. Requires qualified legal advice; not decided here.

## 8. Testing
Permission matrix unit tests; cross-tenant e2e; RLS guard test; SSRF unit tests; dependency audit (`pnpm audit --prod`, clean on 31 Oct 2026). **Required before GA, not done**: external penetration test, review of the CSP (`'unsafe-inline'` remains for Next.js scripts), and a decision on sign-up enumeration.
