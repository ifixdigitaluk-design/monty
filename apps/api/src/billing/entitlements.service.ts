import { Injectable } from '@nestjs/common';
import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import { checkLimit, LIMIT_LABEL, LimitKey, Plan, PLAN_LIMITS } from '@monty/domain';
import { aiProposals, invitations, organisationMemberships, organisations, projects } from '@monty/database';
import { AppException, notFound } from '../common/errors';
import { DbService } from '../db/db.service';

/**
 * The single place that decides whether an organisation may use more of a paid capability.
 * Payment-provider integration is intentionally not implemented yet (see BillingProvider in billing.provider.ts):
 * plans are changed by operations until a provider is chosen.
 */
@Injectable()
export class EntitlementsService {
  constructor(private readonly dbs: DbService) {}

  private async planOf(organisationId: string): Promise<Plan> {
    const [org] = await this.dbs.db.select({ plan: organisations.plan }).from(organisations).where(eq(organisations.id, organisationId));
    if (!org) throw notFound('Organisation');
    return org.plan;
  }

  async usage(organisationId: string): Promise<Record<LimitKey, number>> {
    const db = this.dbs.db;
    const count = async (q: PromiseLike<{ n: number }[]>) => (await q)[0]?.n ?? 0;
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    // Sequential on purpose: inside a request transaction all queries share one connection (no parallel queries).
    const projectsN = await count(db.select({ n: sql<number>`count(*)::int` }).from(projects).where(and(eq(projects.organisationId, organisationId), isNull(projects.deletedAt))));
    const membersN = await count(db.select({ n: sql<number>`count(*)::int` }).from(organisationMemberships).where(eq(organisationMemberships.organisationId, organisationId)));
    const pendingN = await count(
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(invitations)
        .where(and(eq(invitations.organisationId, organisationId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gte(invitations.expiresAt, new Date()))),
    );
    const aiN = await count(db.select({ n: sql<number>`count(*)::int` }).from(aiProposals).where(and(eq(aiProposals.organisationId, organisationId), gte(aiProposals.createdAt, monthStart))));
    const rulesN = await this.countAutomationRules(organisationId);
    return { projects: projectsN, members: membersN + pendingN, aiRequestsPerMonth: aiN, automationRules: rulesN };
  }

  /** Overridden once automations exist (kept here so all usage counting lives in one service). */
  protected async countAutomationRules(organisationId: string): Promise<number> {
    const r = await this.dbs.db.execute<{ n: number }>(
      sql`select count(*)::int as n from information_schema.tables where table_name = 'automation_rules'`,
    );
    if (!r.rows[0]?.n) return 0;
    const c = await this.dbs.db.execute<{ n: number }>(
      sql`select count(*)::int as n from automation_rules where organisation_id = ${organisationId} and deleted_at is null`,
    );
    return c.rows[0]?.n ?? 0;
  }

  async summary(organisationId: string) {
    const plan = await this.planOf(organisationId);
    return { plan, limits: PLAN_LIMITS[plan], usage: await this.usage(organisationId) };
  }

  async assertWithinLimit(organisationId: string, key: LimitKey): Promise<void> {
    const plan = await this.planOf(organisationId);
    const used = (await this.usage(organisationId))[key];
    const { ok, limit } = checkLimit(plan, key, used);
    if (!ok) {
      throw new AppException(403, 'PLAN_LIMIT_REACHED', `Your ${plan.toLowerCase()} plan includes up to ${limit} ${LIMIT_LABEL[key]}. Upgrade to add more.`, {
        key,
        limit,
        used,
        plan,
      });
    }
  }
}
