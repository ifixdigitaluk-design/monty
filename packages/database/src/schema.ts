/**
 * Monty database schema (Drizzle ORM). See docs/DATABASE_SCHEMA.md for intent and rules.
 * Migrations are generated from this file with drizzle-kit and committed under /drizzle.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, precision: 3, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();
const updatedAt = () =>
  ts('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const pk = () => uuid('id').primaryKey().defaultRandom();

export const organisationKind = pgEnum('organisation_kind', ['PERSONAL', 'TEAM']);
export const plan = pgEnum('plan', ['FREE', 'PRO', 'TEAM', 'BUSINESS', 'ENTERPRISE']);
export const organisationRole = pgEnum('organisation_role', ['OWNER', 'ADMIN', 'MEMBER', 'GUEST']);
export const workspaceRole = pgEnum('workspace_role', ['ADMIN', 'MEMBER', 'VIEWER']);
export const projectLifecycle = pgEnum('project_lifecycle', ['DRAFT', 'ACTIVE', 'IN_REVIEW', 'COMPLETED', 'CANCELLED']);
export const priority = pgEnum('priority', ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'URGENT']);
export const userTokenPurpose = pgEnum('user_token_purpose', ['PASSWORD_RESET', 'EMAIL_VERIFICATION', 'ACCOUNT_DELETION']);
export const taskStatus = pgEnum('task_status', ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'CANCELLED']);

export const users = pgTable('users', {
  id: pk(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  emailVerifiedAt: ts('email_verified_at'),
  /** TOTP secret (AES-256-GCM encrypted, base32 inside). Set during setup; active only once mfaEnabledAt is set. */
  mfaSecret: text('mfa_secret'),
  mfaEnabledAt: ts('mfa_enabled_at'),
  /** Last accepted TOTP time step: a code can be used once (replay protection). */
  mfaLastStep: integer('mfa_last_step'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: ts('deleted_at'),
});

