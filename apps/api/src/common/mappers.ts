import type { Project, Task } from '@monty/database';
import type { ProjectDto, TaskDto } from '@monty/validation';

export function toProjectDto(p: Project): ProjectDto {
  return {
    id: p.id,
    organisationId: p.organisationId,
    workspaceId: p.workspaceId,
    name: p.name,
    objective: p.objective,
    description: p.description,
    lifecycle: p.lifecycle,
    priority: p.priority,
    ownerId: p.ownerId,
    createdById: p.createdById,
    startDate: p.startDate,
    targetDate: p.targetDate,
    version: p.version,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export function toTaskDto(t: Task): TaskDto {
  return {
    id: t.id,
    projectId: t.projectId,
    workspaceId: t.workspaceId,
    parentTaskId: t.parentTaskId,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    assigneeId: t.assigneeId,
    creatorId: t.creatorId,
    startDate: t.startDate,
    dueDate: t.dueDate,
    estimateMinutes: t.estimateMinutes,
    blockedReason: t.blockedReason,
    sortOrder: t.sortOrder,
    milestoneId: t.milestoneId,
    completedAt: t.completedAt?.toISOString() ?? null,
    version: t.version,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}
