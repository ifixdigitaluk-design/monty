/**
 * Monty database schema (Drizzle ORM). See docs/DATABASE_SCHEMA.md for intent and rules.
 * Migrations are generated from this file with drizzle-kit and committed under /drizzle.
 */
import { sql } from 'drizzle-orm';
import {
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
export const organisationRole = pgEnum('organisation_role', ['OWNER', 'ADMIN', 'MEMBER', 'GUEST']);
export const workspaceRole = pgEnum('workspace_role', ['ADMIN', 'MEMBER', 'VIEWER']);
export const projectLifecycle = pgEnum('project_lifecycle', ['DRAFT', 'ACTIVE', 'IN_REVIEW', 'COMPLETED', 'CANCELLED']);
export const priority = pgEnum('priority', ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'URGENT']);
export const userTokenPurpose = pgEnum('user_token_purpose', ['PASSWORD_RESET', 'EMAIL_VERIFICATION']);
export const taskStatus = pgEnum('task_status', ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'CANCELLED']);

export const users = pgTable('users', {
  id: pk(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  emailVerifiedAt: ts('email_verified_at'),
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
  /** Set only for PERSONAL organisations; unique → at most one personal org per user. */
  personalOwnerId: uuid('personal_owner_id')
    .unique()
    .references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: ts('deleted_at'),
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

export const tasks = pgTable(
  'tasks',
  {
    id: pk(),
    organisationId: uuid('organisation_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    parentTaskId: uuid('parent_task_id'),
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
    topic: text('topic').notNull(),
    entityId: uuid('entity_id').notNull(),
    entityVersion: integer('entity_version'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
    publishedAt: ts('published_at'),
  },
  (t) => [index('outbox_pending_idx').on(t.publishedAt, t.createdAt)],
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
