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
export const RegisterSchema = z.strictObject({
  email: z.email().max(320).transform((e) => e.toLowerCase()),
  name: name,
  password: z.string().min(10, 'Use at least 10 characters').max(200),
});
export type RegisterInput = z.infer<typeof RegisterSchema>;

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
  type: 'mention' | 'assigned' | 'comment';
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
  type: 'project' | 'task' | 'comment';
  id: string;
  title: string;
  snippet: string;
  projectId: string;
  projectName: string;
  taskId: string | null;
  workspaceName: string;
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
