/** Task dependency graph rules. An edge (task → dependsOn) means "task waits for dependsOn". */
export interface DependencyEdge {
  taskId: string;
  dependsOnTaskId: string;
}

/** True if adding task → dependsOn would create a cycle (including a self-dependency). */
export function wouldCreateCycle(edges: readonly DependencyEdge[], taskId: string, dependsOnTaskId: string): boolean {
  if (taskId === dependsOnTaskId) return true;
  const next = new Map<string, string[]>();
  for (const e of edges) next.set(e.taskId, [...(next.get(e.taskId) ?? []), e.dependsOnTaskId]);
  // Cycle iff taskId is reachable from dependsOnTaskId.
  const stack = [dependsOnTaskId];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === taskId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(next.get(cur) ?? []));
  }
  return false;
}
