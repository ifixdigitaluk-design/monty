import { describe, expect, it } from 'vitest';
import { evaluateReadiness, ReadinessProjectInput, ReadinessTaskInput } from '../src/readiness';

const today = '2026-10-31';
const baseProject: ReadinessProjectInput = {
  objective: 'Launch the new website',
  ownerId: 'u1',
  targetDate: '2026-12-01',
  lifecycle: 'DRAFT',
};
const task = (over: Partial<ReadinessTaskInput> = {}): ReadinessTaskInput => ({
  id: over.id ?? 't1',
  title: 'Design homepage',
  status: 'TODO',
  assigneeId: 'u1',
  dueDate: '2026-11-15',
  blockedReason: null,
  ...over,
});

describe('evaluateReadiness', () => {
  it('is ready when every required rule passes', () => {
    const r = evaluateReadiness(baseProject, [task()], today);
    expect(r.ready).toBe(true);
    expect(r.computedStatus).toBe('READY_TO_START');
    expect(r.checks.every((c) => c.passed)).toBe(true);
  });

  it('explains every missing requirement for an empty draft', () => {
    const r = evaluateReadiness({ objective: ' ', ownerId: null, targetDate: null, lifecycle: 'DRAFT' }, [], today);
    expect(r.ready).toBe(false);
    expect(r.computedStatus).toBe('DRAFT');
    const failed = r.checks.filter((c) => !c.passed).map((c) => c.id);
    expect(failed).toEqual(['objective_defined', 'owner_assigned', 'target_date_set', 'has_tasks']);
    expect(r.statusReasons).toHaveLength(4);
  });

  it('flags unassigned tasks with their ids', () => {
    const r = evaluateReadiness(baseProject, [task({ id: 'a', assigneeId: null }), task({ id: 'b' })], today);
    const check = r.checks.find((c) => c.id === 'tasks_assigned')!;
    expect(check.passed).toBe(false);
    expect(check.affectedTaskIds).toEqual(['a']);
    expect(r.ready).toBe(false);
  });

  it('ignores done and cancelled tasks for assignment and blockers', () => {
    const r = evaluateReadiness(
      baseProject,
      [task({ id: 'a' }), task({ id: 'b', status: 'DONE', assigneeId: null, blockedReason: 'x' }), task({ id: 'c', status: 'CANCELLED' })],
      today,
    );
    expect(r.ready).toBe(true);
    expect(r.health.totalTasks).toBe(2);
    expect(r.health.percentComplete).toBe(50);
  });

  it('recommended failures do not block readiness', () => {
    const r = evaluateReadiness(baseProject, [task({ dueDate: null })], today);
    expect(r.ready).toBe(true);
    expect(r.checks.find((c) => c.id === 'tasks_scheduled')!.passed).toBe(false);
  });

  it('respects organisation configuration', () => {
    const r = evaluateReadiness({ ...baseProject, ownerId: null }, [task()], today, {
      disabledRules: ['owner_assigned'],
      severity: { tasks_scheduled: 'required' },
    });
    expect(r.checks.find((c) => c.id === 'owner_assigned')).toBeUndefined();
    expect(r.ready).toBe(true);
    const r2 = evaluateReadiness(baseProject, [task({ dueDate: null })], today, { severity: { tasks_scheduled: 'required' } });
    expect(r2.ready).toBe(false);
  });

  describe('computed status for active projects', () => {
    const active = { ...baseProject, lifecycle: 'ACTIVE' as const };
    it('BLOCKED when an open task has a blocker', () => {
      expect(evaluateReadiness(active, [task({ blockedReason: 'Waiting for client' })], today).computedStatus).toBe('BLOCKED');
    });
    it('AT_RISK when tasks are overdue', () => {
      const r = evaluateReadiness(active, [task({ dueDate: '2026-10-01' })], today);
      expect(r.computedStatus).toBe('AT_RISK');
      expect(r.health.overdueTasks).toBe(1);
    });
    it('AT_RISK when the target date has passed', () => {
      expect(evaluateReadiness({ ...active, targetDate: '2026-10-30' }, [task({ dueDate: null })], today).computedStatus).toBe('AT_RISK');
    });
    it('READY_TO_DELIVER when all tasks are done', () => {
      expect(evaluateReadiness(active, [task({ status: 'DONE' })], today).computedStatus).toBe('READY_TO_DELIVER');
    });
    it('IN_PROGRESS otherwise', () => {
      expect(evaluateReadiness(active, [task()], today).computedStatus).toBe('IN_PROGRESS');
    });
  });

  it('is deterministic', () => {
    const tasks = [task({ id: 'a', assigneeId: null }), task({ id: 'b', blockedReason: 'x' })];
    expect(evaluateReadiness(baseProject, tasks, today)).toEqual(evaluateReadiness(baseProject, tasks, today));
  });
});
