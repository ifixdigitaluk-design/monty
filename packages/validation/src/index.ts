/**
 * API contract shared by server (validation) and clients (types).
 * Request schemas are strict: unknown fields are rejected.
 */
import { z } from 'zod';
import { isIsoDate } from '@monty/domain';

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
  type: 'mention' | 'assigned' | 'comment' | 'automation';
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
  type: 'project' | 'task' | 'comment' | 'document' | 'message';
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
