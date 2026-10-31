import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { addDays, todayUtc } from '@monty/domain';
import { aiProposals, taskDependencies, tasks, users } from '@monty/database';
import type { AiPlan, AiProposalDto } from '@monty/validation';
import { AuditService, ClientInfo } from '../audit/audit.service';
import { AppConfig, CONFIG } from '../config';
import { AppException, badRequest, conflict, notFound } from '../common/errors';
import { DbService } from '../db/db.service';
import { AccessService } from '../tenancy/access.service';
import { TasksService } from '../tasks/tasks.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { AiProvider, AnthropicProvider, LocalPlanner } from './providers';

/**
 * AI assistance with human approval.
 * - Context sent to a provider is limited to the requesting user's accessible project data.
 * - Provider output is validated strictly and stored as a PENDING proposal; nothing changes until someone with
 *   permission applies it. Applying is audited and creates ordinary, attributable tasks.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger('AI');
  readonly provider: AiProvider;

  constructor(
    private readonly dbs: DbService,
    private readonly access: AccessService,
    private readonly tasks: TasksService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    @Inject(CONFIG) config: AppConfig,
  ) {
    this.provider =
      config.ai.provider === 'anthropic' && config.ai.apiKey && config.ai.model
        ? new AnthropicProvider(config.ai.apiKey, config.ai.model)
        : new LocalPlanner();
  }

  /** Test hook. */
  useProvider(p: AiProvider) {
    (this as { provider: AiProvider }).provider = p;
  }

  async requestPlan(userId: string, projectId: string, guidance: string | undefined, client: ClientInfo): Promise<AiProposalDto> {
    const { project } = await this.access.requireProject(userId, projectId, 'task.create');
    await this.entitlements.assertWithinLimit(project.organisationId, 'aiRequestsPerMonth');
    const existing = await this.dbs.db
      .select({ title: tasks.title })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), isNull(tasks.deletedAt)));
    const today = todayUtc();
    const daysUntilTarget = project.targetDate ? Math.round((Date.parse(project.targetDate) - Date.parse(today)) / 86_400_000) : null;
    const input = {
      projectName: project.name,
      objective: project.objective,
      description: project.description,
      existingTaskTitles: existing.map((e) => e.title),
      daysUntilTarget,
      guidance: guidance ?? null,
    };
    let plan: AiPlan;
    try {
      plan = await this.provider.plan(input);
    } catch (err) {
      this.logger.warn(JSON.stringify({ msg: 'ai_plan_failed', provider: this.provider.id, error: String(err).slice(0, 300) }));
      throw new AppException(502, 'INTERNAL', 'The AI assistant could not produce a plan right now. Nothing was changed — try again shortly.');
    }
    const [row] = await this.dbs.db
      .insert(aiProposals)
      .values({
        organisationId: project.organisationId,
        workspaceId: project.workspaceId,
        projectId,
        kind: 'project_plan',
        provider: this.provider.id,
        model: this.provider.model,
        requestedById: userId,
        // Store what was sent (minus nothing secret) for traceability.
        input: { ...input, today },
        output: plan as unknown as Record<string, unknown>,
      })
      .returning();
    await this.audit.record({
      organisationId: project.organisationId,
      actorId: userId,
      action: 'ai.plan_proposed',
      targetType: 'ai_proposal',
      targetId: row!.id,
      data: { projectId, provider: this.provider.id, taskCount: plan.tasks.length },
      client,
    });
    return (await this.list(userId, projectId)).find((p) => p.id === row!.id)!;
  }

  async list(userId: string, projectId: string): Promise<AiProposalDto[]> {
    await this.access.requireProject(userId, projectId, 'workspace.read');
    const rows = await this.dbs.db
      .select({ p: aiProposals, name: users.name })
      .from(aiProposals)
      .innerJoin(users, eq(users.id, aiProposals.requestedById))
      .where(eq(aiProposals.projectId, projectId))
      .orderBy(desc(aiProposals.createdAt))
      .limit(20);
    return rows.map(({ p, name }) => ({
      id: p.id,
      projectId: p.projectId,
      status: p.status,
      provider: p.provider,
      providerLabel: p.provider === 'anthropic' ? 'Claude (Anthropic)' : 'Basic planner (no AI provider configured)',
      model: p.model,
      plan: p.output as unknown as AiPlan,
      requestedBy: { id: p.requestedById, name },
      createdAt: p.createdAt.toISOString(),
      decidedAt: p.decidedAt?.toISOString() ?? null,
      appliedEntityIds: p.appliedEntityIds ?? [],
    }));
  }

  /** Creates the selected tasks (and dependencies among them) in one transaction, then marks the proposal applied. */
  async apply(userId: string, proposalId: string, taskIndexes: number[], client: ClientInfo): Promise<AiProposalDto> {
    const proposal = await this.dbs.db.query.aiProposals.findFirst({ where: eq(aiProposals.id, proposalId) });
    if (!proposal) throw notFound('Proposal');
    await this.access.requireProject(userId, proposal.projectId, 'task.create');
    const plan = proposal.output as unknown as AiPlan;
    const chosen = [...new Set(taskIndexes)].sort((a, b) => a - b);
    if (chosen.some((i) => i >= plan.tasks.length)) throw badRequest('Unknown task in proposal');
    const createdIds = await this.dbs.db.transaction(async (tx) => {
      // Lock the proposal so a double click or two people can't apply it twice.
      const [locked] = await tx.select().from(aiProposals).where(eq(aiProposals.id, proposalId)).for('update');
      if (locked!.status !== 'PENDING') throw conflict('CONFLICT', `This proposal was already ${locked!.status.toLowerCase()}.`);
      const start = todayUtc();
      const idByIndex = new Map<number, string>();
      for (const i of chosen) {
        const t = plan.tasks[i]!;
        const { task } = await this.tasks.create(userId, proposal.projectId, {
          id: crypto.randomUUID(),
          title: t.title,
          description: t.description,
          dueDate: t.dueInDays !== null ? addDays(start, t.dueInDays) : null,
        });
        idByIndex.set(i, task.id);
      }
      for (const i of chosen) {
        for (const d of plan.tasks[i]!.dependsOn) {
          const from = idByIndex.get(i);
          const to = idByIndex.get(d);
          if (from && to) await tx.insert(taskDependencies).values({ organisationId: proposal.organisationId, taskId: from, dependsOnTaskId: to });
        }
      }
      const ids = [...idByIndex.values()];
      await tx
        .update(aiProposals)
        .set({ status: 'APPLIED', decidedById: userId, decidedAt: new Date(), appliedEntityIds: ids })
        .where(eq(aiProposals.id, proposalId));
      await this.audit.record(
        {
          organisationId: proposal.organisationId,
          actorId: userId,
          action: 'ai.plan_applied',
          targetType: 'ai_proposal',
          targetId: proposalId,
          data: { projectId: proposal.projectId, createdTaskIds: ids, provider: proposal.provider },
          client,
        },
        tx,
      );
      return ids;
    });
    this.logger.log(JSON.stringify({ msg: 'ai_plan_applied', tasks: createdIds.length }));
    return (await this.list(userId, proposal.projectId)).find((p) => p.id === proposalId)!;
  }

  async reject(userId: string, proposalId: string, client: ClientInfo): Promise<void> {
    const proposal = await this.dbs.db.query.aiProposals.findFirst({ where: eq(aiProposals.id, proposalId) });
    if (!proposal) throw notFound('Proposal');
    await this.access.requireProject(userId, proposal.projectId, 'task.create');
    const res = await this.dbs.db
      .update(aiProposals)
      .set({ status: 'REJECTED', decidedById: userId, decidedAt: new Date() })
      .where(and(eq(aiProposals.id, proposalId), eq(aiProposals.status, 'PENDING')))
      .returning({ id: aiProposals.id });
    if (res.length === 0) throw conflict('CONFLICT', 'This proposal was already decided.');
    await this.audit.record({ organisationId: proposal.organisationId, actorId: userId, action: 'ai.plan_rejected', targetType: 'ai_proposal', targetId: proposalId, client });
  }
}
