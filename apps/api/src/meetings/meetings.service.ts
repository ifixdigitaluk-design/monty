import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { and, asc, eq, gte, inArray, lt } from 'drizzle-orm';
import { Meeting, meetings, users } from '@monty/database';
import { canInWorkspace } from '@monty/domain';
import type { MeetingDto, MeetingInput, UpdateMeetingInput } from '@monty/validation';
import { CollaborationService } from '../collaboration/collaboration.service';
import { conflict, forbidden, notFound } from '../common/errors';
import { DbService } from '../db/db.service';
import { AccessService } from '../tenancy/access.service';

/** Free, no-account video rooms; the room name is unguessable. Organisers can paste their own Meet/Teams/Zoom link instead. */
export const jitsiLink = () => `https://meet.jit.si/Monty-${randomBytes(12).toString('base64url')}`;

/**
 * Meetings belong to a workspace (a department). Anyone in the workspace sees them; the organiser and workspace
 * admins change or cancel them; attendees also write minutes and tick action items.
 */
@Injectable()
export class MeetingsService {
  constructor(
    private readonly dbs: DbService,
    private readonly access: AccessService,
    private readonly collab: CollaborationService,
  ) {}

  private async load(userId: string, id: string) {
    const [m] = await this.dbs.db.select().from(meetings).where(eq(meetings.id, id));
    if (!m) throw notFound('Meeting');
    const a = await this.access.workspaceAccess(userId, m.workspaceId);
    if (!a) throw notFound('Meeting');
    return { m, role: a.role };
  }

  private async attendeesOk(workspaceId: string, ids: string[]) {
    for (const u of ids) await this.access.assertCanBeAssigned(u, workspaceId, 'attendeeIds');
  }

