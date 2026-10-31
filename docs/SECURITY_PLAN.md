# Security Plan

No compliance or certification is claimed. Items marked ✅ are implemented in the Phase 1 slice and covered by tests; others are planned.

## 1. Authentication & sessions
- ✅ Argon2id password hashing (`@node-rs/argon2`), minimum 10 characters, max 200.
- ✅ Opaque 256-bit session tokens; only SHA-256 hash stored; 30-day sliding expiry; revocation; session list.
- ✅ Cookie: HttpOnly, SameSite=Lax, Secure in production, path `/`.
- ✅ Constant-time-ish login: same error for unknown email and wrong password; dummy hash when user missing.
- Planned: MFA (TOTP + WebAuthn) Phase 2; email verification + password reset Phase 2; enterprise SSO (SAML/OIDC) + SCIM Phase 5+.

## 2. Authorisation & tenant isolation
- ✅ Central permission function in `packages/domain` (role × action matrix), called by every service method.
- ✅ 404 for unreadable resources (no existence leak).
- ✅ Tenant columns + composite FKs.
- ✅ Automated cross-tenant tests (user B cannot read/modify user A's workspace/project/task).
- Planned: Postgres RLS as defence in depth (ADR-009).

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
- Planned: separate `AuditLog` for security/admin events (login, session revoke, role change, export).

## 7. Legal review before launch
UK GDPR / EU GDPR (lawful basis, DPA, sub-processors, data residency options), US state privacy laws, accessibility obligations. Requires qualified legal advice; not decided here.

## 8. Testing
Permission matrix unit tests; cross-tenant e2e; dependency audit (`pnpm audit`) in CI; external penetration test before GA (Phase 6).
