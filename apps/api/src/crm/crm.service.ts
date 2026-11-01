import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, sql, SQL } from 'drizzle-orm';
import { crmActivities, crmCompanies, crmContacts, crmDeals, crmQuotes, CrmActivity, CrmCompany, CrmContact, CrmDeal, CrmQuote, users } from '@monty/database';
import { nextQuoteNumber, OPEN_STAGES, pipelineSummary, quoteTotals, toPrefixTsQuery, winRate } from '@monty/domain';
import type {
  CrmActivityDto,
  ActivityInput,
  CompanyDto,
  CompanyInput,
  ContactDto,
  ContactInput,
  CrmSummaryDto,
  DealDto,
  DealInput,
  QuoteDto,
  QuoteInput,
  UpdateActivityInput,
  UpdateCompanyInput,
  UpdateContactInput,
  UpdateDealInput,
  UpdateQuoteInput,
} from '@monty/validation';
import { CollaborationService } from '../collaboration/collaboration.service';
import { badRequest, conflict, notFound } from '../common/errors';
import { DbService } from '../db/db.service';
import { AccessService } from '../tenancy/access.service';

const LIST_LIMIT = 2000;
type Read = 'workspace.read';
type Write = 'task.update';
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const today = () => new Date().toISOString().slice(0, 10);

/**
 * CRM: companies, contacts, deals, activities (with follow-ups) and quotes, all scoped to a workspace.
 * Viewers read; members and admins create and edit. Linked records must belong to the same workspace.
 */
@Injectable()
export class CrmService {
  constructor(
    private readonly dbs: DbService,
    private readonly access: AccessService,
    private readonly collab: CollaborationService,
  ) {}

  private get db() {
    return this.dbs.db;
  }

  // ---------- helpers ----------

