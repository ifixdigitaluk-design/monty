# Data lifecycle: retention, export and deletion

These are the engineering rules Monty implements. **They aren't legal advice, and implementing them doesn't make Monty GDPR-compliant.** A qualified privacy professional must review them, together with the privacy policy, terms, data processing agreement and sub-processor list, before launch.

## 1. Who owns what
| Data | Controller of the record | Why |
|---|---|---|
| Account (email, name, password hash, sessions, security log) | The individual user | Personal account data |
| Personal space (its projects, tasks, documents, comments) | The individual user | Only they can access it |
| Team organisation content (projects, tasks, documents, comments, automations, activity) | The organisation | Shared work product; other members depend on it |
| Organisation audit log | The organisation | Security and accountability record for its admins |

## 2. Personal data export (`POST /me/exports`)
- **Contents.** The account itself, sessions, organisation and workspace memberships, and projects, tasks, comments and documents the user created or was assigned in organisations they **currently** belong to. Also notifications, AI requests, automations they authored, and their own security log.
- **What it leaves out.** Other people's content, and organisations the user has left.
- **Built under RLS.** The export is generated inside the user's row-level-security context, so it can't include rows they can't see. The account-level security log is read separately, filtered strictly by `actor_id = user`.
- **Storage.** Gzip, then AES-256-GCM encrypted (`DATA_ENCRYPTION_KEY`), bound to the export id. Kept in the database, so there are no files on container disks.
- **Downloading.** You need **both** the owner's session **and** a random token that is shown once. Links expire after **24 hours**. Responses are sent with `Cache-Control: no-store`.
- **Limits and audit.** One export per 10 minutes. Creating and downloading an export are both audited.
- **Cleanup.** Expired exports are purged hourly.

## 3. Account deletion
1. **Request** (`POST /me/deletion-request`). Requires the current password. This sends a single-use link that expires after **1 hour**.
2. **Blocked** with 409 while the user is the **only owner of a team organisation that has other members**. They must first make another member an owner, or delete the organisation.
3. **Confirm** (`POST /me/deletion-confirm`). Requires the **same signed-in account**, the emailed token, and the typed word `DELETE`. Needing the token as well as the session means a stolen session alone can't delete an account.
4. **Erasure.** One database transaction, all or nothing:
   - **Erased completely:**
     - The personal space.
     - Team organisations where the user is the only member, along with all of their content.
     - Memberships, notifications, sessions, email tokens, data exports, and queued emails to their address.
     - Pending invitations to their address.
     - Account-level security events, such as sign-ins and password resets.
   - **Kept but de-identified:** in shared organisations, tasks, comments, documents and activity stay with the organisation and show "Deleted user".
     - Tasks assigned to the user become unassigned.
     - Automation rules they wrote are switched off.
     - Organisation audit entries keep the action and a pseudonymous id, but lose IP address, user agent and any copy of the email address.
   - **Tombstone:** the user row stays only so authorship links still work. Email becomes `deleted-<id>@deleted.invalid`, the name becomes "Deleted user", there is no usable password, and `deleted_at` is set. One `account.deleted` audit event is kept with no personal data.
5. **No recovery.** Deletion can't be undone. The email address can be used for a new account straight away.

**Residual personal data, which reviewers must decide on:**
- Text that other people wrote about the user inside shared content, such as a comment mentioning them by name. This belongs to the organisation's records and is not edited.
- Database backups, which keep deleted data until they expire. Backup retention is set by the hosting provider (target: 30 days) and must be stated in the privacy policy.
- Application logs, which contain request paths, IP addresses and user ids, but never tokens, passwords or email bodies. Log retention is set by the log platform (target: 30 days).

## 4. Organisations
- **Rename.** Owners and admins (`PATCH /organisations/:id`). Audited with the old and new name.
- **Deletion.**
  - Owner only, and only for team organisations. The personal space is deleted together with the account.
  - Requires typing the organisation's exact name and the owner's password.
  - Is **scheduled**:
    - The organisation becomes inaccessible to everyone immediately.
    - Members are emailed.
    - Owners can **restore** it for **30 days** from Account & data.
  - After the grace period, the hourly maintenance job **erases it permanently**: workspaces, projects, tasks, milestones, dependencies, comments, documents and their versions, notifications, AI proposals, automations and their runs, activity, outbox events and the organisation's own audit log.
  - A content-free `organisation.purged` record (id only) remains.
  - There are no uploaded files yet. When attachments arrive, object-storage deletion must join this purge.
- **People keep their accounts** when an organisation is deleted.

## 5. Retention summary
| Data | Retention |
|---|---|
| Account and content | Until the user or organisation deletes it |
| Sessions | 30 days sliding; expired or revoked records purged 30 days later |
| Email tokens | Up to 7 days valid (reset links: 1 h); purged 7 days after use or expiry |
| Queued emails | Body wiped on delivery or final failure; metadata purged after 30 days |
| Data exports | 24 hours |
| Live-update outbox | 7 days |
| Automation run log | 90 days |
| Activity history and organisation audit log | For the organisation's lifetime (accountability) — **retention period to be confirmed by legal review** |
| Account-level security events | For the account's lifetime; deleted with the account |
| Scheduled-deletion organisations | 30 days, then erased |

## 6. Tests
- `apps/api/test/data-lifecycle.e2e.test.ts` covers:
  - Export isolation, encryption at rest, the token plus session requirement, expiry and purge.
  - Deletion blockers and ownership transfer.
  - Full erasure and anonymisation, including audit scrubbing.
  - Single-use and expiring confirmation.
  - Solo-organisation erasure.
  - Rename and delete permissions.
  - Scheduling, restore and purge cascades.
- `e2e/tests/data-lifecycle.spec.ts` runs the same flows in a browser.