  private async dtos(userId: string, rows: Meeting[], role: 'ADMIN' | 'MEMBER' | 'VIEWER'): Promise<MeetingDto[]> {
    const ids = [...new Set(rows.flatMap((m) => [m.organizerId, ...m.attendeeIds]))];
    const names = new Map(ids.length ? (await this.dbs.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.name]) : []);
    const who = (id: string) => ({ id, name: names.get(id) ?? 'Former member' });
    return rows.map((m) => ({
      id: m.id,
      workspaceId: m.workspaceId,
      title: m.title,
      startsAt: m.startsAt.toISOString(),
      endsAt: new Date(m.startsAt.getTime() + m.durationMinutes * 60_000).toISOString(),
      durationMinutes: m.durationMinutes,
      videoUrl: m.videoUrl,
      location: m.location,
      agenda: m.agenda,
      minutes: m.minutes,
      organizer: who(m.organizerId),
      attendees: m.attendeeIds.map(who),
      actionItems: m.actionItems,
      cancelled: m.cancelledAt !== null,
      canEdit: m.organizerId === userId || canInWorkspace(role, 'workspace.manage'),
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
    }));
  }

  async list(userId: string, workspaceId: string, from?: Date, to?: Date): Promise<MeetingDto[]> {
    const { role } = await this.access.requireWorkspace(userId, workspaceId, 'workspace.read');
    const rows = await this.dbs.db
      .select()
      .from(meetings)
      .where(and(eq(meetings.workspaceId, workspaceId), from ? gte(meetings.startsAt, from) : undefined, to ? lt(meetings.startsAt, to) : undefined))
      .orderBy(asc(meetings.startsAt))
      .limit(500);
    return this.dtos(userId, rows, role);
  }

  async get(userId: string, id: string): Promise<MeetingDto> {
    const { m, role } = await this.load(userId, id);
    return (await this.dtos(userId, [m], role))[0]!;
  }

  async create(userId: string, workspaceId: string, input: MeetingInput): Promise<{ meeting: MeetingDto; created: boolean }> {
    const { workspace, role } = await this.access.requireWorkspace(userId, workspaceId, 'task.create');
    if (input.id) {
      const [ex] = await this.dbs.db.select().from(meetings).where(eq(meetings.id, input.id));
      if (ex) {
        if (ex.organizerId !== userId || ex.workspaceId !== workspaceId) throw conflict('CONFLICT', 'This id is already in use');
        return { meeting: (await this.dtos(userId, [ex], role))[0]!, created: false };
      }
    }
    const attendeeIds = [...new Set([userId, ...(input.attendeeIds ?? [])])];
    await this.attendeesOk(workspaceId, attendeeIds);
    const [m] = await this.dbs.db
      .insert(meetings)
      .values({
        id: input.id,
        organisationId: workspace.organisationId,
        workspaceId,
        title: input.title,
        startsAt: new Date(input.startsAt),
        durationMinutes: input.durationMinutes ?? 30,
        videoUrl: input.videoUrl?.trim() || jitsiLink(),
        location: input.location ?? '',
        agenda: input.agenda ?? '',
        attendeeIds,
        organizerId: userId,
      })
      .returning();
    await this.invite(m!, userId, attendeeIds, 'invite');
    return { meeting: (await this.dtos(userId, [m!], role))[0]!, created: true };
  }

  private async invite(m: Meeting, actorId: string, recipients: string[], why: 'invite' | 'changed' | 'cancelled') {
    await this.collab.notify({
      recipients,
      actorId,
      organisationId: m.organisationId,
      workspaceId: m.workspaceId,
      projectId: null,
      type: 'meeting',
      entityType: 'meeting',
      entityId: m.id,
      data: { title: m.title, startsAt: m.startsAt.toISOString(), why, workspaceId: m.workspaceId },
      dedupeKey: `meeting:${m.id}:${why}:${m.updatedAt.getTime()}`,
    });
  }

  async update(userId: string, id: string, input: UpdateMeetingInput): Promise<MeetingDto> {
    const { m, role } = await this.load(userId, id);
    const organiserLike = m.organizerId === userId || canInWorkspace(role, 'workspace.manage');
    const attendee = m.attendeeIds.includes(userId);
    const notesOnly = Object.keys(input).every((k) => k === 'minutes' || k === 'actionItems');
    if (!organiserLike && !(notesOnly && (attendee || canInWorkspace(role, 'task.update')))) {
      throw forbidden('Only the organiser or a workspace admin can change this meeting. Attendees can write minutes and action items.');
    }
    if (input.attendeeIds) await this.attendeesOk(m.workspaceId, input.attendeeIds);
    for (const a of input.actionItems ?? []) if (a.assigneeId) await this.access.assertCanBeAssigned(a.assigneeId, m.workspaceId, 'actionItems');
    const { cancelled, startsAt, videoUrl, ...rest } = input;
    const [u] = await this.dbs.db
      .update(meetings)
      .set({
        ...rest,
        ...(startsAt ? { startsAt: new Date(startsAt) } : {}),
        ...(videoUrl !== undefined ? { videoUrl: videoUrl.trim() || jitsiLink() } : {}),
        ...(cancelled !== undefined ? { cancelledAt: cancelled ? new Date() : null } : {}),
      })
      .where(eq(meetings.id, id))
      .returning();
    const newcomers = (input.attendeeIds ?? []).filter((a) => !m.attendeeIds.includes(a));
    if (newcomers.length) await this.invite(u!, userId, newcomers, 'invite');
    if (cancelled) await this.invite(u!, userId, u!.attendeeIds, 'cancelled');
    else if (startsAt && startsAt !== m.startsAt.toISOString()) await this.invite(u!, userId, u!.attendeeIds, 'changed');
    // New action items assigned to someone tell them.
    const before = new Set(m.actionItems.map((a) => `${a.id}:${a.assigneeId}`));
    for (const a of input.actionItems ?? []) {
      if (a.assigneeId && !before.has(`${a.id}:${a.assigneeId}`)) {
        await this.collab.notify({
          recipients: [a.assigneeId], actorId: userId, organisationId: u!.organisationId, workspaceId: u!.workspaceId, projectId: null,
          type: 'assigned', entityType: 'meeting', entityId: u!.id, data: { title: u!.title, actionItem: a.text, workspaceId: u!.workspaceId }, dedupeKey: `meeting-action:${a.id}:${a.assigneeId}`,
        });
      }
    }
    return (await this.dtos(userId, [u!], role))[0]!;
  }

  async remove(userId: string, id: string) {
    const { m, role } = await this.load(userId, id);
    if (m.organizerId !== userId && !canInWorkspace(role, 'workspace.manage')) throw forbidden('Only the organiser or a workspace admin can delete this meeting.');
    await this.dbs.db.delete(meetings).where(eq(meetings.id, id));
  }

  /** Calendar file (RFC 5545) so people can add the meeting to Outlook / Google Calendar. */
  async ics(userId: string, id: string, appUrl: string): Promise<{ name: string; body: string }> {
    const d = await this.get(userId, id);
    const stamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Monty//Meetings//EN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
      `UID:${d.id}@monty`, `DTSTAMP:${stamp(new Date().toISOString())}`, `DTSTART:${stamp(d.startsAt)}`, `DTEND:${stamp(d.endsAt)}`,
      `SUMMARY:${esc(d.title)}`, `LOCATION:${esc(d.location || d.videoUrl)}`, `URL:${d.videoUrl}`,
      `DESCRIPTION:${esc(`Join: ${d.videoUrl}\n${d.agenda ? `\nAgenda:\n${d.agenda}\n` : ''}\nIn Monty: ${appUrl}/meetings?ws=${d.workspaceId}&id=${d.id}`)}`,
      `STATUS:${d.cancelled ? 'CANCELLED' : 'CONFIRMED'}`, 'END:VEVENT', 'END:VCALENDAR',
    ];
    return { name: `${d.title.replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'meeting'}.ics`, body: lines.join('\r\n') + '\r\n' };
  }
}