  private async names(ids: (string | null | undefined)[]) {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    if (!unique.length) return new Map<string, string>();
    return new Map((await this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, unique))).map((u) => [u.id, u.name]));
  }
  private person(names: Map<string, string>, id: string | null) {
    return id ? { id, name: names.get(id) ?? 'Former member' } : null;
  }

  /** Loads a record of `table` by id, checks the caller's access to its workspace. Unreadable = 404. */
  private async load<T extends { workspaceId: string; organisationId: string }>(
    table: typeof crmCompanies | typeof crmContacts | typeof crmDeals | typeof crmQuotes | typeof crmActivities,
    what: string,
    userId: string,
    id: string,
    action: Read | Write,
  ): Promise<T> {
    const where = 'deletedAt' in table ? and(eq(table.id, id), isNull((table as typeof crmCompanies).deletedAt)) : eq(table.id, id);
    const [row] = (await this.db.select().from(table as typeof crmCompanies).where(where).limit(1)) as unknown as T[];
    if (!row) throw notFound(what);
    const a = await this.access.workspaceAccess(userId, row.workspaceId);
    if (!a) throw notFound(what);
    if (action !== 'workspace.read') await this.access.requireWorkspace(userId, row.workspaceId, action);
    return row;
  }

  /** Every linked id must point at a live record in the same workspace. */
  private async checkLinks(workspaceId: string, links: { companyId?: string | null; contactId?: string | null; dealId?: string | null; ownerId?: string | null; assigneeId?: string | null }) {
    const same = async (table: typeof crmCompanies | typeof crmContacts | typeof crmDeals, id: string | null | undefined, path: string) => {
      if (!id) return;
      const [r] = await this.db.select({ id: table.id }).from(table).where(and(eq(table.id, id), eq(table.workspaceId, workspaceId), isNull(table.deletedAt))).limit(1);
      if (!r) throw badRequest('Linked record not found in this workspace', [{ path, message: 'Not found' }]);
    };
    await same(crmCompanies, links.companyId, 'companyId');
    await same(crmContacts, links.contactId, 'contactId');
    await same(crmDeals, links.dealId, 'dealId');
    await this.access.assertCanBeAssigned(links.ownerId, workspaceId, 'ownerId');
    await this.access.assertCanBeAssigned(links.assigneeId, workspaceId, 'assigneeId');
  }

  private async idempotent<T extends { createdById: string; workspaceId: string }>(table: typeof crmCompanies | typeof crmContacts | typeof crmDeals | typeof crmQuotes, id: string | undefined, userId: string, workspaceId: string) {
    if (!id) return null;
    const [r] = (await this.db.select().from(table as typeof crmCompanies).where(eq(table.id, id)).limit(1)) as unknown as T[];
    if (!r) return null;
    if (r.createdById !== userId || r.workspaceId !== workspaceId) throw conflict('CONFLICT', 'This id is already in use');
    return r;
  }

  private searchClause(column: SQL, q?: string) {
    const tsq = q ? toPrefixTsQuery(q) : null;
    return tsq ? sql`${column} @@ to_tsquery('simple', ${tsq})` : undefined;
  }

  // ---------- summary ----------

  async summary(userId: string, workspaceId: string): Promise<CrmSummaryDto> {
    await this.access.requireWorkspace(userId, workspaceId, 'workspace.read');
    const deals = await this.db
      .select({ stage: crmDeals.stage, value: crmDeals.value, currency: crmDeals.currency, closedAt: crmDeals.closedAt })
      .from(crmDeals)
      .where(and(eq(crmDeals.workspaceId, workspaceId), isNull(crmDeals.deletedAt)));
    const plain = deals.map((d) => ({ ...d, closedAt: iso(d.closedAt) }));
    const count = async (table: typeof crmCompanies | typeof crmContacts) =>
      Number((await this.db.select({ n: sql<number>`count(*)` }).from(table).where(and(eq(table.workspaceId, workspaceId), isNull(table.deletedAt))))[0]!.n);
    return {
      pipeline: pipelineSummary(plain),
      winRate: winRate(plain),
      counts: { companies: await count(crmCompanies), contacts: await count(crmContacts), openDeals: plain.filter((d) => (OPEN_STAGES as string[]).includes(d.stage)).length },
      myFollowUps: await this.activities(userId, workspaceId, { mine: true, open: true }),
    };
  }

  // ---------- companies ----------

  async listCompanies(userId: string, workspaceId: string, q?: string): Promise<CompanyDto[]> {
    await this.access.requireWorkspace(userId, workspaceId, 'workspace.read');
    const rows = await this.db
      .select()
      .from(crmCompanies)
      .where(and(eq(crmCompanies.workspaceId, workspaceId), isNull(crmCompanies.deletedAt), this.searchClause(sql`search`, q)))
      .orderBy(asc(crmCompanies.name))
      .limit(LIST_LIMIT);
    return this.companyDtos(rows);
  }

  private async companyDtos(rows: CrmCompany[]): Promise<CompanyDto[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const contacts = await this.db
      .select({ companyId: crmContacts.companyId, n: sql<number>`count(*)` })
      .from(crmContacts)
      .where(and(inArray(crmContacts.companyId, ids), isNull(crmContacts.deletedAt)))
      .groupBy(crmContacts.companyId);
    const open = await this.db
      .select({ companyId: crmDeals.companyId, currency: crmDeals.currency, v: sql<number>`coalesce(sum(value), 0)` })
      .from(crmDeals)
      .where(and(inArray(crmDeals.companyId, ids), isNull(crmDeals.deletedAt), inArray(crmDeals.stage, OPEN_STAGES)))
      .groupBy(crmDeals.companyId, crmDeals.currency);
    const names = await this.names(rows.map((r) => r.ownerId));
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      name: r.name,
      website: r.website,
      industry: r.industry,
      phone: r.phone,
      address: r.address,
      notes: r.notes,
      owner: this.person(names, r.ownerId),
      contactCount: Number(contacts.find((c) => c.companyId === r.id)?.n ?? 0),
      openDeals: open.filter((c) => c.companyId === r.id).map((c) => ({ currency: c.currency, value: Number(c.v) })),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  async createCompany(userId: string, workspaceId: string, input: CompanyInput): Promise<{ company: CompanyDto; created: boolean }> {
    const { workspace } = await this.access.requireWorkspace(userId, workspaceId, 'task.update');
    const existing = await this.idempotent<CrmCompany>(crmCompanies, input.id, userId, workspaceId);
    if (existing) return { company: (await this.companyDtos([existing]))[0]!, created: false };
    await this.checkLinks(workspaceId, { ownerId: input.ownerId });
    const [r] = await this.db
      .insert(crmCompanies)
      .values({ ...input, ownerId: input.ownerId ?? userId, organisationId: workspace.organisationId, workspaceId, createdById: userId })
      .returning();
    return { company: (await this.companyDtos([r!]))[0]!, created: true };
  }

  async getCompany(userId: string, id: string) {
    const r = await this.load<CrmCompany>(crmCompanies, 'Company', userId, id, 'workspace.read');
    const [company] = await this.companyDtos([r]);
    // Sequential on purpose: inside a request transaction these share one database connection.
    const contacts = await this.listContacts(userId, r.workspaceId, { companyId: id });
    const deals = await this.listDeals(userId, r.workspaceId, { companyId: id });
    const quotes = await this.listQuotes(userId, r.workspaceId, { companyId: id });
    const activities = await this.activities(userId, r.workspaceId, { companyId: id });
    return { company: company!, contacts, deals, quotes, activities };
  }

  async updateCompany(userId: string, id: string, input: UpdateCompanyInput): Promise<CompanyDto> {
    const r = await this.load<CrmCompany>(crmCompanies, 'Company', userId, id, 'task.update');
    await this.checkLinks(r.workspaceId, { ownerId: input.ownerId });
    const [u] = await this.db.update(crmCompanies).set(input).where(eq(crmCompanies.id, id)).returning();
    return (await this.companyDtos([u!]))[0]!;
  }

  async removeCompany(userId: string, id: string) {
    await this.load<CrmCompany>(crmCompanies, 'Company', userId, id, 'task.update');
    await this.db.update(crmCompanies).set({ deletedAt: new Date() }).where(eq(crmCompanies.id, id));
  }

  // ---------- contacts ----------

  async listContacts(userId: string, workspaceId: string, f: { q?: string; companyId?: string } = {}): Promise<ContactDto[]> {
    await this.access.requireWorkspace(userId, workspaceId, 'workspace.read');
    const rows = await this.db
      .select()
      .from(crmContacts)
      .where(and(eq(crmContacts.workspaceId, workspaceId), isNull(crmContacts.deletedAt), f.companyId ? eq(crmContacts.companyId, f.companyId) : undefined, this.searchClause(sql`search`, f.q)))
      .orderBy(asc(crmContacts.name))
      .limit(LIST_LIMIT);
    return this.contactDtos(rows);
  }

  private async contactDtos(rows: CrmContact[]): Promise<ContactDto[]> {
    if (!rows.length) return [];
    const companyIds = [...new Set(rows.map((r) => r.companyId).filter((x): x is string => !!x))];
    const companies = companyIds.length ? await this.db.select({ id: crmCompanies.id, name: crmCompanies.name }).from(crmCompanies).where(and(inArray(crmCompanies.id, companyIds), isNull(crmCompanies.deletedAt))) : [];
    const names = await this.names(rows.map((r) => r.ownerId));
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      name: r.name,
      email: r.email,
      phone: r.phone,
      jobTitle: r.jobTitle,
      notes: r.notes,
      company: companies.find((c) => c.id === r.companyId) ?? null,
      owner: this.person(names, r.ownerId),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  async createContact(userId: string, workspaceId: string, input: ContactInput): Promise<{ contact: ContactDto; created: boolean }> {
    const { workspace } = await this.access.requireWorkspace(userId, workspaceId, 'task.update');
    const existing = await this.idempotent<CrmContact>(crmContacts, input.id, userId, workspaceId);
    if (existing) return { contact: (await this.contactDtos([existing]))[0]!, created: false };
    await this.checkLinks(workspaceId, { companyId: input.companyId, ownerId: input.ownerId });
    const [r] = await this.db
      .insert(crmContacts)
      .values({ ...input, email: input.email?.toLowerCase() ?? '', ownerId: input.ownerId ?? userId, organisationId: workspace.organisationId, workspaceId, createdById: userId })
      .returning();
    return { contact: (await this.contactDtos([r!]))[0]!, created: true };
  }

  async getContact(userId: string, id: string) {
    const r = await this.load<CrmContact>(crmContacts, 'Contact', userId, id, 'workspace.read');
    const [contact] = await this.contactDtos([r]);
    // Sequential on purpose: inside a request transaction these share one database connection.
    const deals = await this.listDeals(userId, r.workspaceId, { contactId: id });
    const activities = await this.activities(userId, r.workspaceId, { contactId: id });
    return { contact: contact!, deals, activities };
  }

  async updateContact(userId: string, id: string, input: UpdateContactInput): Promise<ContactDto> {
    const r = await this.load<CrmContact>(crmContacts, 'Contact', userId, id, 'task.update');
    await this.checkLinks(r.workspaceId, { companyId: input.companyId, ownerId: input.ownerId });
    const [u] = await this.db.update(crmContacts).set({ ...input, ...(input.email !== undefined ? { email: input.email.toLowerCase() } : {}) }).where(eq(crmContacts.id, id)).returning();
    return (await this.contactDtos([u!]))[0]!;
  }

  async removeContact(userId: string, id: string) {
    await this.load<CrmContact>(crmContacts, 'Contact', userId, id, 'task.update');
    await this.db.update(crmContacts).set({ deletedAt: new Date() }).where(eq(crmContacts.id, id));
  }

  // ---------- deals ----------

  async listDeals(userId: string, workspaceId: string, f: { q?: string; companyId?: string; contactId?: string; stage?: string } = {}): Promise<DealDto[]> {
    await this.access.requireWorkspace(userId, workspaceId, 'workspace.read');
    const rows = await this.db
      .select()
      .from(crmDeals)
      .where(
        and(
          eq(crmDeals.workspaceId, workspaceId),
          isNull(crmDeals.deletedAt),
          f.companyId ? eq(crmDeals.companyId, f.companyId) : undefined,
          f.contactId ? eq(crmDeals.contactId, f.contactId) : undefined,
          f.stage ? eq(crmDeals.stage, f.stage) : undefined,
          this.searchClause(sql`search`, f.q),
        ),
      )
      .orderBy(asc(crmDeals.position), desc(crmDeals.createdAt))
      .limit(LIST_LIMIT);
    return this.dealDtos(rows);
  }

  private async dealDtos(rows: CrmDeal[]): Promise<DealDto[]> {
    if (!rows.length) return [];
    const cIds = [...new Set(rows.map((r) => r.companyId).filter((x): x is string => !!x))];
    const pIds = [...new Set(rows.map((r) => r.contactId).filter((x): x is string => !!x))];
    const companies = cIds.length ? await this.db.select({ id: crmCompanies.id, name: crmCompanies.name }).from(crmCompanies).where(and(inArray(crmCompanies.id, cIds), isNull(crmCompanies.deletedAt))) : [];
    const contacts = pIds.length ? await this.db.select({ id: crmContacts.id, name: crmContacts.name }).from(crmContacts).where(and(inArray(crmContacts.id, pIds), isNull(crmContacts.deletedAt))) : [];
    const names = await this.names(rows.map((r) => r.ownerId));
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      title: r.title,
      stage: r.stage as DealDto['stage'],
      value: r.value,
      currency: r.currency,
      expectedClose: r.expectedClose,
      lostReason: r.lostReason,
      closedAt: iso(r.closedAt),
      position: r.position,
      notes: r.notes,
      company: companies.find((c) => c.id === r.companyId) ?? null,
      contact: contacts.find((c) => c.id === r.contactId) ?? null,
      owner: this.person(names, r.ownerId),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  async createDeal(userId: string, workspaceId: string, input: DealInput): Promise<{ deal: DealDto; created: boolean }> {
    const { workspace } = await this.access.requireWorkspace(userId, workspaceId, 'task.update');
    const existing = await this.idempotent<CrmDeal>(crmDeals, input.id, userId, workspaceId);
    if (existing) return { deal: (await this.dealDtos([existing]))[0]!, created: false };
    await this.checkLinks(workspaceId, { companyId: input.companyId, contactId: input.contactId, ownerId: input.ownerId });
    const stage = input.stage ?? 'lead';
    const [{ top }] = (await this.db.select({ top: sql<number | null>`max(position)` }).from(crmDeals).where(eq(crmDeals.workspaceId, workspaceId))) as [{ top: number | null }];
    const [r] = await this.db
      .insert(crmDeals)
      .values({
        ...input,
        stage,
        position: input.position ?? Number(top ?? 0) + 1024,
        closedAt: stage === 'won' || stage === 'lost' ? new Date() : null,
        ownerId: input.ownerId ?? userId,
        organisationId: workspace.organisationId,
        workspaceId,
        createdById: userId,
      })
      .returning();
    return { deal: (await this.dealDtos([r!]))[0]!, created: true };
  }

  async getDeal(userId: string, id: string) {
    const r = await this.load<CrmDeal>(crmDeals, 'Deal', userId, id, 'workspace.read');
    const [deal] = await this.dealDtos([r]);
    // Sequential on purpose: inside a request transaction these share one database connection.
    const activities = await this.activities(userId, r.workspaceId, { dealId: id });
    const quotes = await this.listQuotes(userId, r.workspaceId, { dealId: id });
    return { deal: deal!, activities, quotes };
  }

  async updateDeal(userId: string, id: string, input: UpdateDealInput): Promise<DealDto> {
    const r = await this.load<CrmDeal>(crmDeals, 'Deal', userId, id, 'task.update');
    await this.checkLinks(r.workspaceId, { companyId: input.companyId, contactId: input.contactId, ownerId: input.ownerId });
    const set: Partial<CrmDeal> = { ...input };
    if (input.stage && input.stage !== r.stage) {
      const closed = input.stage === 'won' || input.stage === 'lost';
      set.closedAt = closed ? new Date() : null;
      if (input.stage !== 'lost' && input.lostReason === undefined) set.lostReason = '';
    }
    const [u] = await this.db.update(crmDeals).set(set).where(eq(crmDeals.id, id)).returning();
    return (await this.dealDtos([u!]))[0]!;
  }

  async removeDeal(userId: string, id: string) {
    await this.load<CrmDeal>(crmDeals, 'Deal', userId, id, 'task.update');
    await this.db.update(crmDeals).set({ deletedAt: new Date() }).where(eq(crmDeals.id, id));
  }

  // ---------- activities & follow-ups ----------

  async activities(
    userId: string,
    workspaceId: string,
    f: { companyId?: string; contactId?: string; dealId?: string; mine?: boolean; open?: boolean; before?: string } = {},
  ): Promise<CrmActivityDto[]> {
    await this.access.requireWorkspace(userId, workspaceId, 'workspace.read');
    const followUpsOnly = f.mine || f.open;
    const rows = await this.db
      .select()
      .from(crmActivities)
      .where(
        and(
          eq(crmActivities.workspaceId, workspaceId),
          f.companyId ? eq(crmActivities.companyId, f.companyId) : undefined,
          f.contactId ? eq(crmActivities.contactId, f.contactId) : undefined,
          f.dealId ? eq(crmActivities.dealId, f.dealId) : undefined,
          f.mine ? or(eq(crmActivities.assigneeId, userId), and(isNull(crmActivities.assigneeId), eq(crmActivities.createdById, userId))) : undefined,
          followUpsOnly ? isNotNull(crmActivities.dueAt) : undefined,
          f.open ? isNull(crmActivities.doneAt) : undefined,
          f.before ? lt(crmActivities.dueAt, new Date(f.before)) : undefined,
        ),
      )
      .orderBy(followUpsOnly ? asc(crmActivities.dueAt) : desc(crmActivities.createdAt))
      .limit(500);
    return this.activityDtos(rows);
  }

  private async activityDtos(rows: CrmActivity[]): Promise<CrmActivityDto[]> {
    if (!rows.length) return [];
    const pick = <K extends 'companyId' | 'contactId' | 'dealId'>(k: K) => [...new Set(rows.map((r) => r[k]).filter((x): x is string => !!x))];
    // Sequential on purpose: inside a request transaction these share one database connection.
    const companies = await (pick('companyId').length ? this.db.select({ id: crmCompanies.id, name: crmCompanies.name }).from(crmCompanies).where(inArray(crmCompanies.id, pick('companyId'))) : []);
    const contacts = await (pick('contactId').length ? this.db.select({ id: crmContacts.id, name: crmContacts.name }).from(crmContacts).where(inArray(crmContacts.id, pick('contactId'))) : []);
    const deals = await (pick('dealId').length ? this.db.select({ id: crmDeals.id, title: crmDeals.title }).from(crmDeals).where(inArray(crmDeals.id, pick('dealId'))) : []);
    const names = await this.names(rows.flatMap((r) => [r.assigneeId, r.createdById]));
    return rows.map((r) => ({
      id: r.id,
      type: r.type as CrmActivityDto['type'],
      subject: r.subject,
      body: r.body,
      company: companies.find((c) => c.id === r.companyId) ?? null,
      contact: contacts.find((c) => c.id === r.contactId) ?? null,
      deal: deals.find((c) => c.id === r.dealId) ?? null,
      dueAt: iso(r.dueAt),
      doneAt: iso(r.doneAt),
      assignee: this.person(names, r.assigneeId),
      createdBy: { id: r.createdById, name: names.get(r.createdById) ?? '' },
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async createActivity(userId: string, workspaceId: string, input: ActivityInput): Promise<CrmActivityDto> {
    const { workspace } = await this.access.requireWorkspace(userId, workspaceId, 'task.update');
    await this.checkLinks(workspaceId, { companyId: input.companyId, contactId: input.contactId, dealId: input.dealId, assigneeId: input.assigneeId });
    if (input.id) {
      const [existing] = await this.db.select().from(crmActivities).where(eq(crmActivities.id, input.id)).limit(1);
      if (existing) {
        if (existing.createdById !== userId || existing.workspaceId !== workspaceId) throw conflict('CONFLICT', 'This id is already in use');
        return (await this.activityDtos([existing]))[0]!;
      }
    }
    const { done, dueAt, ...rest } = input;
    const assigneeId = dueAt ? (input.assigneeId ?? userId) : (input.assigneeId ?? null);
    const [r] = await this.db
      .insert(crmActivities)
      .values({ ...rest, assigneeId, dueAt: dueAt ? new Date(dueAt) : null, doneAt: done ? new Date() : null, organisationId: workspace.organisationId, workspaceId, createdById: userId })
      .returning();
    await this.notifyAssignee(r!, userId);
    return (await this.activityDtos([r!]))[0]!;
  }

  private async notifyAssignee(a: CrmActivity, actorId: string) {
    if (!a.assigneeId || a.assigneeId === actorId || !a.dueAt || a.doneAt) return;
    await this.collab.notify({
      recipients: [a.assigneeId],
      actorId,
      organisationId: a.organisationId,
      workspaceId: a.workspaceId,
      projectId: null,
      type: 'assigned',
      entityType: 'crm_activity',
      entityId: a.id,
      data: { title: a.subject, dueAt: a.dueAt.toISOString(), workspaceId: a.workspaceId, companyId: a.companyId, contactId: a.contactId, dealId: a.dealId },
      dedupeKey: `crm-followup:${a.id}:${a.assigneeId}`,
    });
  }

  async updateActivity(userId: string, id: string, input: UpdateActivityInput): Promise<CrmActivityDto> {
    const r = await this.load<CrmActivity>(crmActivities, 'Activity', userId, id, 'task.update');
    await this.checkLinks(r.workspaceId, { assigneeId: input.assigneeId });
    const { done, dueAt, ...rest } = input;
    const set: Partial<CrmActivity> = { ...rest };
    if (dueAt !== undefined) set.dueAt = dueAt ? new Date(dueAt) : null;
    if (done !== undefined) set.doneAt = done ? (r.doneAt ?? new Date()) : null;
    const [u] = await this.db.update(crmActivities).set(set).where(eq(crmActivities.id, id)).returning();
    if (input.assigneeId && input.assigneeId !== r.assigneeId) await this.notifyAssignee(u!, userId);
    return (await this.activityDtos([u!]))[0]!;
  }

  async removeActivity(userId: string, id: string) {
    const r = await this.load<CrmActivity>(crmActivities, 'Activity', userId, id, 'task.update');
    // Only the author (or a workspace admin) deletes an activity: it's part of the customer's history.
    if (r.createdById !== userId) await this.access.requireWorkspace(userId, r.workspaceId, 'workspace.manage');
    await this.db.delete(crmActivities).where(eq(crmActivities.id, id));
  }

  // ---------- quotes ----------

  async listQuotes(userId: string, workspaceId: string, f: { companyId?: string; dealId?: string } = {}): Promise<QuoteDto[]> {
    await this.access.requireWorkspace(userId, workspaceId, 'workspace.read');
    const rows = await this.db
      .select()
      .from(crmQuotes)
      .where(and(eq(crmQuotes.workspaceId, workspaceId), isNull(crmQuotes.deletedAt), f.companyId ? eq(crmQuotes.companyId, f.companyId) : undefined, f.dealId ? eq(crmQuotes.dealId, f.dealId) : undefined))
      .orderBy(desc(crmQuotes.createdAt))
      .limit(LIST_LIMIT);
    return this.quoteDtos(rows);
  }

  private async quoteDtos(rows: CrmQuote[]): Promise<QuoteDto[]> {
    if (!rows.length) return [];
    const pick = <K extends 'companyId' | 'contactId' | 'dealId'>(k: K) => [...new Set(rows.map((r) => r[k]).filter((x): x is string => !!x))];
    // Sequential on purpose: inside a request transaction these share one database connection.
    const companies = await (pick('companyId').length ? this.db.select({ id: crmCompanies.id, name: crmCompanies.name, address: crmCompanies.address }).from(crmCompanies).where(inArray(crmCompanies.id, pick('companyId'))) : []);
    const contacts = await (pick('contactId').length ? this.db.select({ id: crmContacts.id, name: crmContacts.name, email: crmContacts.email }).from(crmContacts).where(inArray(crmContacts.id, pick('contactId'))) : []);
    const deals = await (pick('dealId').length ? this.db.select({ id: crmDeals.id, title: crmDeals.title }).from(crmDeals).where(inArray(crmDeals.id, pick('dealId'))) : []);
    const names = await this.names(rows.map((r) => r.createdById));
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      number: r.number,
      title: r.title,
      status: r.status as QuoteDto['status'],
      currency: r.currency,
      issueDate: r.issueDate,
      validUntil: r.validUntil,
      lines: r.lines,
      subtotal: r.subtotal,
      tax: r.tax,
      total: r.total,
      notes: r.notes,
      company: companies.find((c) => c.id === r.companyId) ?? null,
      contact: contacts.find((c) => c.id === r.contactId) ?? null,
      deal: deals.find((c) => c.id === r.dealId) ?? null,
      createdBy: { id: r.createdById, name: names.get(r.createdById) ?? '' },
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  async createQuote(userId: string, workspaceId: string, input: QuoteInput): Promise<{ quote: QuoteDto; created: boolean }> {
    const { workspace } = await this.access.requireWorkspace(userId, workspaceId, 'task.update');
    const existing = await this.idempotent<CrmQuote>(crmQuotes, input.id, userId, workspaceId);
    if (existing) return { quote: (await this.quoteDtos([existing]))[0]!, created: false };
    await this.checkLinks(workspaceId, { companyId: input.companyId, contactId: input.contactId, dealId: input.dealId });
    const lines = input.lines ?? [];
    const totals = quoteTotals(lines);
    // Serialise numbering per workspace so two people creating quotes at once never get the same number.
    await this.db.execute(sql`select pg_advisory_xact_lock(hashtext(${`crm-quote:${workspaceId}`}))`);
    const numbers = await this.db.select({ n: crmQuotes.number }).from(crmQuotes).where(eq(crmQuotes.workspaceId, workspaceId));
    const [r] = await this.db
      .insert(crmQuotes)
      .values({
        ...input,
        number: nextQuoteNumber(numbers.map((x) => x.n)),
        issueDate: input.issueDate ?? today(),
        lines,
        subtotal: totals.subtotal,
        tax: totals.tax,
        total: totals.total,
        organisationId: workspace.organisationId,
        workspaceId,
        createdById: userId,
      })
      .returning();
    return { quote: (await this.quoteDtos([r!]))[0]!, created: true };
  }

  async getQuote(userId: string, id: string): Promise<QuoteDto> {
    const r = await this.load<CrmQuote>(crmQuotes, 'Quote', userId, id, 'workspace.read');
    return (await this.quoteDtos([r]))[0]!;
  }

  async updateQuote(userId: string, id: string, input: UpdateQuoteInput): Promise<QuoteDto> {
    const r = await this.load<CrmQuote>(crmQuotes, 'Quote', userId, id, 'task.update');
    await this.checkLinks(r.workspaceId, { companyId: input.companyId, contactId: input.contactId, dealId: input.dealId });
    if (r.status === 'accepted' && (input.lines !== undefined || input.currency !== undefined)) {
      throw badRequest('An accepted quote can’t be changed. Duplicate it to make a new version.');
    }
    const set: Partial<CrmQuote> = { ...input } as Partial<CrmQuote>;
    if (input.lines) Object.assign(set, (({ subtotal, tax, total }) => ({ subtotal, tax, total }))(quoteTotals(input.lines)));
    const [u] = await this.db.update(crmQuotes).set(set).where(eq(crmQuotes.id, id)).returning();
    return (await this.quoteDtos([u!]))[0]!;
  }

  async removeQuote(userId: string, id: string) {
    await this.load<CrmQuote>(crmQuotes, 'Quote', userId, id, 'task.update');
    await this.db.update(crmQuotes).set({ deletedAt: new Date() }).where(eq(crmQuotes.id, id));
  }

}