export const sessions = pgTable(
  'sessions',
  {
    id: pk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt: createdAt(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const organisations = pgTable('organisations', {
  id: pk(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  kind: organisationKind('kind').notNull(),
  /** Subscription tier. Changed by billing (provider integration pending) or operations, never by the client. */
  plan: plan('plan').notNull().default('FREE'),
  /** Set only for PERSONAL organisations; unique → at most one personal org per user. */
  personalOwnerId: uuid('personal_owner_id')
    .unique()
    .references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  /** Set when deletion is scheduled; the organisation is hidden immediately and restorable until purgeAfter. */
  deletedAt: ts('deleted_at'),
  deletionRequestedById: uuid('deletion_requested_by_id').references(() => users.id, { onDelete: 'set null' }),
  /** After this moment the maintenance job erases the organisation and everything in it. */
  purgeAfter: ts('purge_after'),
});

export const organisationMemberships = pgTable(
  'organisation_memberships',
  {
    id: pk(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: organisationRole('role').notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique('org_membership_unique').on(t.organisationId, t.userId), index('org_membership_user_idx').on(t.userId)],
);

export const workspaces = pgTable(
  'workspaces',
  {
    id: pk(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    unique('workspace_slug_unique').on(t.organisationId, t.slug),
    // Target for composite FKs that pin child rows to the same organisation.
    unique('workspace_id_org_unique').on(t.id, t.organisationId),
  ],
);

export const workspaceMemberships = pgTable(
  'workspace_memberships',
  {
    id: pk(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: workspaceRole('role').notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique('ws_membership_unique').on(t.workspaceId, t.userId), index('ws_membership_user_idx').on(t.userId)],
);

export const projects = pgTable(
  'projects',
  {
    id: pk(),
    organisationId: uuid('organisation_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    name: text('name').notNull(),
    objective: text('objective').notNull().default(''),
    description: text('description').notNull().default(''),
    lifecycle: projectLifecycle('lifecycle').notNull().default('DRAFT'),
    priority: priority('priority').notNull().default('NONE'),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id),
    startDate: date('start_date', { mode: 'string' }),
    targetDate: date('target_date', { mode: 'string' }),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    foreignKey({
      name: 'projects_workspace_org_fk',
      columns: [t.workspaceId, t.organisationId],
      foreignColumns: [workspaces.id, workspaces.organisationId],
    }).onDelete('cascade'),
    unique('project_id_workspace_unique').on(t.id, t.workspaceId),
    index('projects_workspace_idx').on(t.workspaceId, t.deletedAt),
    index('projects_org_idx').on(t.organisationId),
  ],
);

export const milestones = pgTable(
  'milestones',
  {
    id: pk(),
    organisationId: uuid('organisation_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    name: text('name').notNull(),
    dueDate: date('due_date', { mode: 'string' }),
    completedAt: ts('completed_at'),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    foreignKey({
      name: 'milestones_project_workspace_fk',
      columns: [t.projectId, t.workspaceId],
      foreignColumns: [projects.id, projects.workspaceId],
    }).onDelete('cascade'),
    index('milestones_project_idx').on(t.projectId, t.deletedAt),
  ],
);

export const tasks = pgTable(
  'tasks',
  {
    id: pk(),
    organisationId: uuid('organisation_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    parentTaskId: uuid('parent_task_id'),
    milestoneId: uuid('milestone_id').references(() => milestones.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    status: taskStatus('status').notNull().default('TODO'),
    priority: priority('priority').notNull().default('NONE'),
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    creatorId: uuid('creator_id')
      .notNull()
      .references(() => users.id),
    startDate: date('start_date', { mode: 'string' }),
    dueDate: date('due_date', { mode: 'string' }),
    estimateMinutes: integer('estimate_minutes'),
    blockedReason: text('blocked_reason'),
    sortOrder: doublePrecision('sort_order').notNull().default(0),
    completedAt: ts('completed_at'),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    // A task's project must be in the task's workspace.
    foreignKey({
      name: 'tasks_project_workspace_fk',
      columns: [t.projectId, t.workspaceId],
      foreignColumns: [projects.id, projects.workspaceId],
    }).onDelete('cascade'),
    // And the workspace must be in the task's organisation.
    foreignKey({
      name: 'tasks_workspace_org_fk',
      columns: [t.workspaceId, t.organisationId],
      foreignColumns: [workspaces.id, workspaces.organisationId],
    }).onDelete('cascade'),
    foreignKey({ name: 'tasks_parent_fk', columns: [t.parentTaskId], foreignColumns: [t.id] }).onDelete('cascade'),
    index('tasks_project_idx').on(t.projectId, t.deletedAt, t.status),
    index('tasks_assignee_idx').on(t.assigneeId, t.deletedAt),
    index('tasks_workspace_idx').on(t.workspaceId),
    index('tasks_parent_idx').on(t.parentTaskId),
  ],
);

export const taskDependencies = pgTable(
  'task_dependencies',
  {
    id: pk(),
    organisationId: uuid('organisation_id').notNull(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    dependsOnTaskId: uuid('depends_on_task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('task_dependency_unique').on(t.taskId, t.dependsOnTaskId),
    index('task_dependency_target_idx').on(t.dependsOnTaskId),
  ],
);

export const activityEvents = pgTable(
  'activity_events',
  {
    id: pk(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id'),
    projectId: uuid('project_id'),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    action: text('action').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    index('activity_project_idx').on(t.projectId, t.createdAt),
    index('activity_org_idx').on(t.organisationId, t.createdAt),
  ],
);

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: pk(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id'),
    projectId: uuid('project_id'),
    actorId: uuid('actor_id'),
    topic: text('topic').notNull(),
    entityId: uuid('entity_id').notNull(),
    entityVersion: integer('entity_version'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
    publishedAt: ts('published_at'),
  },
  (t) => [index('outbox_pending_idx').on(t.publishedAt, t.createdAt), index('outbox_workspace_idx').on(t.workspaceId, t.createdAt)],
);

export const invitations = pgTable(
  'invitations',
  {
    id: pk(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: organisationRole('role').notNull(),
    workspaceId: uuid('workspace_id'),
    workspaceRole: workspaceRole('workspace_role'),
    /** SHA-256 of the one-time token; the raw token is only ever shown to the inviter once. */
    tokenHash: text('token_hash').notNull().unique(),
    invitedById: uuid('invited_by_id')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    expiresAt: ts('expires_at').notNull(),
    acceptedAt: ts('accepted_at'),
    acceptedById: uuid('accepted_by_id').references(() => users.id),
    revokedAt: ts('revoked_at'),
  },
  (t) => [
    // The optional workspace must belong to the same organisation.
    foreignKey({
      name: 'invitations_workspace_org_fk',
      columns: [t.workspaceId, t.organisationId],
      foreignColumns: [workspaces.id, workspaces.organisationId],
    }).onDelete('cascade'),
    // At most one open invitation per email per organisation.
    uniqueIndex('invitations_pending_unique')
      .on(t.organisationId, t.email)
      .where(sql`accepted_at IS NULL AND revoked_at IS NULL`),
    index('invitations_org_idx').on(t.organisationId, t.createdAt),
  ],
);

export const comments = pgTable(
  'comments',
  {
    id: pk(),
    organisationId: uuid('organisation_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    /** Null = project discussion; otherwise a comment on this task. */
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    /** Plain text; mentions are encoded as <@user-uuid>. */
    body: text('body').notNull(),
    createdAt: createdAt(),
    editedAt: ts('edited_at'),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    foreignKey({
      name: 'comments_project_workspace_fk',
      columns: [t.projectId, t.workspaceId],
      foreignColumns: [projects.id, projects.workspaceId],
    }).onDelete('cascade'),
    index('comments_task_idx').on(t.taskId, t.createdAt),
    index('comments_project_idx').on(t.projectId, t.createdAt),
  ],
);

export const notifications = pgTable(
  'notifications',
  {
    id: pk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id'),
    projectId: uuid('project_id'),
    type: text('type').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /** Prevents duplicate notifications for the same event (idempotent fan-out). */
    dedupeKey: text('dedupe_key').notNull(),
    createdAt: createdAt(),
    readAt: ts('read_at'),
  },
  (t) => [
    unique('notifications_dedupe_unique').on(t.userId, t.dedupeKey),
    index('notifications_user_idx').on(t.userId, t.readAt, t.createdAt),
  ],
);

export const documents = pgTable(
  'documents',
  {
    id: pk(),
    organisationId: uuid('organisation_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id'),
    parentId: uuid('parent_id'),
    title: text('title').notNull(),
    /** Markdown source. Rendered client-side into React elements (never as raw HTML). */
    body: text('body').notNull().default(''),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id),
    updatedById: uuid('updated_by_id')
      .notNull()
      .references(() => users.id),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    foreignKey({
      name: 'documents_workspace_org_fk',
      columns: [t.workspaceId, t.organisationId],
      foreignColumns: [workspaces.id, workspaces.organisationId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'documents_project_workspace_fk',
      columns: [t.projectId, t.workspaceId],
      foreignColumns: [projects.id, projects.workspaceId],
    }).onDelete('cascade'),
    foreignKey({ name: 'documents_parent_fk', columns: [t.parentId], foreignColumns: [t.id] }).onDelete('cascade'),
    index('documents_workspace_idx').on(t.workspaceId, t.deletedAt),
    index('documents_project_idx').on(t.projectId),
    index('documents_parent_idx').on(t.parentId),
  ],
);

export const documentVersions = pgTable(
  'document_versions',
  {
    id: pk(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    organisationId: uuid('organisation_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    version: integer('version').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('document_versions_doc_idx').on(t.documentId, t.createdAt)],
);

export const aiProposalStatus = pgEnum('ai_proposal_status', ['PENDING', 'APPLIED', 'REJECTED']);

/** AI output is stored as a proposal; nothing changes until a person with permission approves it. */
export const aiProposals = pgTable(
  'ai_proposals',
  {
    id: pk(),
    organisationId: uuid('organisation_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    kind: text('kind').notNull(),
    status: aiProposalStatus('status').notNull().default('PENDING'),
    provider: text('provider').notNull(),
    model: text('model'),
    requestedById: uuid('requested_by_id')
      .notNull()
      .references(() => users.id),
    input: jsonb('input').$type<Record<string, unknown>>().notNull(),
    output: jsonb('output').$type<Record<string, unknown>>().notNull(),
    decidedById: uuid('decided_by_id').references(() => users.id),
    decidedAt: ts('decided_at'),
    appliedEntityIds: jsonb('applied_entity_ids').$type<string[]>(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'ai_proposals_project_workspace_fk',
      columns: [t.projectId, t.workspaceId],
      foreignColumns: [projects.id, projects.workspaceId],
    }).onDelete('cascade'),
    index('ai_proposals_project_idx').on(t.projectId, t.createdAt),
    index('ai_proposals_org_idx').on(t.organisationId, t.createdAt),
  ],
);

export const automationRules = pgTable(
  'automation_rules',
  {
    id: pk(),
    organisationId: uuid('organisation_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    trigger: text('trigger').notNull(),
    /** Validated by AutomationRuleSchema in @monty/validation before it is stored. */
    conditions: jsonb('conditions').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    actions: jsonb('actions').$type<Record<string, unknown>[]>().notNull(),
    /** HMAC secret for webhook actions (generated server-side; shown to admins). */
    webhookSecret: text('webhook_secret'),
    /** Actions run with this user's permissions; if they lose access, the rule stops acting. */
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    foreignKey({
      name: 'automation_rules_workspace_org_fk',
      columns: [t.workspaceId, t.organisationId],
      foreignColumns: [workspaces.id, workspaces.organisationId],
    }).onDelete('cascade'),
    index('automation_rules_ws_idx').on(t.workspaceId, t.trigger),
  ],
);

export const automationRuns = pgTable(
  'automation_runs',
  {
    id: pk(),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => automationRules.id, { onDelete: 'cascade' }),
    organisationId: uuid('organisation_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    /** Idempotency key: the triggering event (outbox id) or a synthetic key for time-based triggers. */
    eventKey: text('event_key').notNull(),
    taskId: uuid('task_id'),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(0),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    error: text('error'),
    createdAt: createdAt(),
    finishedAt: ts('finished_at'),
  },
  (t) => [unique('automation_runs_idempotency').on(t.ruleId, t.eventKey), index('automation_runs_rule_idx').on(t.ruleId, t.createdAt)],
);

/**
 * Durable outbound email queue (transactional outbox). Rows are inserted in the same transaction as the change that
 * causes the email, so an email is never lost when the provider is down or the process restarts.
 * The rendered message (it may contain one-time links) is encrypted at rest and wiped once delivery is final.
 */
export const emailOutbox = pgTable(
  'email_outbox',
  {
    id: pk(),
    /** Prevents queuing the same logical email twice (e.g. "verify:<token id>"). */
    idempotencyKey: text('idempotency_key').notNull().unique(),
    kind: text('kind').notNull(),
    toAddress: text('to_address').notNull(),
    /** Optional link to the recipient account so account deletion can erase queued mail. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** AES-256-GCM encrypted JSON {subject,text,html}; null once delivery is final. */
    payload: text('payload'),
    /** PENDING → SENDING → SENT | (retry → PENDING) | FAILED (permanent or max attempts) | EXPIRED */
    status: text('status').notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull(),
    nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
    /** Lease while SENDING; an expired lease (crashed worker) makes the row claimable again. */
    lockedUntil: ts('locked_until'),
    /** The link inside is useless after this time (e.g. password reset: 1 h), so don't send late. */
    expiresAt: ts('expires_at'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    sentAt: ts('sent_at'),
    finishedAt: ts('finished_at'),
  },
  (t) => [index('email_outbox_due_idx').on(t.status, t.nextAttemptAt), index('email_outbox_user_idx').on(t.userId)],
);

export const emailDeliveryAttempts = pgTable(
  'email_delivery_attempts',
  {
    id: pk(),
    emailId: uuid('email_id')
      .notNull()
      .references(() => emailOutbox.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    /** SENT | TEMPORARY_FAILURE | PERMANENT_FAILURE */
    outcome: text('outcome').notNull(),
    smtpCode: integer('smtp_code'),
    error: text('error'),
    durationMs: integer('duration_ms').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('email_attempts_email_idx').on(t.emailId, t.attempt)],
);

/** Personal data exports. Content is gzip + AES-256-GCM encrypted; downloadable with a one-time-shown token until expiry. */
export const dataExports = pgTable(
  'data_exports',
  {
    id: pk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    downloadTokenHash: text('download_token_hash').notNull().unique(),
    createdAt: createdAt(),
    expiresAt: ts('expires_at').notNull(),
    downloadedAt: ts('downloaded_at'),
  },
  (t) => [index('data_exports_user_idx').on(t.userId, t.createdAt)],
);

/** Single-use recovery codes for two-factor sign-in. Only SHA-256 hashes are stored. */
export const mfaRecoveryCodes = pgTable(
  'mfa_recovery_codes',
  {
    id: pk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    createdAt: createdAt(),
    usedAt: ts('used_at'),
  },
  (t) => [index('mfa_recovery_user_idx').on(t.userId)],
);

/** Second step of a password sign-in for accounts with two-factor authentication. Short-lived, attempt-limited. */
export const loginChallenges = pgTable('login_challenges', {
  id: pk(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  attempts: integer('attempts').notNull().default(0),
  createdAt: createdAt(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
});

/** One-time tokens sent by email (password reset, email verification). Only the SHA-256 hash is stored. */
export const userTokens = pgTable(
  'user_tokens',
  {
    id: pk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: userTokenPurpose('purpose').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    /** The address the token was sent to; verification only counts if it still matches the account email. */
    email: text('email').notNull(),
    createdAt: createdAt(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
  },
  (t) => [index('user_tokens_user_idx').on(t.userId, t.purpose)],
);

/** Security and administration events. Separate from product activity; append-only. */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: pk(),
    organisationId: uuid('organisation_id').references(() => organisations.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_org_idx').on(t.organisationId, t.createdAt),
    index('audit_actor_idx').on(t.actorId, t.createdAt),
  ],
);

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Organisation = typeof organisations.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type ActivityEvent = typeof activityEvents.$inferSelect;
export type OutboxEvent = typeof outboxEvents.$inferSelect;
export type Invitation = typeof invitations.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type UserToken = typeof userTokens.$inferSelect;
export type Milestone = typeof milestones.$inferSelect;
export type Comment = typeof comments.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type Document = typeof documents.$inferSelect;
export type DocumentVersion = typeof documentVersions.$inferSelect;
export type AiProposal = typeof aiProposals.$inferSelect;
export type AutomationRule = typeof automationRules.$inferSelect;
export type AutomationRun = typeof automationRuns.$inferSelect;
