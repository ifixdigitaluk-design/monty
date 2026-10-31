/**
 * API contract shared by server (validation) and clients (types).
 * Request schemas are strict: unknown fields are rejected.
 */
import { z } from 'zod';
import { ACTIVITY_TYPES, CHOICE_COLORS, DEAL_STAGES, EMPLOYMENT_TYPES, HR_DOC_CATEGORIES, LEAVE_TYPES, FIELD_TYPES, FILTER_OPS, isIsoDate, QUOTE_STATUSES } from '@monty/domain';
import type { FieldType, ViewConfig } from '@monty/domain';

export const isoDate = z.string().refine(isIsoDate, { message: 'Expected a date in YYYY-MM-DD format' });
const uuid = z.uuid();
const name = z.string().trim().min(1, 'Required').max(200);

export const PriorityEnum = z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH', 'URGENT']);
export const TaskStatusEnum = z.enum(['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'CANCELLED']);
export const ProjectLifecycleEnum = z.enum(['DRAFT', 'ACTIVE', 'IN_REVIEW', 'COMPLETED', 'CANCELLED']);
export type Priority = z.infer<typeof PriorityEnum>;
export type ProjectLifecycle = z.infer<typeof ProjectLifecycleEnum>;

// ---------- auth ----------
function SafeNextSchema() {
  return z
    .string()
    .max(500)
    .regex(/^\/(?![/\\])[A-Za-z0-9\-._~/?=&%]*$/, 'Must be a relative path');
}

export const RegisterSchema = z.strictObject({
  email: z.email().max(320).transform((e) => e.toLowerCase()),
  name: name,
  password: z.string().min(10, 'Use at least 10 characters').max(200),
  /** Where to go after the emailed confirmation link signs the user in (relative path only). */
  next: SafeNextSchema().optional(),
});
export type RegisterInput = z.infer<typeof RegisterSchema>;
/** Same response whether or not the email already has an account (no account enumeration). */
export interface RegisterResultDto {
  status: 'check_email';
  message: string;
}

export const LoginSchema = z.strictObject({
  email: z.email().max(320).transform((e) => e.toLowerCase()),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof LoginSchema>;

export const RequestPasswordResetSchema = z.strictObject({
  email: z.email().max(320).transform((e) => e.toLowerCase()),
});
export const OneTimeTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{20,100}$/, 'Invalid or expired link');
export const ConfirmPasswordResetSchema = z.strictObject({
  token: OneTimeTokenSchema,
  password: z.string().min(10, 'Use at least 10 characters').max(200),
});
export const VerifyEmailSchema = z.strictObject({ token: OneTimeTokenSchema });
export type RequestPasswordResetInput = z.infer<typeof RequestPasswordResetSchema>;
export type ConfirmPasswordResetInput = z.infer<typeof ConfirmPasswordResetSchema>;
export type VerifyEmailInput = z.infer<typeof VerifyEmailSchema>;

// ---------- organisations / workspaces ----------
export const CreateOrganisationSchema = z.strictObject({ name });
export type CreateOrganisationInput = z.infer<typeof CreateOrganisationSchema>;

export const CreateWorkspaceSchema = z.strictObject({ name });
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceSchema>;

// ---------- projects ----------
const projectFields = {
  name,
  objective: z.string().max(5000),
  description: z.string().max(20000),
  lifecycle: ProjectLifecycleEnum,
  priority: PriorityEnum,
  ownerId: uuid.nullable(),
  startDate: isoDate.nullable(),
  targetDate: isoDate.nullable(),
};

export const CreateProjectSchema = z.strictObject({
  id: uuid.optional(),
  name: projectFields.name,
  objective: projectFields.objective.optional(),
  description: projectFields.description.optional(),
  priority: projectFields.priority.optional(),
  ownerId: projectFields.ownerId.optional(),
  startDate: projectFields.startDate.optional(),
  targetDate: projectFields.targetDate.optional(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;

export const UpdateProjectSchema = z
  .strictObject({
    expectedVersion: z.int().positive(),
    name: projectFields.name.optional(),
    objective: projectFields.objective.optional(),
    description: projectFields.description.optional(),
    lifecycle: projectFields.lifecycle.optional(),
    priority: projectFields.priority.optional(),
    ownerId: projectFields.ownerId.optional(),
    startDate: projectFields.startDate.optional(),
    targetDate: projectFields.targetDate.optional(),
  })
  .refine((v) => !(v.startDate && v.targetDate && v.startDate > v.targetDate), {
    message: 'Start date must be on or before the target date',
    path: ['startDate'],
  });
export type UpdateProjectInput = z.infer<typeof UpdateProjectSchema>;

// ---------- tasks ----------
const taskFields = {
  title: z.string().trim().min(1, 'Required').max(500),
  description: z.string().max(20000),
  status: TaskStatusEnum,
  priority: PriorityEnum,
  assigneeId: uuid.nullable(),
  startDate: isoDate.nullable(),
  dueDate: isoDate.nullable(),
  estimateMinutes: z.int().min(0).max(100000).nullable(),
  blockedReason: z.string().trim().max(1000).nullable(),
  sortOrder: z.number().finite(),
  milestoneId: uuid.nullable(),
};

export const CreateTaskSchema = z.strictObject({
  id: uuid.optional(),
  parentTaskId: uuid.nullable().optional(),
  title: taskFields.title,
  description: taskFields.description.optional(),
  status: taskFields.status.optional(),
  priority: taskFields.priority.optional(),
  assigneeId: taskFields.assigneeId.optional(),
  startDate: taskFields.startDate.optional(),
  dueDate: taskFields.dueDate.optional(),
  estimateMinutes: taskFields.estimateMinutes.optional(),
  blockedReason: taskFields.blockedReason.optional(),
  milestoneId: taskFields.milestoneId.optional(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;

export const UpdateTaskSchema = z.strictObject({
  expectedVersion: z.int().positive(),
  title: taskFields.title.optional(),
  description: taskFields.description.optional(),
  status: taskFields.status.optional(),
  priority: taskFields.priority.optional(),
  assigneeId: taskFields.assigneeId.optional(),
  startDate: taskFields.startDate.optional(),
  dueDate: taskFields.dueDate.optional(),
  estimateMinutes: taskFields.estimateMinutes.optional(),
  blockedReason: taskFields.blockedReason.optional(),
  sortOrder: taskFields.sortOrder.optional(),
  milestoneId: taskFields.milestoneId.optional(),
});
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;

// ---------- milestones, dependencies, comments, notifications ----------
export const CreateMilestoneSchema = z.strictObject({ id: uuid.optional(), name: name, dueDate: isoDate.nullable().optional() });
export type CreateMilestoneInput = z.infer<typeof CreateMilestoneSchema>;
export const UpdateMilestoneSchema = z.strictObject({
  expectedVersion: z.int().positive(),
  name: name.optional(),
  dueDate: isoDate.nullable().optional(),
  completed: z.boolean().optional(),
});
export type UpdateMilestoneInput = z.infer<typeof UpdateMilestoneSchema>;
export const AddDependencySchema = z.strictObject({ dependsOnTaskId: uuid });
export type AddDependencyInput = z.infer<typeof AddDependencySchema>;
export const CreateCommentSchema = z.strictObject({ id: uuid.optional(), body: z.string().trim().min(1, 'Write something first').max(10000) });
export type CreateCommentInput = z.infer<typeof CreateCommentSchema>;
export const MarkNotificationsReadSchema = z.strictObject({ ids: z.array(uuid).max(500).optional() });
export type MarkNotificationsReadInput = z.infer<typeof MarkNotificationsReadSchema>;

export const TodayQuerySchema = z.strictObject({ today: isoDate.optional() });

// ---------- membership ----------
export const OrgRoleEnum = z.enum(['OWNER', 'ADMIN', 'MEMBER', 'GUEST']);
export const WorkspaceRoleEnum = z.enum(['ADMIN', 'MEMBER', 'VIEWER']);
export type OrgRoleValue = z.infer<typeof OrgRoleEnum>;
export type WorkspaceRoleValue = z.infer<typeof WorkspaceRoleEnum>;

export const CreateInvitationSchema = z
  .strictObject({
    email: z.email().max(320).transform((e) => e.toLowerCase()),
    role: z.enum(['ADMIN', 'MEMBER', 'GUEST']),
    workspaceId: uuid.nullable().optional(),
    workspaceRole: WorkspaceRoleEnum.nullable().optional(),
  })
  .refine((v) => !!v.workspaceId === !!v.workspaceRole, {
    message: 'Choose both a workspace and a workspace role, or neither',
    path: ['workspaceRole'],
  });
export type CreateInvitationInput = z.infer<typeof CreateInvitationSchema>;

export const UpdateMemberRoleSchema = z.strictObject({ role: OrgRoleEnum });
export type UpdateMemberRoleInput = z.infer<typeof UpdateMemberRoleSchema>;

export const SetWorkspaceMemberSchema = z.strictObject({ role: WorkspaceRoleEnum });
export type SetWorkspaceMemberInput = z.infer<typeof SetWorkspaceMemberSchema>;

// ---------- response DTOs (types only) ----------
export interface UserDto {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  mfaEnabled: boolean;
}

// ---------- two-factor authentication ----------
export const TotpCodeSchema = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app');
export const RecoveryCodeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]{4}-?[a-z0-9]{4}-?[a-z0-9]{4}$/, 'Recovery codes look like abcd-efgh-ijkl')
  .transform((c) => c.replace(/-/g, ''));
/** Login either completes (`user`) or asks for a second factor (`mfaRequired` + short-lived `mfaToken`). */
export type LoginResultDto = { user: UserDto; mfaRequired?: false } | { mfaRequired: true; mfaToken: string };
export const LoginMfaSchema = z
  .strictObject({
    mfaToken: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/),
    code: TotpCodeSchema.optional(),
    recoveryCode: RecoveryCodeSchema.optional(),
  })
  .refine((v) => !!v.code !== !!v.recoveryCode, { message: 'Enter a code or a recovery code', path: ['code'] });
export type LoginMfaInput = z.infer<typeof LoginMfaSchema>;
export const MfaSetupSchema = z.strictObject({ password: z.string().min(1).max(200) });
export const MfaEnableSchema = z.strictObject({ code: TotpCodeSchema });
export const MfaDisableSchema = z
  .strictObject({ password: z.string().min(1).max(200), code: TotpCodeSchema.optional(), recoveryCode: RecoveryCodeSchema.optional() })
  .refine((v) => !!v.code !== !!v.recoveryCode, { message: 'Enter a code or a recovery code', path: ['code'] });
export type MfaDisableInput = z.infer<typeof MfaDisableSchema>;
export interface MfaSetupDto {
  /** Base32 secret for manual entry. */
  secret: string;
  otpauthUrl: string;
  /** SVG QR code as a data: URL. */
  qrSvgDataUrl: string;
}
export interface MfaStatusDto {
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesRemaining: number;
}

export interface WorkspaceSummaryDto {
  id: string;
  name: string;
  slug: string;
  role: 'ADMIN' | 'MEMBER' | 'VIEWER';
}

export interface OrganisationDto {
  id: string;
  name: string;
  slug: string;
  kind: 'PERSONAL' | 'TEAM';
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST';
  workspaces: WorkspaceSummaryDto[];
}

export interface MemberDto {
  id: string;
  name: string;
  email: string;
}

export interface ProjectDto {
  id: string;
  organisationId: string;
  workspaceId: string;
  name: string;
  objective: string;
  description: string;
  lifecycle: ProjectLifecycle;
  priority: Priority;
  ownerId: string | null;
  createdById: string;
  startDate: string | null;
  targetDate: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectListItemDto extends ProjectDto {
  taskTotal: number;
  taskDone: number;
}

export interface ProjectDetailDto extends ProjectDto {
  role: 'ADMIN' | 'MEMBER' | 'VIEWER';
  members: MemberDto[];
  workspaceName: string;
}

export interface TaskDto {
  id: string;
  projectId: string;
  workspaceId: string;
  parentTaskId: string | null;
  title: string;
  description: string;
  status: z.infer<typeof TaskStatusEnum>;
  priority: Priority;
  assigneeId: string | null;
  creatorId: string;
  startDate: string | null;
  dueDate: string | null;
  estimateMinutes: number | null;
  blockedReason: string | null;
  sortOrder: number;
  milestoneId: string | null;
  completedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface MyTaskDto extends TaskDto {
  projectName: string;
}

export interface SessionDto {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

export interface ActivityDto {
  id: string;
  actor: { id: string; name: string };
  entityType: string;
  entityId: string;
  action: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export interface OrgMemberDto {
  id: string;
  name: string;
  email: string;
  role: OrgRoleValue;
  joinedAt: string;
  workspaces: { id: string; name: string; role: WorkspaceRoleValue }[];
}

export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export interface InvitationDto {
  id: string;
  email: string;
  role: OrgRoleValue;
  workspaceId: string | null;
  workspaceName: string | null;
  workspaceRole: WorkspaceRoleValue | null;
  invitedBy: { id: string; name: string };
  createdAt: string;
  expiresAt: string;
  status: InvitationStatus;
}

export interface CreatedInvitationDto extends InvitationDto {
  /** Relative accept link containing the one-time token. Returned once; never retrievable again. */
  invitePath: string;
  /** Whether the invitation email was handed to the mail provider. The link can always be shared manually. */
  emailSent: boolean;
}

export interface InvitationPreviewDto {
  organisationName: string;
  invitedByName: string;
  email: string;
  role: OrgRoleValue;
  workspaceName: string | null;
  status: InvitationStatus;
}

export interface WorkspaceMemberDto {
  id: string;
  name: string;
  email: string;
  orgRole: OrgRoleValue;
  /** Explicit workspace membership, if any. */
  workspaceRole: WorkspaceRoleValue | null;
  /** What the user can actually do here (org owners/admins administer every workspace). */
  effectiveRole: WorkspaceRoleValue | null;
}

export interface AuditEntryDto {
  id: string;
  action: string;
  actor: { id: string; name: string } | null;
  targetType: string | null;
  targetId: string | null;
  data: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}

export interface MilestoneDto {
  id: string;
  projectId: string;
  name: string;
  dueDate: string | null;
  completedAt: string | null;
  version: number;
  taskTotal: number;
  taskDone: number;
}

export interface DependencyDto {
  id: string;
  taskId: string;
  dependsOnTaskId: string;
}

export interface CommentDto {
  id: string;
  projectId: string;
  taskId: string | null;
  author: { id: string; name: string };
  body: string;
  createdAt: string;
  editedAt: string | null;
}

export interface NotificationDto {
  id: string;
  /** Also HR events: leave_request, leave_approved, leave_declined, leave_cancelled, checklist_assigned, review_shared. */
  type: 'mention' | 'assigned' | 'comment' | 'automation' | 'leave_request' | 'leave_approved' | 'leave_declined' | 'leave_cancelled' | 'checklist_assigned' | 'review_shared';
  entityType: string;
  entityId: string;
  projectId: string | null;
  actor: { id: string; name: string } | null;
  data: Record<string, unknown>;
  createdAt: string;
  readAt: string | null;
}

/** Mentions are stored as <@user-uuid> tokens inside comment bodies. */
export const MENTION_PATTERN = /<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/gi;
export function extractMentions(body: string): string[] {
  return [...new Set([...body.matchAll(MENTION_PATTERN)].map((m) => m[1]!.toLowerCase()))];
}

export const SearchQuerySchema = z.strictObject({ q: z.string().trim().min(1).max(200), limit: z.coerce.number().int().min(1).max(50).optional() });
export const CalendarQuerySchema = z
  .strictObject({ from: isoDate, to: isoDate, mine: z.enum(['1', '0']).optional() })
  .refine((v) => v.from <= v.to, { message: 'from must be before to' })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 62, { message: 'Range is limited to 62 days' });

export interface SearchResultDto {
  type: 'project' | 'task' | 'comment' | 'document' | 'message' | 'database_row' | 'crm_company' | 'crm_contact' | 'crm_deal';
  id: string;
  title: string;
  snippet: string;
  /** Empty for workspace documents that are not linked to a project. */
  projectId: string;
  projectName: string;
  taskId: string | null;
  workspaceId: string;
  workspaceName: string;
  /** Chat results: where to open the message. */
  channelId?: string;
  parentId?: string | null;
  /** Database row results: the database to open (projectName holds its name). */
  databaseId?: string;
}

export interface CalendarEntryDto {
  kind: 'task' | 'milestone';
  id: string;
  title: string;
  date: string;
  projectId: string;
  projectName: string;
  status: string | null;
  assigneeId: string | null;
  done: boolean;
}

export interface HomeDto {
  counts: { overdue: number; today: number; thisWeek: number; open: number; unreadNotifications: number };
  attention: { projectId: string; projectName: string; workspaceName: string; computedStatus: string; reasons: string[] }[];
  recentActivity: ActivityDto[];
}

// ---------- documents ----------
const docTitle = z.string().trim().min(1, 'Required').max(300);
const docBody = z.string().max(200_000, 'Document is too long (200,000 characters max)');
export const CreateDocumentSchema = z.strictObject({
  id: uuid.optional(),
  title: docTitle,
  body: docBody.optional(),
  parentId: uuid.nullable().optional(),
  projectId: uuid.nullable().optional(),
});
export type CreateDocumentInput = z.infer<typeof CreateDocumentSchema>;
export const UpdateDocumentSchema = z.strictObject({
  expectedVersion: z.int().positive(),
  title: docTitle.optional(),
  body: docBody.optional(),
  parentId: uuid.nullable().optional(),
  projectId: uuid.nullable().optional(),
});
export type UpdateDocumentInput = z.infer<typeof UpdateDocumentSchema>;

export interface DocumentSummaryDto {
  id: string;
  title: string;
  parentId: string | null;
  projectId: string | null;
  updatedAt: string;
}
export interface DocumentDto extends DocumentSummaryDto {
  workspaceId: string;
  body: string;
  version: number;
  createdBy: { id: string; name: string };
  updatedBy: { id: string; name: string };
  role: 'ADMIN' | 'MEMBER' | 'VIEWER';
}
export interface DocumentVersionDto {
  id: string;
  version: number;
  title: string;
  author: { id: string; name: string };
  createdAt: string;
  updatedAt: string;
  body?: string;
}

// ---------- AI ----------
/** Strict shape every AI provider must return; anything else is rejected before it is stored or shown. */
export const AiPlanSchema = z.strictObject({
  summary: z.string().trim().max(1000),
  tasks: z
    .array(
      z.strictObject({
        title: z.string().trim().min(1).max(200),
        description: z.string().trim().max(2000).default(''),
        /** Days after the plan start (today) when the task should be due. */
        dueInDays: z.int().min(0).max(730).nullable().default(null),
        /** Indexes (into this array) of tasks this one waits for; must point backwards. */
        dependsOn: z.array(z.int().min(0)).max(10).default([]),
      }),
    )
    .min(1)
    .max(30),
});
export type AiPlan = z.infer<typeof AiPlanSchema>;

export const RequestPlanSchema = z.strictObject({ guidance: z.string().trim().max(1000).optional() });
export const ApplyProposalSchema = z.strictObject({ taskIndexes: z.array(z.int().min(0)).min(1).max(30) });
export type ApplyProposalInput = z.infer<typeof ApplyProposalSchema>;

export interface AiProposalDto {
  id: string;
  projectId: string;
  status: 'PENDING' | 'APPLIED' | 'REJECTED';
  provider: string;
  providerLabel: string;
  model: string | null;
  plan: AiPlan;
  requestedBy: { id: string; name: string };
  createdAt: string;
  decidedAt: string | null;
  appliedEntityIds: string[];
}

// ---------- automations ----------
export const AutomationTriggerEnum = z.enum(['task.created', 'task.updated', 'task.status_changed', 'task.overdue']);
export type AutomationTrigger = z.infer<typeof AutomationTriggerEnum>;

/** Webhook targets must be public HTTPS URLs; private/loopback addresses are additionally rejected at send time. */
const webhookUrl = z
  .url({ protocol: /^https$/, error: 'Webhook URL must start with https://' })
  .max(2000)
  .refine((u) => {
    const host = (/^https:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^/:?#]+)/i.exec(u)?.[1] ?? '').toLowerCase();
    return !(host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local'));
  }, 'Webhook URL must be a public address');

export const AutomationActionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('notify'),
    to: z.array(z.union([z.literal('assignee'), z.literal('creator'), uuid])).min(1).max(20),
    message: z.string().trim().min(1).max(500),
  }),
  z.strictObject({ type: z.literal('set_status'), status: TaskStatusEnum }),
  z.strictObject({ type: z.literal('set_priority'), priority: PriorityEnum }),
  z.strictObject({ type: z.literal('assign'), assigneeId: uuid.nullable() }),
  z.strictObject({ type: z.literal('webhook'), url: webhookUrl }),
]);
export type AutomationAction = z.infer<typeof AutomationActionSchema>;

export const AutomationConditionsSchema = z.strictObject({
  projectId: uuid.optional(),
  status: TaskStatusEnum.optional(),
  priority: PriorityEnum.optional(),
  /** null = unassigned */
  assigneeId: uuid.nullable().optional(),
  /** task.status_changed only: the status the task moved to. */
  toStatus: TaskStatusEnum.optional(),
});
export type AutomationConditions = z.infer<typeof AutomationConditionsSchema>;

const automationBase = {
  name: name,
  enabled: z.boolean().default(true),
  trigger: AutomationTriggerEnum,
  conditions: AutomationConditionsSchema.default({}),
  actions: z.array(AutomationActionSchema).min(1).max(10),
};
const toStatusNeedsStatusTrigger = (r: { trigger?: AutomationTrigger; conditions?: AutomationConditions; actions?: AutomationAction[] }) =>
  !(r.conditions?.toStatus && r.trigger !== 'task.status_changed');

export const CreateAutomationSchema = z
  .strictObject({ id: uuid.optional(), ...automationBase })
  .refine(toStatusNeedsStatusTrigger, { message: '"Moved to status" only applies to the "status changed" trigger', path: ['conditions', 'toStatus'] });
export type CreateAutomationInput = z.infer<typeof CreateAutomationSchema>;

export const UpdateAutomationSchema = z
  .strictObject({
    expectedVersion: z.int().min(1),
    name: name.optional(),
    enabled: z.boolean().optional(),
    trigger: AutomationTriggerEnum.optional(),
    conditions: AutomationConditionsSchema.optional(),
    actions: z.array(AutomationActionSchema).min(1).max(10).optional(),
  })
  .refine(toStatusNeedsStatusTrigger, { message: '"Moved to status" only applies to the "status changed" trigger', path: ['conditions', 'toStatus'] });
export type UpdateAutomationInput = z.infer<typeof UpdateAutomationSchema>;

export interface AutomationRuleDto {
  id: string;
  workspaceId: string;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  conditions: AutomationConditions;
  actions: AutomationAction[];
  /** Present only when the rule has a webhook action; used to verify the X-Monty-Signature header. */
  webhookSecret: string | null;
  createdBy: { id: string; name: string };
  version: number;
  createdAt: string;
  updatedAt: string;
  lastRun: AutomationRunDto | null;
}

export interface AutomationRunDto {
  id: string;
  ruleId: string;
  taskId: string | null;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
  attempts: number;
  detail: Record<string, unknown>;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

// ---------- data lifecycle ----------
export const RenameOrganisationSchema = z.strictObject({ name: name });
export type RenameOrganisationInput = z.infer<typeof RenameOrganisationSchema>;
export const DeleteOrganisationSchema = z.strictObject({
  /** Must equal the organisation's current name: guards against deleting the wrong one. */
  confirmName: z.string().min(1).max(200),
  password: z.string().min(1).max(200),
});
export type DeleteOrganisationInput = z.infer<typeof DeleteOrganisationSchema>;
export const RequestAccountDeletionSchema = z.strictObject({ password: z.string().min(1).max(200) });
export const ConfirmAccountDeletionSchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/),
  confirm: z.literal('DELETE', { error: 'Type DELETE to confirm' }),
});
export type ConfirmAccountDeletionInput = z.infer<typeof ConfirmAccountDeletionSchema>;

export interface DataExportDto {
  id: string;
  createdAt: string;
  expiresAt: string;
  sizeBytes: number;
  downloadedAt: string | null;
}
export interface CreatedDataExportDto extends DataExportDto {
  /** Shown once. Requires the same signed-in account and stops working at expiresAt. */
  downloadPath: string;
}
export interface DeletionBlockerDto {
  organisationId: string;
  name: string;
  memberCount: number;
}
export interface PendingOrganisationDeletionDto {
  id: string;
  name: string;
  deletedAt: string;
  purgeAfter: string;
}

// ---------- team chat ----------
const channelName = z
  .string()
  .trim()
  .toLowerCase()
  .transform((s) => s.replace(/^#/, '').replace(/\s+/g, '-'))
  .pipe(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/, 'Use lower-case letters, numbers, - and _ (up to 80)'));
export const CreateChannelSchema = z.strictObject({
  id: uuid.optional(),
  name: channelName,
  topic: z.string().trim().max(250).default(''),
  private: z.boolean().default(false),
  memberIds: z.array(uuid).max(149).default([]),
});
export type CreateChannelInput = z.infer<typeof CreateChannelSchema>;
export const UpdateChannelSchema = z.strictObject({
  name: channelName.optional(),
  topic: z.string().trim().max(250).optional(),
  archived: z.boolean().optional(),
});
export type UpdateChannelInput = z.infer<typeof UpdateChannelSchema>;
export const OpenDmSchema = z.strictObject({ userIds: z.array(uuid).min(1).max(7) });
export const AddChannelMembersSchema = z.strictObject({ userIds: z.array(uuid).min(1).max(50) });
export const PostMessageSchema = z.strictObject({
  id: uuid.optional(),
  /** May be empty when files are attached. */
  body: z.string().trim().max(8000).default(''),
  attachmentIds: z.array(uuid).max(10).default([]),
  parentId: uuid.optional(),
}).refine((m) => m.body.length > 0 || m.attachmentIds.length > 0, { message: 'Write something first', path: ['body'] });
export type PostMessageInput = z.infer<typeof PostMessageSchema>;
export const EditMessageSchema = z.strictObject({ body: z.string().trim().min(1).max(8000) });
export const REACTION_EMOJI = ['👍', '❤️', '😄', '🎉', '👀', '✅', '🙏', '🔥'] as const;
export const ReactionSchema = z.strictObject({ emoji: z.enum(REACTION_EMOJI) });

export interface ChannelDto {
  id: string;
  workspaceId: string;
  kind: 'public' | 'private' | 'dm';
  /** Channel slug, or for direct messages the other people's names. */
  name: string;
  topic: string;
  isMember: boolean;
  role: 'member' | 'admin' | null;
  memberCount: number;
  members?: { id: string; name: string }[];
  unread: number;
  mentions: number;
  lastMessageAt: string | null;
  archived: boolean;
}
export interface MessageDto {
  id: string;
  channelId: string;
  parentId: string | null;
  author: { id: string; name: string };
  body: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  replyCount: number;
  lastReplyAt: string | null;
  reactions: { emoji: string; count: number; mine: boolean }[];
  attachments: AttachmentDto[];
}
export interface ChatUnreadDto {
  workspaceId: string;
  unread: number;
  mentions: number;
}

// ---------- attachments ----------
export interface AttachmentDto {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  /** True for real images and PDFs, which may be previewed; everything else downloads. */
  inline: boolean;
  uploaderId: string;
  createdAt: string;
  url: string;
}

// ---------- databases (Notion-style) ----------
export const FieldTypeEnum = z.enum(FIELD_TYPES);
const choiceSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  label: z.string().trim().min(1).max(100),
  color: z.enum(CHOICE_COLORS),
});
const fieldOptions = z.strictObject({ choices: z.array(choiceSchema).max(100).optional() });
const fieldName = z.string().trim().min(1, 'Required').max(100);
export const CreateFieldSchema = z.strictObject({
  id: uuid.optional(),
  name: fieldName,
  type: FieldTypeEnum,
  options: fieldOptions.optional(),
});
export type CreateFieldInput = z.infer<typeof CreateFieldSchema>;
export const UpdateFieldSchema = z.strictObject({
  name: fieldName.optional(),
  options: fieldOptions.optional(),
  position: z.number().finite().optional(),
});
export type UpdateFieldInput = z.infer<typeof UpdateFieldSchema>;

export const ViewConfigSchema = z.strictObject({
  filters: z
    .array(z.strictObject({ fieldId: z.string().max(64), op: z.enum(FILTER_OPS), value: z.union([z.string().max(500), z.number(), z.boolean(), z.null()]).optional() }))
    .max(20)
    .optional(),
  match: z.enum(['all', 'any']).optional(),
  sorts: z.array(z.strictObject({ fieldId: z.string().max(64), dir: z.enum(['asc', 'desc']) })).max(5).optional(),
  groupBy: uuid.nullable().optional(),
  hiddenFieldIds: z.array(uuid).max(100).optional(),
});
const viewName = z.string().trim().min(1, 'Required').max(100);
export const CreateViewSchema = z.strictObject({
  name: viewName,
  layout: z.enum(['table', 'board']),
  config: ViewConfigSchema.optional(),
});
export type CreateViewInput = z.infer<typeof CreateViewSchema>;
export const UpdateViewSchema = z.strictObject({
  name: viewName.optional(),
  layout: z.enum(['table', 'board']).optional(),
  config: ViewConfigSchema.optional(),
  position: z.number().finite().optional(),
});
export type UpdateViewInput = z.infer<typeof UpdateViewSchema>;

const rowTitle = z.string().max(500);
const rowBody = z.string().max(200_000, 'Page is too long (200,000 characters max)');
/** Cell values keyed by field id; `null` clears a cell. Each value is checked against its field type on the server. */
const cellValues = z.record(uuid, z.unknown()).refine((v) => Object.keys(v).length <= 100, 'Too many fields');
export const CreateRowSchema = z.strictObject({
  id: uuid.optional(),
  title: rowTitle.optional(),
  values: cellValues.optional(),
  body: rowBody.optional(),
  position: z.number().finite().optional(),
});
export type CreateRowInput = z.infer<typeof CreateRowSchema>;
export const UpdateRowSchema = z.strictObject({
  title: rowTitle.optional(),
  /** Merged into the row: only the cells sent change, so teammates editing other cells don't conflict. */
  values: cellValues.optional(),
  body: rowBody.optional(),
  position: z.number().finite().optional(),
  /** The row's `bodyVersion`; required when changing the page body, so two people's page edits never overwrite each other. */
  expectedVersion: z.int().positive().optional(),
});
export type UpdateRowInput = z.infer<typeof UpdateRowSchema>;

export const CreateDatabaseSchema = z.strictObject({
  id: uuid.optional(),
  name: z.string().trim().min(1, 'Required').max(200),
  description: z.string().max(2000).optional(),
  /** Import (e.g. a Notion or spreadsheet CSV): columns after the title, and rows of text aligned to them. */
  import: z
    .strictObject({
      fields: z.array(z.strictObject({ name: fieldName, type: FieldTypeEnum, choices: z.array(z.string().trim().min(1).max(100)).max(100).optional() })).max(50),
      rows: z.array(z.strictObject({ title: rowTitle, cells: z.array(z.string().max(10_000)).max(50) })).max(1000),
    })
    .optional(),
});
/** More imported rows (requests are limited to 1 MB, so large imports are sent in batches). Cells follow field order. */
export const ImportRowsSchema = z.strictObject({
  rows: z.array(z.strictObject({ title: rowTitle, cells: z.array(z.string().max(10_000)).max(50) })).min(1).max(1000),
});
export type ImportRowsInput = z.infer<typeof ImportRowsSchema>;
export type CreateDatabaseInput = z.infer<typeof CreateDatabaseSchema>;
export const UpdateDatabaseSchema = z.strictObject({
  name: z.string().trim().min(1, 'Required').max(200).optional(),
  description: z.string().max(2000).optional(),
});
export type UpdateDatabaseInput = z.infer<typeof UpdateDatabaseSchema>;

export interface DatabaseSummaryDto {
  id: string;
  name: string;
  description: string;
  rowCount: number;
  updatedAt: string;
}
export interface DatabaseFieldDto {
  id: string;
  name: string;
  type: FieldType;
  options: { choices?: { id: string; label: string; color: string }[] };
  position: number;
}
export interface DatabaseViewDto {
  id: string;
  name: string;
  layout: 'table' | 'board';
  config: ViewConfig;
  position: number;
}
export interface DatabaseRowDto {
  id: string;
  title: string;
  values: Record<string, unknown>;
  /** Whether the row's page has content (the body itself comes from GET /database-rows/:id). */
  hasBody: boolean;
  body?: string;
  position: number;
  version: number;
  /** Changes only when the page body changes; send it as expectedVersion when saving the page. */
  bodyVersion: number;
  createdAt: string;
  updatedAt: string;
  createdBy: { id: string; name: string };
  updatedBy: { id: string; name: string };
}
export interface DatabaseDto {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  role: 'ADMIN' | 'MEMBER' | 'VIEWER';
  fields: DatabaseFieldDto[];
  views: DatabaseViewDto[];
  rows: DatabaseRowDto[];
}

// ---------- CRM ----------
const shortText = (max: number) => z.string().trim().max(max);
const longText = z.string().max(20_000);
const money = z.int().min(-1_000_000_000_000).max(1_000_000_000_000);
const currency = z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code, e.g. GBP');
const optionalUuid = uuid.nullable().optional();
const webUrl = z.union([z.literal(''), z.string().max(500).regex(/^https?:\/\/\S+$/i, 'Must start with http:// or https://')]);

export const CompanySchema = z.strictObject({
  id: uuid.optional(),
  name: name,
  website: webUrl.optional(),
  industry: shortText(100).optional(),
  phone: shortText(50).optional(),
  address: shortText(500).optional(),
  notes: longText.optional(),
  ownerId: optionalUuid,
});
export const UpdateCompanySchema = CompanySchema.omit({ id: true }).partial();
export type CompanyInput = z.infer<typeof CompanySchema>;
export type UpdateCompanyInput = z.infer<typeof UpdateCompanySchema>;

export const ContactSchema = z.strictObject({
  id: uuid.optional(),
  name: name,
  email: z.union([z.literal(''), z.email().max(320)]).optional(),
  phone: shortText(50).optional(),
  jobTitle: shortText(150).optional(),
  notes: longText.optional(),
  companyId: optionalUuid,
  ownerId: optionalUuid,
});
export const UpdateContactSchema = ContactSchema.omit({ id: true }).partial();
export type ContactInput = z.infer<typeof ContactSchema>;
export type UpdateContactInput = z.infer<typeof UpdateContactSchema>;

export const DealSchema = z.strictObject({
  id: uuid.optional(),
  title: name,
  companyId: optionalUuid,
  contactId: optionalUuid,
  stage: z.enum(DEAL_STAGES).optional(),
  value: money.min(0).optional(),
  currency: currency.optional(),
  expectedClose: isoDate.nullable().optional(),
  ownerId: optionalUuid,
  lostReason: shortText(500).optional(),
  notes: longText.optional(),
  position: z.number().finite().optional(),
});
export const UpdateDealSchema = DealSchema.omit({ id: true }).partial();
export type DealInput = z.infer<typeof DealSchema>;
export type UpdateDealInput = z.infer<typeof UpdateDealSchema>;

export const ActivitySchema = z
  .strictObject({
    id: uuid.optional(),
    type: z.enum(ACTIVITY_TYPES),
    subject: z.string().trim().min(1, 'Required').max(300),
    body: longText.optional(),
    companyId: optionalUuid,
    contactId: optionalUuid,
    dealId: optionalUuid,
    dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
    assigneeId: optionalUuid,
    done: z.boolean().optional(),
  })
  .refine((a) => a.companyId || a.contactId || a.dealId, { message: 'Link the activity to a company, contact or deal', path: ['companyId'] });
export const UpdateActivitySchema = z.strictObject({
  subject: z.string().trim().min(1).max(300).optional(),
  body: longText.optional(),
  dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
  assigneeId: optionalUuid,
  done: z.boolean().optional(),
});
export type ActivityInput = z.infer<typeof ActivitySchema>;
export type UpdateActivityInput = z.infer<typeof UpdateActivitySchema>;

const quoteLine = z.strictObject({
  description: z.string().trim().min(1, 'Describe the item').max(500),
  quantity: z.number().finite().min(0).max(1_000_000).refine((n) => Math.round(n * 1000) === n * 1000, 'At most 3 decimals'),
  unitPrice: money,
  taxRate: z.number().finite().min(0).max(100),
});
export const QuoteSchema = z.strictObject({
  id: uuid.optional(),
  title: name,
  companyId: optionalUuid,
  contactId: optionalUuid,
  dealId: optionalUuid,
  status: z.enum(QUOTE_STATUSES).optional(),
  currency: currency.optional(),
  issueDate: isoDate.optional(),
  validUntil: isoDate.nullable().optional(),
  lines: z.array(quoteLine).max(200).optional(),
  notes: longText.optional(),
});
export const UpdateQuoteSchema = QuoteSchema.omit({ id: true }).partial();
export type QuoteInput = z.infer<typeof QuoteSchema>;
export type UpdateQuoteInput = z.infer<typeof UpdateQuoteSchema>;

type Person = { id: string; name: string } | null;
export interface CompanyDto {
  id: string; workspaceId: string; name: string; website: string; industry: string; phone: string; address: string; notes: string;
  owner: Person; contactCount: number; /** Open deal value per currency (never added across currencies). */ openDeals: { currency: string; value: number }[]; createdAt: string; updatedAt: string;
}
export interface ContactDto {
  id: string; workspaceId: string; name: string; email: string; phone: string; jobTitle: string; notes: string;
  company: { id: string; name: string } | null; owner: Person; createdAt: string; updatedAt: string;
}
export interface DealDto {
  id: string; workspaceId: string; title: string; stage: (typeof DEAL_STAGES)[number]; value: number; currency: string;
  expectedClose: string | null; lostReason: string; closedAt: string | null; position: number; notes: string;
  company: { id: string; name: string } | null; contact: { id: string; name: string } | null; owner: Person; createdAt: string; updatedAt: string;
}
export interface CrmActivityDto {
  id: string; type: (typeof ACTIVITY_TYPES)[number]; subject: string; body: string;
  company: { id: string; name: string } | null; contact: { id: string; name: string } | null; deal: { id: string; title: string } | null;
  dueAt: string | null; doneAt: string | null; assignee: Person; createdBy: { id: string; name: string }; createdAt: string;
}
export interface QuoteDto {
  id: string; workspaceId: string; number: string; title: string; status: (typeof QUOTE_STATUSES)[number]; currency: string;
  issueDate: string; validUntil: string | null; lines: { description: string; quantity: number; unitPrice: number; taxRate: number }[];
  subtotal: number; tax: number; total: number; notes: string;
  company: { id: string; name: string; address: string } | null; contact: { id: string; name: string; email: string } | null; deal: { id: string; title: string } | null;
  createdBy: { id: string; name: string }; createdAt: string; updatedAt: string;
}
export interface CrmSummaryDto {
  pipeline: { currency: string; openValue: number; weighted: number; wonThisMonth: number; stages: Record<(typeof DEAL_STAGES)[number], { count: number; value: number }> }[];
  winRate: number | null;
  counts: { companies: number; contacts: number; openDeals: number };
  myFollowUps: CrmActivityDto[];
}

// ---------- HR ----------
const hrText = (max: number) => z.string().trim().max(max);
export const HrPrivateSchema = z.strictObject({
  personalEmail: z.union([z.literal(''), z.email().max(320)]).optional(),
  personalPhone: hrText(50).optional(),
  homeAddress: hrText(500).optional(),
  dateOfBirth: z.union([z.literal(''), isoDate]).optional(),
  emergencyContact: hrText(300).optional(),
  /** Annual salary in minor units. HR admins only. */
  salary: z.int().min(0).max(100_000_000_000).nullable().optional(),
  salaryCurrency: z.string().regex(/^[A-Z]{3}$/).optional(),
  notes: z.string().max(5000).optional(),
});
export type HrPrivate = z.infer<typeof HrPrivateSchema>;
export const UpdateHrProfileSchema = z.strictObject({
  jobTitle: hrText(150).optional(),
  department: hrText(100).optional(),
  managerId: uuid.nullable().optional(),
  startDate: isoDate.nullable().optional(),
  endDate: isoDate.nullable().optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  location: hrText(150).optional(),
  workPhone: hrText(50).optional(),
  annualLeaveDays: z.number().finite().min(0).max(100).refine((n) => Math.round(n * 2) === n * 2, 'Use whole or half days').optional(),
  private: HrPrivateSchema.optional(),
});
export type UpdateHrProfileInput = z.infer<typeof UpdateHrProfileSchema>;

export const LeaveRequestSchema = z
  .strictObject({
    id: uuid.optional(),
    type: z.enum(LEAVE_TYPES),
    startDate: isoDate,
    endDate: isoDate,
    halfDay: z.boolean().optional(),
    reason: z.string().max(1000).optional(),
    /** HR admins can record leave for someone else (e.g. sickness reported by phone). */
    userId: uuid.optional(),
  })
  .refine((r) => r.endDate >= r.startDate, { message: 'The end date is before the start date', path: ['endDate'] })
  .refine((r) => !r.halfDay || r.startDate === r.endDate, { message: 'Half days are for single-day requests', path: ['halfDay'] });
export type LeaveRequestInput = z.infer<typeof LeaveRequestSchema>;
export const LeaveDecisionSchema = z.strictObject({ decision: z.enum(['approved', 'declined']), note: z.string().max(1000).optional() });
export type LeaveDecisionInput = z.infer<typeof LeaveDecisionSchema>;

export const ChecklistSchema = z.strictObject({
  id: uuid.optional(),
  kind: z.enum(['onboarding', 'offboarding']),
  subjectName: name,
  subjectUserId: uuid.nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  /** Who does the HR, manager and IT steps of the template. */
  assignees: z.strictObject({ hr: uuid.nullable().optional(), manager: uuid.nullable().optional(), it: uuid.nullable().optional() }).optional(),
});
export type ChecklistInput = z.infer<typeof ChecklistSchema>;
export const ChecklistItemSchema = z.strictObject({ title: z.string().trim().min(1).max(300), assigneeId: uuid.nullable().optional(), dueDate: isoDate.nullable().optional() });
export const UpdateChecklistItemSchema = z.strictObject({ title: z.string().trim().min(1).max(300).optional(), assigneeId: uuid.nullable().optional(), dueDate: isoDate.nullable().optional(), done: z.boolean().optional() });
export type ChecklistItemInput = z.infer<typeof ChecklistItemSchema>;
export type UpdateChecklistItemInput = z.infer<typeof UpdateChecklistItemSchema>;

const reviewBody = z.string().max(20_000);
export const ReviewSchema = z.strictObject({
  subjectUserId: uuid,
  period: z.string().trim().min(1, 'Required').max(100),
  rating: z.int().min(1).max(5).nullable().optional(),
  strengths: reviewBody.optional(),
  improvements: reviewBody.optional(),
  goals: reviewBody.optional(),
  notes: reviewBody.optional(),
});
export const UpdateReviewSchema = ReviewSchema.omit({ subjectUserId: true }).partial().extend({ share: z.boolean().optional() });
export type ReviewInput = z.infer<typeof ReviewSchema>;
export type UpdateReviewInput = z.infer<typeof UpdateReviewSchema>;
export const HrRoleSchema = z.strictObject({ userId: uuid, hrAdmin: z.boolean() });

export interface HrMeDto {
  organisationId: string;
  isHrAdmin: boolean;
  /** Owners choose HR admins. */
  isOwner: boolean;
  /** People I can approve leave for / see privately (my reports, all for HR admins). */
  reportIds: string[];
}
export interface HrPersonDto {
  userId: string; name: string; email: string;
  jobTitle: string; department: string; manager: { id: string; name: string } | null; startDate: string | null; endDate: string | null;
  employmentType: (typeof EMPLOYMENT_TYPES)[number]; location: string; workPhone: string; isHrAdmin: boolean;
}
export interface HrProfileDto extends HrPersonDto {
  annualLeaveDays: number;
  /** Present only for the person, HR admins and their management chain. Salary only for HR admins and the person. */
  private: HrPrivate | null;
  canEdit: { profile: boolean; personal: boolean; salary: boolean };
  balance: { year: number; allowance: number; taken: number; pending: number; remaining: number; remainingAfterPending: number } | null;
}
export interface LeaveDto {
  id: string; user: { id: string; name: string };
  /** 'away' when the viewer may not see the type (e.g. sickness). */
  type: (typeof LEAVE_TYPES)[number] | 'away';
  startDate: string; endDate: string; halfDay: boolean; days: number;
  reason: string | null; status: 'pending' | 'approved' | 'declined' | 'cancelled';
  decidedBy: { id: string; name: string } | null; decisionNote: string | null; createdAt: string;
  canDecide: boolean; canCancel: boolean;
}
export interface ChecklistItemDto { id: string; title: string; assignee: { id: string; name: string } | null; dueDate: string | null; doneAt: string | null; doneBy: { id: string; name: string } | null; canTick: boolean }
export interface ChecklistDto {
  id: string; kind: 'onboarding' | 'offboarding'; title: string; subjectName: string; subjectUserId: string | null; dueDate: string | null;
  items: ChecklistItemDto[]; done: number; total: number; createdAt: string;
}
export interface HrDocumentDto { id: string; category: (typeof HR_DOC_CATEGORIES)[number]; filename: string; contentType: string; sizeBytes: number; uploader: { id: string; name: string }; createdAt: string; url: string }
export interface ReviewDto {
  id: string; subject: { id: string; name: string }; reviewer: { id: string; name: string }; period: string; rating: number | null;
  strengths: string; improvements: string; goals: string; notes: string; status: 'draft' | 'shared'; sharedAt: string | null; createdAt: string; updatedAt: string; canEdit: boolean;
}
