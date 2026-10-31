import { randomBytes } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lt, notInArray, sql } from 'drizzle-orm';
import { canInWorkspace, todayUtc } from '@monty/domain';
import { automationRules, automationRuns, isUniqueViolation, outboxEvents, tasks, users } from '@monty/database';
import type {
  AutomationAction,
  AutomationConditions,
  AutomationRuleDto,
  AutomationRunDto,
  AutomationTrigger,
  CreateAutomationInput,
  UpdateAutomationInput,
} from '@monty/validation';
import type { RealtimeEvent } from '../activity/activity';
import { AuditService, ClientInfo } from '../audit/audit.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { CollaborationService } from '../collaboration/collaboration.service';
import { AppException, badRequest, conflict, notFound } from '../common/errors';
import { DbService } from '../db/db.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TasksService } from '../tasks/tasks.service';
import { AccessService } from '../tenancy/access.service';
import { sendWebhook, WebhookSender } from './webhook';

type Rule = typeof automationRules.$inferSelect;
interface TaskSnapshot {
  id: string;
  projectId: string;
  workspaceId: string;
  title: string;
  status: string;
  priority: string;
  assigneeId: string | null;
  creatorId: string;
  dueDate: string | null;
}
type Changes = Record<string, { from: unknown; to: unknown }>;

const MAX_ATTEMPTS = 3;
const SWEEP_MS = 15 * 60_000;

/** A rule that should not act (and must not be retried): recorded as SKIPPED. */
class Skip extends Error {}

/** Pure condition check, exported for unit tests. */
export function ruleMatches(conditions: AutomationConditions, t: TaskSnapshot, changes: Changes | undefined): boolean {
  if (conditions.projectId && conditions.projectId !== t.projectId) return false;
  if (conditions.status && conditions.status !== t.status) return false;
  if (conditions.priority && conditions.priority !== t.priority) return false;
  if (conditions.assigneeId !== undefined && conditions.assigneeId !== t.assigneeId) return false;
  if (conditions.toStatus && changes?.status?.to !== conditions.toStatus) return false;
  return true;
}

/**
 * Workspace automations: "when <trigger> and <conditions>, do <actions>".
 *
 * Safety properties (covered by tests):
 * - Runs are claimed with a unique (rule, event) key, so each event acts at most once per rule even with several
 *   API instances listening.
 * - Changes made by automations are tagged (app.origin) and never trigger automations again: no loops.
 * - Actions run as the rule's author, under their RLS context and permission checks; if they are no longer a
 *   workspace admin the rule is skipped rather than acting with stale authority.
 * - Every run is logged with its outcome; transient failures are retried up to 3 times.
 * Known limitation: events are consumed live; changes committed while no API instance is running are not
 * processed later (time-based "overdue" rules do catch up on the next sweep).
 */
