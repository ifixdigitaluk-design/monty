/**
 * Deterministic project readiness & health engine (ADR-007).
 * Pure function of project data: same input → same output. No AI, no I/O.
 */
import { IsoDate } from './dates';
import { isOpenStatus, TaskStatus } from './tasks';

export type ProjectLifecycle = 'DRAFT' | 'ACTIVE' | 'IN_REVIEW' | 'COMPLETED' | 'CANCELLED';

export type ComputedProjectStatus =
  | 'DRAFT'
  | 'READY_TO_START'
  | 'IN_PROGRESS'
  | 'AT_RISK'
  | 'BLOCKED'
  | 'IN_REVIEW'
  | 'READY_TO_DELIVER'
  | 'COMPLETED'
  | 'CANCELLED';

export type ReadinessRuleId =
  | 'objective_defined'
  | 'owner_assigned'
  | 'target_date_set'
  | 'has_tasks'
  | 'tasks_assigned'
  | 'no_open_blockers'
  | 'tasks_scheduled'
  | 'tasks_within_target'
  | 'target_date_not_passed';

export type RuleSeverity = 'required' | 'recommended';

export interface ReadinessProjectInput {
  objective: string;
  ownerId: string | null;
  targetDate: IsoDate | null;
  lifecycle: ProjectLifecycle;
}

export interface ReadinessTaskInput {
  id: string;
  title: string;
  status: TaskStatus;
  assigneeId: string | null;
  dueDate: IsoDate | null;
  blockedReason: string | null;
}

export interface ReadinessConfig {
  /** Rules the organisation has switched off. */
  disabledRules?: readonly ReadinessRuleId[];
  /** Per-rule severity overrides. */
  severity?: Partial<Record<ReadinessRuleId, RuleSeverity>>;
}

export interface ReadinessCheck {
  id: ReadinessRuleId;
  title: string;
  severity: RuleSeverity;
  passed: boolean;
  /** Human-readable explanation of the result. */
  reason: string;
  /** Tasks that cause a failure, so the UI can link to them. */
  affectedTaskIds: string[];
}

export interface ProjectHealth {
  totalTasks: number;
  openTasks: number;
  doneTasks: number;
  overdueTasks: number;
  blockedTasks: number;
  unassignedOpenTasks: number;
  percentComplete: number;
}

export interface ReadinessReport {
  ready: boolean;
  passedCount: number;
  checkCount: number;
  checks: ReadinessCheck[];
  health: ProjectHealth;
  computedStatus: ComputedProjectStatus;
  statusReasons: string[];
  evaluatedOn: IsoDate;
}

interface RuleDefinition {
  id: ReadinessRuleId;
  title: string;
  defaultSeverity: RuleSeverity;
  evaluate(ctx: EvalContext): { passed: boolean; reason: string; affectedTaskIds?: string[] };
}

