import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne } from 'drizzle-orm';
import {
  hrChecklistItems,
  hrChecklists,
  hrDocuments,
  hrLeaveRequests,
  hrProfiles,
  hrReviews,
  hrRoles,
  notifications,
  organisationMemberships,
  organisations,
  users,
  HrChecklist,
  HrLeaveRequest,
  HrProfile,
  HrReview,
} from '@monty/database';
import {
  addDays,
  allReports,
  canApproveLeave,
  canSeePrivate,
  CHECKLIST_TEMPLATES,
  leaveBalance,
  overlaps,
  workingDays,
  wouldCreateManagerCycle,
} from '@monty/domain';
import type {
  ChecklistDto,
  ChecklistInput,
  ChecklistItemInput,
  HrDocumentDto,
  HrMeDto,
  HrPersonDto,
  HrPrivate,
  HrProfileDto,
  LeaveDecisionInput,
  LeaveDto,
  LeaveRequestInput,
  ReviewDto,
  ReviewInput,
  UpdateChecklistItemInput,
  UpdateHrProfileInput,
  UpdateReviewInput,
} from '@monty/validation';
import { AppException, badRequest, conflict, forbidden, notFound } from '../common/errors';
import { decrypt, encrypt } from '../common/encryption';
import { AppConfig, CONFIG } from '../config';
import { DbService } from '../db/db.service';
import { cleanFilename, FilesService, INLINE } from '../files/files.service';
import { AuditService } from '../audit/audit.service';

const MAX_HR_FILE = 10 * 1024 * 1024;

interface Ctx {
  orgId: string;
  me: string;
  isHrAdmin: boolean;
  isOwner: boolean;
  /** Every member's manager (null = none), for chain checks. */
  managerOf: Map<string, string | null>;
  names: Map<string, { name: string; email: string }>;
  hrAdmins: Set<string>;
}

/**
 * HR for team organisations. Database row-level security keeps HR data inside the organisation; this service
 * applies the finer rules (see domain/hr.ts): private details for the person, HR admins and their management
 * chain only; salary for the person and HR admins only; sickness shown to others as "away".
 */
