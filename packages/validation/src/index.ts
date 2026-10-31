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
});
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;

export const TodayQuerySchema = z.strictObject({ today: isoDate.optional() });

// ---------- response DTOs (types only) ----------
export interface UserDto {
  id: string;
  email: string;
  name: string;
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
