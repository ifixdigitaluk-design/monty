import { describe, expect, it } from 'vitest';
import { wouldCreateCycle } from '../src/dependencies';
import { evaluateReadiness } from '../src/readiness';

describe('wouldCreateCycle', () => {
  const edges = [
    { taskId: 'b', dependsOnTaskId: 'a' },
    { taskId: 'c', dependsOnTaskId: 'b' },
  ];
  it('detects self, direct and transitive cycles', () => {
    expect(wouldCreateCycle(edges, 'a', 'a')).toBe(true);
    expect(wouldCreateCycle(edges, 'a', 'b')).toBe(true);
    expect(wouldCreateCycle(edges, 'a', 'c')).toBe(true);
  });
  it('allows acyclic edges', () => {
    expect(wouldCreateCycle(edges, 'c', 'a')).toBe(false);
    expect(wouldCreateCycle(edges, 'd', 'c')).toBe(false);
  });
});

describe('dependencies_ordered readiness rule', () => {
  const project = { objective: 'x', ownerId: 'u', targetDate: '2030-12-01', lifecycle: 'ACTIVE' as const };
  const t = (id: string, due: string | null, dependsOn: string[] = [], status: 'TODO' | 'DONE' = 'TODO') => ({
    id, title: id, status, assigneeId: 'u', dueDate: due, blockedReason: null, dependsOn,
  });
  it('flags a task due before the task it depends on', () => {
    const r = evaluateReadiness(project, [t('a', '2030-02-01'), t('b', '2030-01-01', ['a'])], '2030-01-01');
    expect(r.checks.find((c) => c.id === 'dependencies_ordered')).toMatchObject({ passed: false, affectedTaskIds: ['b'] });
    expect(r.health.waitingTasks).toBe(1);
  });
  it('passes when the dependency is done or scheduled first', () => {
    expect(evaluateReadiness(project, [t('a', '2030-01-01'), t('b', '2030-02-01', ['a'])], '2030-01-01').checks.find((c) => c.id === 'dependencies_ordered')!.passed).toBe(true);
    const done = evaluateReadiness(project, [t('a', '2030-03-01', [], 'DONE'), t('b', '2030-02-01', ['a'])], '2030-01-01');
    expect(done.checks.find((c) => c.id === 'dependencies_ordered')!.passed).toBe(true);
    expect(done.health.waitingTasks).toBe(0);
  });
});