@Injectable()
export class AutomationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Automations');
  private readonly inflight = new Set<Promise<void>>();
  private sender: WebhookSender = sendWebhook;
  private timer: NodeJS.Timeout | null = null;
  private retryDelayMs = 1_000;

  constructor(
    private readonly dbs: DbService,
    private readonly access: AccessService,
    private readonly tasks: TasksService,
    private readonly collab: CollaborationService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
  ) {}

  onModuleInit() {
    this.realtime.onEvent((e) => this.handle(e));
    this.timer = setInterval(() => this.track(this.sweepOverdue().then(() => undefined)), SWEEP_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // ---------- test hooks ----------
  useWebhookSender(sender: WebhookSender) {
    this.sender = sender;
  }
  setRetryDelay(ms: number) {
    this.retryDelayMs = ms;
  }
  /** Waits until all queued automation work has finished. */
  async drain() {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  private track(p: Promise<void>) {
    const tracked = p.catch((err) => this.logger.error(JSON.stringify({ msg: 'automation_error', error: String(err) })));
    this.inflight.add(tracked);
    void tracked.finally(() => this.inflight.delete(tracked));
  }

  /** Called for every committed change (see RealtimeService.onEvent). */
  handle(e: RealtimeEvent) {
    if (e.topic !== 'task.created' && e.topic !== 'task.updated') return;
    this.track(this.onTaskEvent(e));
  }

  private async onTaskEvent(e: RealtimeEvent) {
    const loaded = await this.dbs.runAsSystem(async () => {
      const [ev] = await this.dbs.db.select({ payload: outboxEvents.payload }).from(outboxEvents).where(eq(outboxEvents.id, e.id));
      if (!ev) return null;
      const payload = ev.payload as unknown as TaskSnapshot & { _origin?: string; _changes?: Changes };
      if (payload._origin === 'automation') return null; // never react to our own changes
      const triggers: AutomationTrigger[] = e.topic === 'task.created' ? ['task.created'] : ['task.updated'];
      if (e.topic === 'task.updated' && payload._changes?.status) triggers.push('task.status_changed');
      const rules = await this.dbs.db
        .select()
        .from(automationRules)
        .where(
          and(
            eq(automationRules.workspaceId, e.workspaceId),
            eq(automationRules.enabled, true),
            isNull(automationRules.deletedAt),
            inArray(automationRules.trigger, triggers),
          ),
        );
      return { payload, rules };
    });
    if (!loaded) return;
    for (const rule of loaded.rules) {
      if (!ruleMatches(rule.conditions as AutomationConditions, loaded.payload, loaded.payload._changes)) continue;
      await this.run(rule, e.id, loaded.payload.id);
    }
  }

  /** Finds open tasks past their due date in workspaces with "overdue" rules. Each task/due date acts once. */
  async sweepOverdue(): Promise<number> {
    const today = todayUtc();
    const pairs = await this.dbs.runAsSystem(() =>
      this.dbs.db
        .select({ rule: automationRules, task: tasks })
        .from(automationRules)
        .innerJoin(tasks, eq(tasks.workspaceId, automationRules.workspaceId))
        .where(
          and(
            eq(automationRules.trigger, 'task.overdue'),
            eq(automationRules.enabled, true),
            isNull(automationRules.deletedAt),
            isNull(tasks.deletedAt),
            lt(tasks.dueDate, today),
            notInArray(tasks.status, ['DONE', 'CANCELLED']),
            sql`not exists (select 1 from automation_runs r where r.rule_id = ${automationRules.id} and r.event_key = 'overdue:' || ${tasks.id}::text || ':' || ${tasks.dueDate}::text)`,
          ),
        )
        .limit(500),
    );
    let ran = 0;
    for (const { rule, task } of pairs) {
      if (!ruleMatches(rule.conditions as AutomationConditions, task, undefined)) continue;
      if (await this.run(rule, `overdue:${task.id}:${task.dueDate}`, task.id)) ran += 1;
    }
    return ran;
  }

  /** Claims, executes (with retries) and records one run. Returns false if another worker already claimed it. */
  private async run(rule: Rule, eventKey: string, taskId: string): Promise<boolean> {
    const [claim] = await this.dbs.runAsSystem(() =>
      this.dbs.db
        .insert(automationRuns)
        .values({ ruleId: rule.id, organisationId: rule.organisationId, workspaceId: rule.workspaceId, eventKey, taskId, status: 'RUNNING' })
        .onConflictDoNothing()
        .returning({ id: automationRuns.id }),
    );
    if (!claim) return false;

    let status: AutomationRunDto['status'] = 'FAILED';
    let detail: Record<string, unknown> = {};
    let error: string | null = null;
    let attempts = 0;
    while (attempts < MAX_ATTEMPTS) {
      attempts += 1;
      try {
        detail = await this.perform(rule, taskId, claim.id);
        status = 'SUCCEEDED';
        error = null;
        break;
      } catch (err) {
        error = err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
        if (err instanceof Skip) {
          status = 'SKIPPED';
          break;
        }
        // Client errors other than a concurrent edit will not fix themselves: stop retrying.
        if (err instanceof AppException && err.getStatus() < 500 && err.getStatus() !== 409) break;
        if (attempts < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, this.retryDelayMs * attempts));
      }
    }
    await this.dbs.runAsSystem(() =>
      this.dbs.db.update(automationRuns).set({ status, detail, error, attempts, finishedAt: new Date() }).where(eq(automationRuns.id, claim.id)),
    );
    this.logger.log(JSON.stringify({ msg: 'automation_run', rule: rule.id, status, attempts }));
    return true;
  }

  private async perform(rule: Rule, taskId: string, runId: string): Promise<Record<string, unknown>> {
    const actions = rule.actions as unknown as AutomationAction[];
    const author = rule.createdById;
    const applied: string[] = [];
    const task = await this.dbs.runAsUser(
      author,
      async () => {
        const ws = await this.access.workspaceAccess(author, rule.workspaceId);
        if (!ws || !canInWorkspace(ws.role, 'workspace.manage')) throw new Skip('The rule author is no longer an admin of this workspace');
        const current = await this.dbs.db.query.tasks.findFirst({ where: and(eq(tasks.id, taskId), isNull(tasks.deletedAt)) });
        if (!current) throw new Skip('The task no longer exists');

        const changes: { status?: typeof current.status; priority?: typeof current.priority; assigneeId?: string | null } = {};
        for (const a of actions) {
          if (a.type === 'set_status' && a.status !== current.status) changes.status = a.status;
          if (a.type === 'set_priority' && a.priority !== current.priority) changes.priority = a.priority;
          if (a.type === 'assign' && a.assigneeId !== current.assigneeId) changes.assigneeId = a.assigneeId;
        }
        let after = current;
        if (Object.keys(changes).length) {
          const dto = await this.tasks.update(author, taskId, { expectedVersion: current.version, ...changes });
          after = { ...current, status: dto.status, priority: dto.priority, assigneeId: dto.assigneeId, version: dto.version };
          applied.push(...Object.keys(changes));
        }
        let index = 0;
        for (const a of actions) {
          index += 1;
          if (a.type !== 'notify') continue;
          const recipients = a.to
            .map((r) => (r === 'assignee' ? after.assigneeId : r === 'creator' ? after.creatorId : r))
            .filter((r): r is string => !!r);
          const n = await this.collab.notify({
            recipients,
            actorId: author,
            includeActor: true,
            organisationId: rule.organisationId,
            workspaceId: rule.workspaceId,
            projectId: after.projectId,
            type: 'automation',
            entityType: 'task',
            entityId: after.id,
            data: { title: after.title, ruleName: rule.name, message: a.message },
            dedupeKey: `automation:${runId}:${index}`,
          });
          applied.push(`notified ${n}`);
        }
        return after;
      },
      { origin: 'automation' },
    );

    const webhooks: { host: string; status: number }[] = [];
    for (const a of actions) {
      if (a.type !== 'webhook') continue;
      const body = JSON.stringify({
        event: rule.trigger,
        rule: { id: rule.id, name: rule.name },
        task: { id: task.id, projectId: task.projectId, title: task.title, status: task.status, priority: task.priority, assigneeId: task.assigneeId, dueDate: task.dueDate },
        runId,
      });
      const res = await this.sender(a.url, body, rule.webhookSecret ?? '');
      webhooks.push({ host: new URL(a.url).host, status: res.status });
    }
    return { applied, webhooks };
  }

  // ---------- management API ----------

  private async toDtos(rows: { r: Rule; creatorName: string }[]): Promise<AutomationRuleDto[]> {
    const ids = rows.map((x) => x.r.id);
    const last = ids.length
      ? await this.dbs.db.execute<{ id: string }>(
          sql`select distinct on (rule_id) * from automation_runs where rule_id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}) order by rule_id, created_at desc`,
        )
      : { rows: [] };
    const lastByRule = new Map(
      (last.rows as unknown as Record<string, unknown>[]).map((r) => [r.rule_id as string, this.runDtoFromRaw(r)]),
    );
    return rows.map(({ r, creatorName }) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      name: r.name,
      enabled: r.enabled,
      trigger: r.trigger as AutomationTrigger,
      conditions: r.conditions as AutomationConditions,
      actions: r.actions as unknown as AutomationAction[],
      webhookSecret: (r.actions as unknown as AutomationAction[]).some((a) => a.type === 'webhook') ? r.webhookSecret : null,
      createdBy: { id: r.createdById, name: creatorName },
      version: r.version,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      lastRun: lastByRule.get(r.id) ?? null,
    }));
  }

  private runDtoFromRaw(r: Record<string, unknown>): AutomationRunDto {
    const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
    return {
      id: r.id as string,
      ruleId: r.rule_id as string,
      taskId: (r.task_id as string | null) ?? null,
      status: r.status as AutomationRunDto['status'],
      attempts: r.attempts as number,
      detail: (r.detail as Record<string, unknown>) ?? {},
      error: (r.error as string | null) ?? null,
      createdAt: iso(r.created_at)!,
      finishedAt: iso(r.finished_at),
    };
  }

  private async loadRules(where: ReturnType<typeof and>) {
    return this.dbs.db
      .select({ r: automationRules, creatorName: users.name })
      .from(automationRules)
      .innerJoin(users, eq(users.id, automationRules.createdById))
      .where(where)
      .orderBy(automationRules.createdAt);
  }

  async list(userId: string, workspaceId: string): Promise<AutomationRuleDto[]> {
    await this.access.requireWorkspace(userId, workspaceId, 'workspace.manage');
    return this.toDtos(await this.loadRules(and(eq(automationRules.workspaceId, workspaceId), isNull(automationRules.deletedAt))));
  }

  private async get(ruleId: string): Promise<AutomationRuleDto> {
    const [dto] = await this.toDtos(await this.loadRules(and(eq(automationRules.id, ruleId))));
    return dto!;
  }

  private async assertReferences(workspaceId: string, conditions: AutomationConditions, actions: AutomationAction[]) {
    if (conditions.projectId) {
      const proj = await this.dbs.db.execute<{ ok: boolean }>(
        sql`select true as ok from projects where id = ${conditions.projectId} and workspace_id = ${workspaceId} and deleted_at is null`,
      );
      if (!proj.rows[0]) throw badRequest('Project must belong to this workspace', [{ path: 'conditions.projectId', message: 'Not in workspace' }]);
    }
    if (conditions.assigneeId) await this.access.assertCanBeAssigned(conditions.assigneeId, workspaceId, 'conditions.assigneeId');
    for (const [i, a] of actions.entries()) {
      if (a.type === 'assign') await this.access.assertCanBeAssigned(a.assigneeId, workspaceId, `actions.${i}.assigneeId`);
      if (a.type === 'notify') {
        for (const r of a.to) if (r !== 'assignee' && r !== 'creator') await this.access.assertCanBeAssigned(r, workspaceId, `actions.${i}.to`);
      }
    }
  }

  async create(userId: string, workspaceId: string, input: CreateAutomationInput, client: ClientInfo): Promise<{ rule: AutomationRuleDto; created: boolean }> {
    const { workspace } = await this.access.requireWorkspace(userId, workspaceId, 'workspace.manage');
    if (input.id) {
      const existing = await this.dbs.db.query.automationRules.findFirst({ where: eq(automationRules.id, input.id) });
      if (existing) {
        if (existing.createdById !== userId || existing.workspaceId !== workspaceId) throw conflict('CONFLICT', 'This id is already in use');
        return { rule: await this.get(existing.id), created: false };
      }
    }
    await this.entitlements.assertWithinLimit(workspace.organisationId, 'automationRules');
    await this.assertReferences(workspaceId, input.conditions, input.actions);
    try {
      const [row] = await this.dbs.db
        .insert(automationRules)
        .values({
          id: input.id,
          organisationId: workspace.organisationId,
          workspaceId,
          name: input.name,
          enabled: input.enabled,
          trigger: input.trigger,
          conditions: input.conditions,
          actions: input.actions as unknown as Record<string, unknown>[],
          webhookSecret: randomBytes(24).toString('base64url'),
          createdById: userId,
        })
        .returning();
      await this.audit.record({
        organisationId: workspace.organisationId,
        actorId: userId,
        action: 'automation.created',
        targetType: 'automation_rule',
        targetId: row!.id,
        data: { name: input.name, trigger: input.trigger, actions: input.actions.map((a) => a.type) },
        client,
      });
      return { rule: await this.get(row!.id), created: true };
    } catch (err) {
      if (input.id && isUniqueViolation(err)) throw conflict('CONFLICT', 'This id is already in use');
      throw err;
    }
  }

  private async requireRule(userId: string, ruleId: string) {
    const rule = await this.dbs.db.query.automationRules.findFirst({ where: and(eq(automationRules.id, ruleId), isNull(automationRules.deletedAt)) });
    if (!rule) throw notFound('Automation');
    const ws = await this.access.workspaceAccess(userId, rule.workspaceId);
    if (!ws) throw notFound('Automation');
    await this.access.requireWorkspace(userId, rule.workspaceId, 'workspace.manage');
    return rule;
  }

  async update(userId: string, ruleId: string, input: UpdateAutomationInput, client: ClientInfo): Promise<AutomationRuleDto> {
    const rule = await this.requireRule(userId, ruleId);
    const { expectedVersion, ...changes } = input;
    const trigger = changes.trigger ?? rule.trigger;
    const conditions = changes.conditions ?? (rule.conditions as AutomationConditions);
    if (conditions.toStatus && trigger !== 'task.status_changed') {
      throw badRequest('"Moved to status" only applies to the "status changed" trigger', [{ path: 'conditions.toStatus', message: 'Invalid for trigger' }]);
    }
    await this.assertReferences(rule.workspaceId, conditions, changes.actions ?? (rule.actions as unknown as AutomationAction[]));
    const [row] = await this.dbs.db
      .update(automationRules)
      .set({
        ...changes,
        actions: changes.actions as unknown as Record<string, unknown>[] | undefined,
        // Editing a rule makes the editor its author: it then runs with their permissions.
        createdById: userId,
        version: sql`${automationRules.version} + 1`,
      })
      .where(and(eq(automationRules.id, ruleId), eq(automationRules.version, expectedVersion), isNull(automationRules.deletedAt)))
      .returning();
    if (!row) throw conflict('VERSION_CONFLICT', 'This automation was changed by someone else. Reload to see the latest version.');
    await this.audit.record({
      organisationId: rule.organisationId,
      actorId: userId,
      action: 'automation.updated',
      targetType: 'automation_rule',
      targetId: ruleId,
      data: { fields: Object.keys(changes) },
      client,
    });
    return this.get(ruleId);
  }

  async remove(userId: string, ruleId: string, client: ClientInfo): Promise<void> {
    const rule = await this.requireRule(userId, ruleId);
    await this.dbs.db.update(automationRules).set({ deletedAt: new Date(), enabled: false }).where(eq(automationRules.id, ruleId));
    await this.audit.record({ organisationId: rule.organisationId, actorId: userId, action: 'automation.deleted', targetType: 'automation_rule', targetId: ruleId, data: { name: rule.name }, client });
  }

  async runs(userId: string, ruleId: string): Promise<AutomationRunDto[]> {
    await this.requireRule(userId, ruleId);
    const rows = await this.dbs.db.select().from(automationRuns).where(eq(automationRuns.ruleId, ruleId)).orderBy(desc(automationRuns.createdAt)).limit(50);
    return rows.map((r) => ({
      id: r.id,
      ruleId: r.ruleId,
      taskId: r.taskId,
      status: r.status as AutomationRunDto['status'],
      attempts: r.attempts,
      detail: r.detail,
      error: r.error,
      createdAt: r.createdAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
    }));
  }
}