interface EvalContext {
  project: ReadinessProjectInput;
  activeTasks: ReadinessTaskInput[]; // excludes CANCELLED
  openTasks: ReadinessTaskInput[];
  today: IsoDate;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const READINESS_RULES: readonly RuleDefinition[] = [
  {
    id: 'objective_defined',
    title: 'Objective defined',
    defaultSeverity: 'required',
    evaluate: ({ project }) =>
      project.objective.trim().length > 0
        ? { passed: true, reason: 'The project has a written objective.' }
        : { passed: false, reason: 'Add an objective that states what this project must achieve.' },
  },
  {
    id: 'owner_assigned',
    title: 'Owner assigned',
    defaultSeverity: 'required',
    evaluate: ({ project }) =>
      project.ownerId
        ? { passed: true, reason: 'The project has an accountable owner.' }
        : { passed: false, reason: 'Choose one person who is accountable for delivery.' },
  },
  {
    id: 'target_date_set',
    title: 'Target date set',
    defaultSeverity: 'required',
    evaluate: ({ project }) =>
      project.targetDate
        ? { passed: true, reason: `Target date is ${project.targetDate}.` }
        : { passed: false, reason: 'Set a target delivery date.' },
  },
  {
    id: 'has_tasks',
    title: 'Work is broken down',
    defaultSeverity: 'required',
    evaluate: ({ activeTasks }) =>
      activeTasks.length > 0
        ? { passed: true, reason: `${plural(activeTasks.length, 'task')} defined.` }
        : { passed: false, reason: 'Add at least one task describing the work.' },
  },
  {
    id: 'tasks_assigned',
    title: 'Open tasks have assignees',
    defaultSeverity: 'required',
    evaluate: ({ openTasks }) => {
      const missing = openTasks.filter((t) => !t.assigneeId);
      return missing.length === 0
        ? { passed: true, reason: 'Every open task has someone responsible.' }
        : {
            passed: false,
            reason: `${plural(missing.length, 'open task')} ${missing.length === 1 ? 'has' : 'have'} no assignee.`,
            affectedTaskIds: missing.map((t) => t.id),
          };
    },
  },
  {
    id: 'no_open_blockers',
    title: 'No unresolved blockers',
    defaultSeverity: 'required',
    evaluate: ({ openTasks }) => {
      const blocked = openTasks.filter((t) => t.blockedReason && t.blockedReason.trim().length > 0);
      return blocked.length === 0
        ? { passed: true, reason: 'No open task is marked as blocked.' }
        : {
            passed: false,
            reason: `${plural(blocked.length, 'task')} ${blocked.length === 1 ? 'is' : 'are'} blocked: ${blocked
              .slice(0, 3)
              .map((t) => `"${t.title}"`)
              .join(', ')}${blocked.length > 3 ? '…' : ''}.`,
            affectedTaskIds: blocked.map((t) => t.id),
          };
    },
  },
  {
    id: 'tasks_scheduled',
    title: 'Open tasks have due dates',
    defaultSeverity: 'recommended',
    evaluate: ({ openTasks }) => {
      const missing = openTasks.filter((t) => !t.dueDate);
      return missing.length === 0
        ? { passed: true, reason: 'Every open task has a due date.' }
        : {
            passed: false,
            reason: `${plural(missing.length, 'open task')} ${missing.length === 1 ? 'has' : 'have'} no due date.`,
            affectedTaskIds: missing.map((t) => t.id),
          };
    },
  },
  {
    id: 'tasks_within_target',
    title: 'Tasks fit before the target date',
    defaultSeverity: 'recommended',
    evaluate: ({ project, openTasks }) => {
      if (!project.targetDate) return { passed: true, reason: 'No target date to compare against.' };
      const late = openTasks.filter((t) => t.dueDate && t.dueDate > project.targetDate!);
      return late.length === 0
        ? { passed: true, reason: 'All scheduled tasks are due on or before the target date.' }
        : {
            passed: false,
            reason: `${plural(late.length, 'task')} ${late.length === 1 ? 'is' : 'are'} due after the target date (${project.targetDate}).`,
            affectedTaskIds: late.map((t) => t.id),
          };
    },
  },
  {
    id: 'target_date_not_passed',
    title: 'Target date is in the future',
    defaultSeverity: 'recommended',
    evaluate: ({ project, openTasks, today }) => {
      if (!project.targetDate) return { passed: true, reason: 'No target date set.' };
      if (project.targetDate >= today || openTasks.length === 0)
        return { passed: true, reason: 'The target date has not passed with work outstanding.' };
      return {
        passed: false,
        reason: `The target date (${project.targetDate}) has passed with ${plural(openTasks.length, 'open task')}.`,
      };
    },
  },
];

export function evaluateReadiness(
  project: ReadinessProjectInput,
  tasks: readonly ReadinessTaskInput[],
  today: IsoDate,
  config: ReadinessConfig = {},
): ReadinessReport {
  const activeTasks = tasks.filter((t) => t.status !== 'CANCELLED');
  const openTasks = activeTasks.filter((t) => isOpenStatus(t.status));
  const ctx: EvalContext = { project, activeTasks, openTasks, today };
  const disabled = new Set(config.disabledRules ?? []);

  const checks: ReadinessCheck[] = READINESS_RULES.filter((r) => !disabled.has(r.id)).map((rule) => {
    const result = rule.evaluate(ctx);
    return {
      id: rule.id,
      title: rule.title,
      severity: config.severity?.[rule.id] ?? rule.defaultSeverity,
      passed: result.passed,
      reason: result.reason,
      affectedTaskIds: result.affectedTaskIds ?? [],
    };
  });

  const ready = checks.filter((c) => c.severity === 'required').every((c) => c.passed);

  const doneTasks = activeTasks.filter((t) => t.status === 'DONE').length;
  const overdue = openTasks.filter((t) => t.dueDate && t.dueDate < today);
  const blocked = openTasks.filter((t) => t.blockedReason && t.blockedReason.trim().length > 0);
  const health: ProjectHealth = {
    totalTasks: activeTasks.length,
    openTasks: openTasks.length,
    doneTasks,
    overdueTasks: overdue.length,
    blockedTasks: blocked.length,
    unassignedOpenTasks: openTasks.filter((t) => !t.assigneeId).length,
    percentComplete: activeTasks.length === 0 ? 0 : Math.round((doneTasks / activeTasks.length) * 100),
  };

  const { status, reasons } = computeStatus(project, health, ready, checks, today);

  return {
    ready,
    passedCount: checks.filter((c) => c.passed).length,
    checkCount: checks.length,
    checks,
    health,
    computedStatus: status,
    statusReasons: reasons,
    evaluatedOn: today,
  };
}

function computeStatus(
  project: ReadinessProjectInput,
  health: ProjectHealth,
  ready: boolean,
  checks: ReadinessCheck[],
  today: IsoDate,
): { status: ComputedProjectStatus; reasons: string[] } {
  switch (project.lifecycle) {
    case 'CANCELLED':
      return { status: 'CANCELLED', reasons: ['The project was cancelled.'] };
    case 'COMPLETED':
      return { status: 'COMPLETED', reasons: ['The project was marked completed.'] };
    case 'IN_REVIEW':
      return { status: 'IN_REVIEW', reasons: ['The project is in review.'] };
    case 'DRAFT': {
      if (ready) return { status: 'READY_TO_START', reasons: ['All required readiness checks pass.'] };
      const failing = checks.filter((c) => c.severity === 'required' && !c.passed).map((c) => c.reason);
      return { status: 'DRAFT', reasons: failing };
    }
    case 'ACTIVE': {
      if (health.blockedTasks > 0)
        return { status: 'BLOCKED', reasons: [`${plural(health.blockedTasks, 'open task')} blocked.`] };
      if (health.totalTasks > 0 && health.openTasks === 0)
        return { status: 'READY_TO_DELIVER', reasons: ['All tasks are done.'] };
      const reasons: string[] = [];
      if (health.overdueTasks > 0) reasons.push(`${plural(health.overdueTasks, 'task')} overdue.`);
      if (project.targetDate && project.targetDate < today && health.openTasks > 0)
        reasons.push(`Target date ${project.targetDate} has passed.`);
      if (reasons.length > 0) return { status: 'AT_RISK', reasons };
      return { status: 'IN_PROGRESS', reasons: ['Work is under way with nothing overdue or blocked.'] };
    }
  }
}
