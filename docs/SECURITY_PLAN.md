# Security Plan

No compliance or certification is claimed. Items marked ✅ are implemented in the Phase 1 slice and covered by tests; others are planned.

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
- ✅ Rate limiting (Nest throttler), stricter on auth.
- Planned: CSP nonces once editor embeds arrive.

## 4. Data protection
- TLS everywhere in production (terminated at load balancer); HSTS.
- Encryption at rest via managed Postgres/S3; application-level encryption (AES-256-GCM, key from KMS) for OAuth tokens and secrets (Phase 5).
- Attachments via short-lived pre-signed URLs after permission check (Phase 2).
- Secrets only in environment/secret manager; `.env` git-ignored; `.env.example` has no real values.
- Logs exclude passwords, tokens, document content.

## 5. AI security (Phase 4)
- Retrieval filtered by the same permission function before any content reaches a model.
- Workspace content is wrapped as untrusted data; system instructions are never derived from it; tool calls validated by schema and permission.
- Destructive/external actions require explicit user approval; all AI actions audited with before/after.
- No customer data used for model training; provider DPAs reviewed.

## 6. Audit
- ✅ Product activity events for project/task changes.
- ✅ Separate `audit_logs` table for security and admin events, written in the same transaction as the change. Covers register, login, failed login, logout, session revoke, org/workspace create, invitation create/revoke/accept, role change, member removal/leave, and workspace access changes. Records IP and user agent; no tokens or passwords. Failed logins store an email only when it matches a real account.
- ✅ Invitations: 256-bit one-time tokens stored as SHA-256, 7-day expiry, bound to the invited email address, rate-limited preview and accept, single use, revocable.
- ✅ Ownership safeguards: last-owner protection with row locks (tested under concurrency); admins can't grant or remove ownership.

## 7. Legal review before launch
UK GDPR / EU GDPR (lawful basis, DPA, sub-processors, data residency options), US state privacy laws, accessibility obligations. Requires qualified legal advice; not decided here.

## 8. Testing
Permission matrix unit tests; cross-tenant e2e; dependency audit (`pnpm audit`) in CI; external penetration test before GA (Phase 6).
