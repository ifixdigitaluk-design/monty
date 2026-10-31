import type { ComputedProjectStatus } from '@monty/domain';
import type { OrgRoleValue, Priority, ProjectLifecycle, TaskDto, WorkspaceRoleValue } from '@monty/validation';

export const TASK_STATUS_LABEL: Record<TaskDto['status'], string> = {
  TODO: 'To do',
  IN_PROGRESS: 'In progress',
  IN_REVIEW: 'In review',
  DONE: 'Done',
  CANCELLED: 'Cancelled',
};
export const BOARD_COLUMNS: TaskDto['status'][] = ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'];

export const PRIORITY_LABEL: Record<Priority, string> = {
  NONE: 'No priority',
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  URGENT: 'Urgent',
};

export const LIFECYCLE_LABEL: Record<ProjectLifecycle, string> = {
  DRAFT: 'Draft (planning)',
  ACTIVE: 'Active',
  IN_REVIEW: 'In review',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export const STATUS_LABEL: Record<ComputedProjectStatus, string> = {
  DRAFT: 'Draft',
  READY_TO_START: 'Ready to start',
  IN_PROGRESS: 'In progress',
  AT_RISK: 'At risk',
  BLOCKED: 'Blocked',
  IN_REVIEW: 'In review',
  READY_TO_DELIVER: 'Ready to deliver',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export const STATUS_TONE: Record<ComputedProjectStatus, 'neutral' | 'success' | 'warning' | 'danger' | 'accent'> = {
  DRAFT: 'neutral',
  READY_TO_START: 'success',
  IN_PROGRESS: 'accent',
  AT_RISK: 'warning',
  BLOCKED: 'danger',
  IN_REVIEW: 'accent',
  READY_TO_DELIVER: 'success',
  COMPLETED: 'success',
  CANCELLED: 'neutral',
};

export const ORG_ROLE_LABEL: Record<OrgRoleValue, string> = { OWNER: 'Owner', ADMIN: 'Admin', MEMBER: 'Member', GUEST: 'Guest' };
export const WS_ROLE_LABEL: Record<WorkspaceRoleValue, string> = { ADMIN: 'Admin', MEMBER: 'Member', VIEWER: 'Viewer' };
