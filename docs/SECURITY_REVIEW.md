# Internal security review — 31 Oct 2026

**This is not a penetration test.** It was carried out by the same engineer who wrote the code, using code review, automated tests and probes against a production-mode build. An independent penetration test by a qualified third party is still required before handling sensitive data or opening Monty to the public.

## Scope
API (NestJS), web app (Next.js), database (Postgres with row-level security), containers. Desktop shell excluded (it only loads the web app).

## Method
1. **Threat review** of each trust boundary: browser → web → API, API → Postgres, API → outbound (SMTP, webhooks, AI, error webhook).
2. **Automated regression tests** for each control. There are 160+ API tests and 20 Playwright flows; they run in CI on every PR.
3. **Probes** against a `NODE_ENV=production` build:
   - security headers and cookie flags;
   - cross-site request forgery (CSRF);
   - oversized and malformed bodies;
   - unknown routes;
   - rate limits;
   - startup guards.

## Findings and fixes in this round
| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | Sign-up revealed whether an email had an account (`409 EMAIL_TAKEN`) | Medium | **Fixed.** Sign-up always answers `202 check_email`, with no cookie and an identical body. The existing owner gets an "account exists" email instead, at most once per hour. Covered by `signup-mfa.e2e` and Playwright. |
| 2 | New accounts were usable before the email was proven, so someone could squat a colleague's address | Medium | **Fixed.** Password sign-in requires a confirmed email. The emailed link (48 h, single use) confirms the address and signs in. If someone squatted an address, the real owner gets the "account exists" email and can reclaim it with a password reset. |
| 3 | No second factor | Medium | **Fixed.** TOTP two-factor authentication: secret encrypted at rest, ±1 step tolerance, replay refused, 10 hashed single-use recovery codes, 5-minute challenges locked after 5 wrong codes. The email link never bypasses the second factor. |
| 4 | Password guessing spread over many IPs wasn't limited | Medium | **Fixed.** An account is locked for 15 minutes after 10 failures; a successful sign-in or reset clears the lock. This reveals that an account exists, but only after 10 wrong passwords. |
| 5 | Anyone on the internet could create an account | Low (internal tool) | **Mitigated.** `SIGNUP_MODE=invite` allows only the first account plus addresses with a pending invitation, and responses still don't differ. **Recommended for the staff pilot.** |
| 6 | A Postgres connection killed mid-transaction crashed the process | High | **Fixed earlier** (found by the first CI run) |

## Controls verified (unchanged, with tests)
- **Data isolation:**
  - Row-level security under a non-owner role, plus a startup refusal if it's ineffective.
  - Cross-tenant tests on every resource type, returning 404 rather than 403 so existence doesn't leak.
- **Sessions:** 256-bit opaque tokens, stored hashed; `__Host-` `Secure` `HttpOnly` `SameSite=Lax` cookies in production; revocation; password reset signs out every device.
- **CSRF:** a custom header plus an Origin allowlist on every mutation.
- **Input and output:**
  - Strict Zod schemas that reject unknown fields, and a 1 MB body limit.
  - Markdown is rendered without raw HTML, and links are limited to http(s)/mailto.
- **Outbound requests:**
  - Webhooks: HTTPS only, private IP ranges refused at connect time, no redirects, signed with HMAC.
  - The AI never acts without approval.
- **Secrets:** none in the repository or images; a full-history scan before the repo went public found none.
- **Dependencies:** `pnpm audit --prod` is clean.

## Known open items (accepted for an internal pilot)
- The CSP still allows `'unsafe-inline'` scripts, because Next.js needs them for its inline bootstrap. Nonces are planned.
- Rate limits are in memory per instance, so run one API instance or add Redis.
- There's no account-level alert email for new-device sign-ins.
- There's no independent penetration test.
- **File uploads (next feature) need their own review**: type checks, size limits, malware scanning (none available for free; uploads are served as attachments, never inline HTML).