@Injectable()
export class HrService {
  constructor(
    private readonly dbs: DbService,
    private readonly files: FilesService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private get db() {
    return this.dbs.db;
  }

  /** Loads who I am in this organisation's HR. Personal organisations and guests have no HR. */
  async ctx(userId: string, orgId: string): Promise<Ctx> {
    const [org] = await this.db.select({ kind: organisations.kind }).from(organisations).where(and(eq(organisations.id, orgId), isNull(organisations.deletedAt)));
    const members = org
      ? await this.db
          .select({ userId: organisationMemberships.userId, role: organisationMemberships.role, name: users.name, email: users.email })
          .from(organisationMemberships)
          .innerJoin(users, and(eq(users.id, organisationMemberships.userId), isNull(users.deletedAt)))
          .where(and(eq(organisationMemberships.organisationId, orgId), ne(organisationMemberships.role, 'GUEST')))
      : [];
    const mine = members.find((m) => m.userId === userId);
    if (!org || !mine) throw notFound('Organisation');
    if (org.kind !== 'TEAM') throw badRequest('HR is available in team organisations.');
    const profiles = await this.db.select({ userId: hrProfiles.userId, managerId: hrProfiles.managerId }).from(hrProfiles).where(eq(hrProfiles.organisationId, orgId));
    const roles = await this.db.select({ userId: hrRoles.userId }).from(hrRoles).where(eq(hrRoles.organisationId, orgId));
    const memberIds = new Set(members.map((m) => m.userId));
    const managerOf = new Map<string, string | null>(members.map((m) => [m.userId, null]));
    for (const p of profiles) if (memberIds.has(p.userId)) managerOf.set(p.userId, p.managerId && memberIds.has(p.managerId) ? p.managerId : null);
    const hrAdmins = new Set([...members.filter((m) => m.role === 'OWNER').map((m) => m.userId), ...roles.map((r) => r.userId).filter((u) => memberIds.has(u))]);
    return {
      orgId,
      me: userId,
      isOwner: mine.role === 'OWNER',
      isHrAdmin: hrAdmins.has(userId),
      managerOf,
      names: new Map(members.map((m) => [m.userId, { name: m.name, email: m.email }])),
      hrAdmins,
    };
  }

  private viewer(c: Ctx) {
    return { userId: c.me, isHrAdmin: c.isHrAdmin };
  }
  private person(c: Ctx, id: string | null) {
    return id ? { id, name: c.names.get(id)?.name ?? 'Former member' } : null;
  }
  private requireMember(c: Ctx, userId: string, field = 'userId') {
    if (!c.names.has(userId)) throw badRequest('Not a member of this organisation', [{ path: field, message: 'Not a member' }]);
  }
  private requireHrAdmin(c: Ctx) {
    if (!c.isHrAdmin) throw forbidden('Only HR admins can do this.');
  }

  private sealPrivate(c: Ctx, userId: string, data: HrPrivate) {
    return encrypt(this.config.dataKey, JSON.stringify(data), `hr:${c.orgId}:${userId}`);
  }
  private openPrivate(c: Ctx, userId: string, sealed: string | null): HrPrivate {
    if (!sealed) return {};
    return JSON.parse(decrypt(this.config.dataKey, sealed, `hr:${c.orgId}:${userId}`).toString()) as HrPrivate;
  }

  private async notify(c: Ctx, recipients: string[], type: string, entityType: string, entityId: string, data: Record<string, unknown>, dedupe: string) {
    const to = [...new Set(recipients)].filter((u) => u !== c.me && c.names.has(u));
    if (!to.length) return;
    await this.db
      .insert(notifications)
      .values(to.map((userId) => ({ userId, organisationId: c.orgId, workspaceId: null, projectId: null, type, entityType, entityId, actorId: c.me, data: { ...data, organisationId: c.orgId }, dedupeKey: `${dedupe}:${userId}` })))
      .onConflictDoNothing();
  }

  // ---------- me, directory, profiles ----------

  async me(userId: string, orgId: string): Promise<HrMeDto> {
    const c = await this.ctx(userId, orgId);
    return { organisationId: orgId, isHrAdmin: c.isHrAdmin, isOwner: c.isOwner, reportIds: c.isHrAdmin ? [...c.names.keys()].filter((u) => u !== userId) : allReports(userId, c.managerOf) };
  }

  async directory(userId: string, orgId: string): Promise<HrPersonDto[]> {
    const c = await this.ctx(userId, orgId);
    const profiles = await this.db.select().from(hrProfiles).where(eq(hrProfiles.organisationId, orgId));
    return [...c.names.keys()]
      .map((u) => this.personDto(c, u, profiles.find((p) => p.userId === u)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private personDto(c: Ctx, userId: string, p: HrProfile | undefined): HrPersonDto {
    const n = c.names.get(userId)!;
    return {
      userId,
      name: n.name,
      email: n.email,
      jobTitle: p?.jobTitle ?? '',
      department: p?.department ?? '',
      manager: this.person(c, c.managerOf.get(userId) ?? null),
      startDate: p?.startDate ?? null,
      endDate: p?.endDate ?? null,
      employmentType: (p?.employmentType ?? 'full_time') as HrPersonDto['employmentType'],
      location: p?.location ?? '',
      workPhone: p?.workPhone ?? '',
      isHrAdmin: c.hrAdmins.has(userId),
    };
  }

  async profile(userId: string, orgId: string, subjectId: string): Promise<HrProfileDto> {
    const c = await this.ctx(userId, orgId);
    if (!c.names.has(subjectId)) throw notFound('Person');
    return this.profileDto(c, subjectId);
  }

  private async profileDto(c: Ctx, subjectId: string): Promise<HrProfileDto> {
    const [p] = await this.db.select().from(hrProfiles).where(and(eq(hrProfiles.organisationId, c.orgId), eq(hrProfiles.userId, subjectId)));
    const privateOk = canSeePrivate(this.viewer(c), subjectId, c.managerOf);
    let priv: HrPrivate | null = null;
    if (privateOk) {
      priv = this.openPrivate(c, subjectId, p?.privateData ?? null);
      // Pay is need-to-know: the person and HR, not every manager up the line.
      if (!(c.isHrAdmin || c.me === subjectId)) {
        delete priv.salary;
        delete priv.salaryCurrency;
      }
      if (!c.isHrAdmin) delete priv.notes; // HR's own notes
    }
    const year = new Date().getUTCFullYear();
    const balance = privateOk || canApproveLeave(this.viewer(c), subjectId, c.managerOf) ? await this.balance(c, subjectId, p?.annualLeaveDays ?? 25, year) : null;
    return {
      ...this.personDto(c, subjectId, p),
      annualLeaveDays: p?.annualLeaveDays ?? 25,
      private: priv,
      canEdit: { profile: c.isHrAdmin, personal: c.isHrAdmin || c.me === subjectId, salary: c.isHrAdmin },
      balance,
    };
  }

  private async balance(c: Ctx, userId: string, allowance: number, year: number) {
    const rows = await this.db
      .select()
      .from(hrLeaveRequests)
      .where(and(eq(hrLeaveRequests.organisationId, c.orgId), eq(hrLeaveRequests.userId, userId), lte(hrLeaveRequests.startDate, `${year}-12-31`), gte(hrLeaveRequests.endDate, `${year}-01-01`)));
    return { year, ...leaveBalance(allowance, rows, year) };
  }

  async updateProfile(userId: string, orgId: string, subjectId: string, input: UpdateHrProfileInput): Promise<HrProfileDto> {
    const c = await this.ctx(userId, orgId);
    if (!c.names.has(subjectId)) throw notFound('Person');
    const { private: priv, ...pub } = input;
    const self = c.me === subjectId;
    if (Object.keys(pub).length && !c.isHrAdmin) throw forbidden('Only HR admins can change job details.');
    if (priv && !c.isHrAdmin && !self) throw forbidden('Only HR admins or the person themselves can change personal details.');
    if (priv && !c.isHrAdmin && (priv.salary !== undefined || priv.salaryCurrency !== undefined || priv.notes !== undefined)) throw forbidden('Only HR admins can change pay and HR notes.');
    if (pub.managerId !== undefined) {
      if (pub.managerId) this.requireMember(c, pub.managerId, 'managerId');
      if (wouldCreateManagerCycle(subjectId, pub.managerId, c.managerOf)) throw badRequest('That would make a loop in the reporting line.', [{ path: 'managerId', message: 'Creates a loop' }]);
    }
    if (pub.startDate && pub.endDate && pub.endDate < pub.startDate) throw badRequest('The end date is before the start date', [{ path: 'endDate', message: 'Before start' }]);
    // Make sure the row exists, then lock it: two saves at once (e.g. address and salary) would otherwise both read the
    // old private data, merge in memory, and the later write would wipe the earlier one's change.
    await this.db.insert(hrProfiles).values({ organisationId: orgId, userId: subjectId, updatedById: c.me }).onConflictDoNothing({ target: [hrProfiles.organisationId, hrProfiles.userId] });
    const [existing] = await this.db.select().from(hrProfiles).where(and(eq(hrProfiles.organisationId, orgId), eq(hrProfiles.userId, subjectId))).for('update');
    if (!existing) throw notFound('Person');
    const values: Partial<HrProfile> = { ...pub, updatedById: c.me } as Partial<HrProfile>;
    if (priv) {
      const merged = { ...this.openPrivate(c, subjectId, existing.privateData), ...priv };
      values.privateData = this.sealPrivate(c, subjectId, merged);
    }
    await this.db.update(hrProfiles).set({ ...values, updatedAt: new Date() }).where(eq(hrProfiles.id, existing.id));
    await this.audit.recordSafely({
      organisationId: orgId,
      actorId: c.me,
      action: 'hr.profile_updated',
      targetType: 'user',
      targetId: subjectId,
      // Which fields changed, never their values.
      data: { fields: [...Object.keys(pub), ...Object.keys(priv ?? {}).map((k) => `private.${k}`)] },
    });
    if (pub.managerId !== undefined) c.managerOf.set(subjectId, pub.managerId);
    return this.profileDto(c, subjectId);
  }

  async setHrAdmin(userId: string, orgId: string, subjectId: string, on: boolean) {
    const c = await this.ctx(userId, orgId);
    if (!c.isOwner) throw forbidden('Only organisation owners can choose HR admins.');
    this.requireMember(c, subjectId);
    if (on) await this.db.insert(hrRoles).values({ organisationId: orgId, userId: subjectId, grantedById: c.me }).onConflictDoNothing();
    else await this.db.delete(hrRoles).where(and(eq(hrRoles.organisationId, orgId), eq(hrRoles.userId, subjectId)));
    await this.audit.recordSafely({ organisationId: orgId, actorId: c.me, action: on ? 'hr.admin_granted' : 'hr.admin_revoked', targetType: 'user', targetId: subjectId });
  }

  // ---------- leave ----------

  private leaveDto(c: Ctx, r: HrLeaveRequest): LeaveDto {
    const privateOk = canSeePrivate(this.viewer(c), r.userId, c.managerOf);
    const mayDecide = canApproveLeave(this.viewer(c), r.userId, c.managerOf);
    const started = r.startDate <= new Date().toISOString().slice(0, 10);
    return {
      id: r.id,
      user: this.person(c, r.userId)!,
      type: privateOk || mayDecide || r.type === 'annual' ? (r.type as LeaveDto['type']) : 'away',
      startDate: r.startDate,
      endDate: r.endDate,
      halfDay: r.halfDay,
      days: r.days,
      reason: privateOk || mayDecide ? r.reason : null,
      status: r.status as LeaveDto['status'],
      decidedBy: this.person(c, r.decidedById),
      decisionNote: privateOk || mayDecide ? r.decisionNote : null,
      createdAt: r.createdAt.toISOString(),
      canDecide: r.status === 'pending' && mayDecide,
      canCancel: (r.status === 'pending' || (r.status === 'approved' && !started)) && (r.userId === c.me || c.isHrAdmin),
    };
  }

  /** Leave in a date range. Everyone sees who's away; declined/cancelled only for the people involved. */
  async leave(userId: string, orgId: string, f: { from?: string; to?: string; userId?: string; status?: string }): Promise<LeaveDto[]> {
    const c = await this.ctx(userId, orgId);
    const rows = await this.db
      .select()
      .from(hrLeaveRequests)
      .where(
        and(
          eq(hrLeaveRequests.organisationId, orgId),
          f.from ? gte(hrLeaveRequests.endDate, f.from) : undefined,
          f.to ? lte(hrLeaveRequests.startDate, f.to) : undefined,
          f.userId ? eq(hrLeaveRequests.userId, f.userId) : undefined,
          f.status ? eq(hrLeaveRequests.status, f.status) : undefined,
        ),
      )
      .orderBy(asc(hrLeaveRequests.startDate))
      .limit(2000);
    return rows
      .filter((r) => c.names.has(r.userId))
      .filter((r) => r.status === 'approved' || r.status === 'pending' || canSeePrivate(this.viewer(c), r.userId, c.managerOf) || canApproveLeave(this.viewer(c), r.userId, c.managerOf))
      .map((r) => this.leaveDto(c, r));
  }

  async requestLeave(userId: string, orgId: string, input: LeaveRequestInput): Promise<{ leave: LeaveDto; created: boolean }> {
    const c = await this.ctx(userId, orgId);
    const forUser = input.userId ?? c.me;
    if (forUser !== c.me) {
      this.requireHrAdmin(c);
      this.requireMember(c, forUser);
    }
    if (input.id) {
      const [ex] = await this.db.select().from(hrLeaveRequests).where(eq(hrLeaveRequests.id, input.id));
      if (ex) {
        if (ex.organisationId !== orgId || ex.userId !== forUser) throw conflict('CONFLICT', 'This id is already in use');
        return { leave: this.leaveDto(c, ex), created: false };
      }
    }
    const days = workingDays(input.startDate, input.endDate, input.halfDay ?? false);
    if (days === 0) throw badRequest('Those dates are all weekend days.', [{ path: 'startDate', message: 'No working days' }]);
    const clash = (
      await this.db
        .select()
        .from(hrLeaveRequests)
        .where(and(eq(hrLeaveRequests.organisationId, orgId), eq(hrLeaveRequests.userId, forUser), inArray(hrLeaveRequests.status, ['pending', 'approved'])))
    ).find((r) => overlaps(r, input));
    if (clash) throw conflict('CONFLICT', `This overlaps leave already booked (${clash.startDate} to ${clash.endDate}).`);
    // Sickness recorded by HR is approved straight away; everything else waits for a manager or HR.
    const autoApprove = input.type === 'sick' && forUser !== c.me;
    const [r] = await this.db
      .insert(hrLeaveRequests)
      .values({
        id: input.id,
        organisationId: orgId,
        userId: forUser,
        type: input.type,
        startDate: input.startDate,
        endDate: input.endDate,
        halfDay: input.halfDay ?? false,
        days,
        reason: input.reason ?? '',
        status: autoApprove ? 'approved' : 'pending',
        ...(autoApprove ? { decidedById: c.me, decidedAt: new Date() } : {}),
      })
      .returning();
    if (!autoApprove) {
      const manager = c.managerOf.get(forUser);
      const approvers = manager ? [manager] : [...c.hrAdmins];
      await this.notify(c, approvers, 'leave_request', 'hr_leave', r!.id, { who: c.names.get(forUser)?.name, startDate: r!.startDate, endDate: r!.endDate, days }, `leave-req:${r!.id}`);
    }
    return { leave: this.leaveDto(c, r!), created: true };
  }

  async decideLeave(userId: string, orgId: string, id: string, input: LeaveDecisionInput): Promise<LeaveDto> {
    const c = await this.ctx(userId, orgId);
    const [r] = await this.db.select().from(hrLeaveRequests).where(and(eq(hrLeaveRequests.id, id), eq(hrLeaveRequests.organisationId, orgId)));
    if (!r || !c.names.has(r.userId)) throw notFound('Leave request');
    if (!canApproveLeave(this.viewer(c), r.userId, c.managerOf)) {
      if (r.userId === c.me) throw forbidden('You can’t approve your own leave.');
      throw forbidden('Only their manager or HR can decide this.');
    }
    if (r.status !== 'pending') throw conflict('CONFLICT', `This request is already ${r.status}.`);
    const [u] = await this.db
      .update(hrLeaveRequests)
      .set({ status: input.decision, decidedById: c.me, decidedAt: new Date(), decisionNote: input.note ?? '' })
      .where(and(eq(hrLeaveRequests.id, id), eq(hrLeaveRequests.status, 'pending')))
      .returning();
    if (!u) throw conflict('CONFLICT', 'Someone else just decided this request.');
    await this.notify(c, [r.userId], `leave_${input.decision}`, 'hr_leave', r.id, { startDate: r.startDate, endDate: r.endDate }, `leave-dec:${r.id}`);
    await this.audit.recordSafely({ organisationId: orgId, actorId: c.me, action: `hr.leave_${input.decision}`, targetType: 'hr_leave', targetId: r.id });
    return this.leaveDto(c, u);
  }

  async cancelLeave(userId: string, orgId: string, id: string): Promise<LeaveDto> {
    const c = await this.ctx(userId, orgId);
    const [r] = await this.db.select().from(hrLeaveRequests).where(and(eq(hrLeaveRequests.id, id), eq(hrLeaveRequests.organisationId, orgId)));
    if (!r || !c.names.has(r.userId)) throw notFound('Leave request');
    if (!this.leaveDto(c, r).canCancel) throw forbidden('This leave can’t be cancelled now. Ask HR.');
    const [u] = await this.db.update(hrLeaveRequests).set({ status: 'cancelled' }).where(eq(hrLeaveRequests.id, id)).returning();
    if (r.status === 'approved') {
      const manager = c.managerOf.get(r.userId);
      await this.notify(c, manager ? [manager] : [...c.hrAdmins], 'leave_cancelled', 'hr_leave', r.id, { who: c.names.get(r.userId)?.name, startDate: r.startDate, endDate: r.endDate }, `leave-cancel:${r.id}`);
    }
    return this.leaveDto(c, u!);
  }

  // ---------- onboarding / offboarding ----------

  private canSeeChecklist(c: Ctx, cl: HrChecklist, assignees: (string | null)[]) {
    if (c.isHrAdmin || assignees.includes(c.me) || cl.subjectUserId === c.me) return true;
    return cl.subjectUserId ? c.managerOf.get(cl.subjectUserId) === c.me || (canSeePrivate(this.viewer(c), cl.subjectUserId, c.managerOf) && cl.subjectUserId !== c.me) : false;
  }

  private async checklistDtos(c: Ctx, lists: HrChecklist[]): Promise<ChecklistDto[]> {
    if (!lists.length) return [];
    const items = await this.db.select().from(hrChecklistItems).where(inArray(hrChecklistItems.checklistId, lists.map((l) => l.id))).orderBy(asc(hrChecklistItems.position));
    return lists
      .filter((l) => this.canSeeChecklist(c, l, items.filter((i) => i.checklistId === l.id).map((i) => i.assigneeId)))
      .map((l) => {
        const its = items.filter((i) => i.checklistId === l.id);
        return {
          id: l.id,
          kind: l.kind as ChecklistDto['kind'],
          title: l.title,
          subjectName: l.subjectName,
          subjectUserId: l.subjectUserId,
          dueDate: l.dueDate,
          createdAt: l.createdAt.toISOString(),
          done: its.filter((i) => i.doneAt).length,
          total: its.length,
          items: its.map((i) => ({
            id: i.id,
            title: i.title,
            assignee: this.person(c, i.assigneeId),
            dueDate: i.dueDate,
            doneAt: i.doneAt?.toISOString() ?? null,
            doneBy: this.person(c, i.doneById),
            canTick: c.isHrAdmin || i.assigneeId === c.me,
          })),
        };
      });
  }

  async checklists(userId: string, orgId: string): Promise<ChecklistDto[]> {
    const c = await this.ctx(userId, orgId);
    const lists = await this.db.select().from(hrChecklists).where(and(eq(hrChecklists.organisationId, orgId), isNull(hrChecklists.deletedAt))).orderBy(desc(hrChecklists.createdAt)).limit(500);
    return this.checklistDtos(c, lists);
  }

  async createChecklist(userId: string, orgId: string, input: ChecklistInput): Promise<ChecklistDto> {
    const c = await this.ctx(userId, orgId);
    this.requireHrAdmin(c);
    if (input.subjectUserId) this.requireMember(c, input.subjectUserId, 'subjectUserId');
    for (const k of ['hr', 'manager', 'it'] as const) if (input.assignees?.[k]) this.requireMember(c, input.assignees[k]!, `assignees.${k}`);
    if (input.id) {
      const [ex] = await this.db.select().from(hrChecklists).where(eq(hrChecklists.id, input.id));
      if (ex) return (await this.checklistDtos(c, [ex]))[0]!;
    }
    const due = input.dueDate ?? new Date().toISOString().slice(0, 10);
    const [cl] = await this.db
      .insert(hrChecklists)
      .values({
        id: input.id,
        organisationId: orgId,
        kind: input.kind,
        title: `${input.kind === 'onboarding' ? 'Onboarding' : 'Offboarding'}: ${input.subjectName}`,
        subjectName: input.subjectName,
        subjectUserId: input.subjectUserId ?? null,
        dueDate: input.dueDate ?? null,
        createdById: c.me,
      })
      .returning();
    const who = { hr: input.assignees?.hr ?? c.me, manager: input.assignees?.manager ?? (input.subjectUserId ? c.managerOf.get(input.subjectUserId) : null) ?? null, it: input.assignees?.it ?? null };
    const items = CHECKLIST_TEMPLATES[input.kind].map((t, i) => ({ organisationId: orgId, checklistId: cl!.id, title: t.title, assigneeId: who[t.role], dueDate: addDays(due, t.offset), position: (i + 1) * 1024 }));
    await this.db.insert(hrChecklistItems).values(items);
    for (const a of new Set(items.map((i) => i.assigneeId).filter((x): x is string => !!x))) {
      await this.notify(c, [a], 'checklist_assigned', 'hr_checklist', cl!.id, { title: cl!.title, steps: items.filter((i) => i.assigneeId === a).length }, `checklist:${cl!.id}`);
    }
    return (await this.checklistDtos(c, [cl!]))[0]!;
  }

  async addChecklistItem(userId: string, orgId: string, checklistId: string, input: ChecklistItemInput): Promise<ChecklistDto> {
    const c = await this.ctx(userId, orgId);
    this.requireHrAdmin(c);
    const [cl] = await this.db.select().from(hrChecklists).where(and(eq(hrChecklists.id, checklistId), eq(hrChecklists.organisationId, orgId), isNull(hrChecklists.deletedAt)));
    if (!cl) throw notFound('Checklist');
    if (input.assigneeId) this.requireMember(c, input.assigneeId, 'assigneeId');
    await this.db.insert(hrChecklistItems).values({ organisationId: orgId, checklistId, title: input.title, assigneeId: input.assigneeId ?? null, dueDate: input.dueDate ?? null, position: Date.now() });
    if (input.assigneeId) await this.notify(c, [input.assigneeId], 'checklist_assigned', 'hr_checklist', cl.id, { title: cl.title, steps: 1 }, `checklist:${cl.id}:${Date.now()}`);
    return (await this.checklistDtos(c, [cl]))[0]!;
  }

  async updateChecklistItem(userId: string, orgId: string, itemId: string, input: UpdateChecklistItemInput): Promise<ChecklistDto> {
    const c = await this.ctx(userId, orgId);
    const [it] = await this.db.select().from(hrChecklistItems).where(and(eq(hrChecklistItems.id, itemId), eq(hrChecklistItems.organisationId, orgId)));
    const [cl] = it ? await this.db.select().from(hrChecklists).where(and(eq(hrChecklists.id, it.checklistId), isNull(hrChecklists.deletedAt))) : [];
    if (!it || !cl) throw notFound('Checklist step');
    const onlyTick = Object.keys(input).every((k) => k === 'done');
    if (!c.isHrAdmin && !(onlyTick && it.assigneeId === c.me)) {
      const all = await this.db.select({ a: hrChecklistItems.assigneeId }).from(hrChecklistItems).where(eq(hrChecklistItems.checklistId, cl.id));
      if (!this.canSeeChecklist(c, cl, all.map((x) => x.a))) throw notFound('Checklist step');
      throw forbidden('Only the person it’s assigned to, or HR, can tick this step.');
    }
    if (input.assigneeId) this.requireMember(c, input.assigneeId, 'assigneeId');
    const { done, ...rest } = input;
    await this.db
      .update(hrChecklistItems)
      .set({ ...rest, ...(done === undefined ? {} : done ? { doneAt: it.doneAt ?? new Date(), doneById: it.doneById ?? c.me } : { doneAt: null, doneById: null }) })
      .where(eq(hrChecklistItems.id, itemId));
    return (await this.checklistDtos(c, [cl]))[0]!;
  }

  async removeChecklist(userId: string, orgId: string, id: string) {
    const c = await this.ctx(userId, orgId);
    this.requireHrAdmin(c);
    await this.db.update(hrChecklists).set({ deletedAt: new Date() }).where(and(eq(hrChecklists.id, id), eq(hrChecklists.organisationId, orgId)));
  }

  // ---------- documents (encrypted at rest) ----------

  private requirePrivate(c: Ctx, subjectId: string) {
    if (!c.names.has(subjectId) || !canSeePrivate(this.viewer(c), subjectId, c.managerOf)) throw notFound('Person');
  }

  private docDto(c: Ctx, d: typeof hrDocuments.$inferSelect): HrDocumentDto {
    return {
      id: d.id,
      category: d.category as HrDocumentDto['category'],
      filename: d.filename,
      contentType: d.contentType,
      sizeBytes: d.sizeBytes,
      uploader: this.person(c, d.uploaderId)!,
      createdAt: d.createdAt.toISOString(),
      url: `/api/v1/organisations/${c.orgId}/hr/documents/${d.id}`,
    };
  }

  async documents(userId: string, orgId: string, subjectId: string): Promise<HrDocumentDto[]> {
    const c = await this.ctx(userId, orgId);
    this.requirePrivate(c, subjectId);
    const rows = await this.db
      .select()
      .from(hrDocuments)
      .where(and(eq(hrDocuments.organisationId, orgId), eq(hrDocuments.subjectUserId, subjectId), isNull(hrDocuments.deletedAt)))
      .orderBy(desc(hrDocuments.createdAt));
    return rows.map((d) => this.docDto(c, d));
  }

  async uploadDocument(userId: string, orgId: string, subjectId: string, category: string, rawName: string | undefined, body: Readable): Promise<HrDocumentDto> {
    const c = await this.ctx(userId, orgId);
    this.requireHrAdmin(c);
    this.requireMember(c, subjectId);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of body) {
      size += (chunk as Buffer).length;
      if (size > MAX_HR_FILE) throw new AppException(413, 'VALIDATION_FAILED', 'HR documents can be up to 10 MB.');
      chunks.push(chunk as Buffer);
    }
    const bytes = Buffer.concat(chunks);
    if (!bytes.length) throw badRequest('The file is empty.');
    const id = randomUUID();
    const key = randomBytes(24).toString('hex');
    const file = this.files.pathOf(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, encrypt(this.config.dataKey, bytes, `hrdoc:${id}`), { mode: 0o600, flag: 'wx' });
    try {
      const [d] = await this.db
        .insert(hrDocuments)
        .values({
          id,
          organisationId: orgId,
          subjectUserId: subjectId,
          category,
          filename: cleanFilename(rawName),
          contentType: INLINE.find((i) => i.magic(bytes.subarray(0, 16)))?.type ?? 'application/octet-stream',
          sizeBytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          storageKey: key,
          uploaderId: c.me,
        })
        .returning();
      await this.audit.recordSafely({ organisationId: orgId, actorId: c.me, action: 'hr.document_uploaded', targetType: 'user', targetId: subjectId, data: { category } });
      return this.docDto(c, d!);
    } catch (err) {
      await rm(file, { force: true });
      throw err;
    }
  }

  async openDocument(userId: string, orgId: string, id: string) {
    const c = await this.ctx(userId, orgId);
    const [d] = await this.db.select().from(hrDocuments).where(and(eq(hrDocuments.id, id), eq(hrDocuments.organisationId, orgId), isNull(hrDocuments.deletedAt)));
    if (!d) throw notFound('Document');
    this.requirePrivate(c, d.subjectUserId);
    const bytes = decrypt(this.config.dataKey, (await readFile(this.files.pathOf(d.storageKey))).toString(), `hrdoc:${d.id}`);
    await this.audit.recordSafely({ organisationId: orgId, actorId: c.me, action: 'hr.document_viewed', targetType: 'hr_document', targetId: d.id });
    return { doc: d, bytes };
  }

  async removeDocument(userId: string, orgId: string, id: string) {
    const c = await this.ctx(userId, orgId);
    this.requireHrAdmin(c);
    await this.db.update(hrDocuments).set({ deletedAt: new Date() }).where(and(eq(hrDocuments.id, id), eq(hrDocuments.organisationId, orgId)));
  }

  // ---------- reviews (encrypted at rest) ----------

  private reviewVisible(c: Ctx, r: HrReview) {
    if (c.isHrAdmin || r.reviewerId === c.me) return true;
    if (r.subjectUserId === c.me) return r.status === 'shared';
    return managementChainIncludes(c, r.subjectUserId);
  }

  private reviewDto(c: Ctx, r: HrReview): ReviewDto {
    const body = JSON.parse(decrypt(this.config.dataKey, r.content, `hrreview:${r.id}`).toString()) as { strengths?: string; improvements?: string; goals?: string; notes?: string };
    return {
      id: r.id,
      subject: this.person(c, r.subjectUserId)!,
      reviewer: this.person(c, r.reviewerId)!,
      period: r.period,
      rating: r.rating,
      strengths: body.strengths ?? '',
      improvements: body.improvements ?? '',
      goals: body.goals ?? '',
      // Private reviewer notes are never shown to the person reviewed.
      notes: r.subjectUserId === c.me && !c.isHrAdmin ? '' : (body.notes ?? ''),
      status: r.status as ReviewDto['status'],
      sharedAt: r.sharedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      canEdit: r.status === 'draft' && (c.isHrAdmin || r.reviewerId === c.me),
    };
  }

  async reviews(userId: string, orgId: string, subjectId?: string): Promise<ReviewDto[]> {
    const c = await this.ctx(userId, orgId);
    const rows = await this.db
      .select()
      .from(hrReviews)
      .where(and(eq(hrReviews.organisationId, orgId), isNull(hrReviews.deletedAt), subjectId ? eq(hrReviews.subjectUserId, subjectId) : undefined))
      .orderBy(desc(hrReviews.createdAt))
      .limit(500);
    return rows.filter((r) => c.names.has(r.subjectUserId) && this.reviewVisible(c, r)).map((r) => this.reviewDto(c, r));
  }

  async createReview(userId: string, orgId: string, input: ReviewInput): Promise<ReviewDto> {
    const c = await this.ctx(userId, orgId);
    this.requireMember(c, input.subjectUserId, 'subjectUserId');
    if (input.subjectUserId === c.me) throw forbidden('You can’t review yourself here.');
    if (!c.isHrAdmin && !managementChainIncludes(c, input.subjectUserId)) throw forbidden('Only their manager or HR can write a review.');
    const id = randomUUID();
    const { subjectUserId, period, rating, ...body } = input;
    const [r] = await this.db
      .insert(hrReviews)
      .values({ id, organisationId: orgId, subjectUserId, reviewerId: c.me, period, rating: rating ?? null, content: encrypt(this.config.dataKey, JSON.stringify(body), `hrreview:${id}`) })
      .returning();
    return this.reviewDto(c, r!);
  }

  async updateReview(userId: string, orgId: string, id: string, input: UpdateReviewInput): Promise<ReviewDto> {
    const c = await this.ctx(userId, orgId);
    const [r] = await this.db.select().from(hrReviews).where(and(eq(hrReviews.id, id), eq(hrReviews.organisationId, orgId), isNull(hrReviews.deletedAt)));
    if (!r || !c.names.has(r.subjectUserId) || !this.reviewVisible(c, r)) throw notFound('Review');
    if (!(c.isHrAdmin || r.reviewerId === c.me)) throw forbidden('Only the reviewer or HR can change this review.');
    if (r.status === 'shared') throw badRequest('This review has been shared and can’t be changed.');
    const { share, period, rating, ...body } = input;
    const current = JSON.parse(decrypt(this.config.dataKey, r.content, `hrreview:${r.id}`).toString());
    const [u] = await this.db
      .update(hrReviews)
      .set({
        ...(period !== undefined ? { period } : {}),
        ...(rating !== undefined ? { rating } : {}),
        content: encrypt(this.config.dataKey, JSON.stringify({ ...current, ...body }), `hrreview:${r.id}`),
        ...(share ? { status: 'shared', sharedAt: new Date() } : {}),
      })
      .where(eq(hrReviews.id, id))
      .returning();
    if (share) await this.notify(c, [r.subjectUserId], 'review_shared', 'hr_review', r.id, { period: u!.period }, `review:${r.id}`);
    return this.reviewDto(c, u!);
  }

  async removeReview(userId: string, orgId: string, id: string) {
    const c = await this.ctx(userId, orgId);
    const [r] = await this.db.select().from(hrReviews).where(and(eq(hrReviews.id, id), eq(hrReviews.organisationId, orgId), isNull(hrReviews.deletedAt)));
    if (!r || !this.reviewVisible(c, r)) throw notFound('Review');
    if (!(c.isHrAdmin || (r.reviewerId === c.me && r.status === 'draft'))) throw forbidden('Only HR can delete a shared review.');
    await this.db.update(hrReviews).set({ deletedAt: new Date() }).where(eq(hrReviews.id, id));
  }

  /** My open items across HR: leave to decide and checklist steps assigned to me. */
  async inbox(userId: string, orgId: string) {
    const c = await this.ctx(userId, orgId);
    const pending = await this.db.select().from(hrLeaveRequests).where(and(eq(hrLeaveRequests.organisationId, orgId), eq(hrLeaveRequests.status, 'pending')));
    const items = await this.db
      .select({ id: hrChecklistItems.id })
      .from(hrChecklistItems)
      .innerJoin(hrChecklists, and(eq(hrChecklists.id, hrChecklistItems.checklistId), isNull(hrChecklists.deletedAt)))
      .where(and(eq(hrChecklistItems.organisationId, orgId), eq(hrChecklistItems.assigneeId, c.me), isNull(hrChecklistItems.doneAt)));
    return {
      leaveToDecide: pending.filter((r) => c.names.has(r.userId) && canApproveLeave(this.viewer(c), r.userId, c.managerOf)).map((r) => this.leaveDto(c, r)),
      openSteps: items.length,
    };
  }
}

function managementChainIncludes(c: Ctx, subjectId: string) {
  return canSeePrivate({ userId: c.me, isHrAdmin: false }, subjectId, c.managerOf) && subjectId !== c.me;
}

