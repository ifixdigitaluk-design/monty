import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { canInWorkspace } from '@monty/domain';
import { channelMembers, channels, DbOrTx, messageReactions, messages, users } from '@monty/database';
import {
  ChannelDto,
  ChatUnreadDto,
  CreateChannelInput,
  extractMentions,
  MessageDto,
  PostMessageInput,
  UpdateChannelInput,
} from '@monty/validation';
import { badRequest, conflict, forbidden, notFound } from '../common/errors';
import { CollaborationService } from '../collaboration/collaboration.service';
import { DbService } from '../db/db.service';
import { AccessService } from '../tenancy/access.service';

type Channel = typeof channels.$inferSelect;
export type ChatEventKind = 'message.created' | 'message.updated' | 'message.deleted' | 'reaction' | 'channel.updated' | 'channel.read';

const PRIVATE_MEMBER_LIMIT = 150; // live-event fan-out lists members inside a Postgres NOTIFY payload (8 kB)
const PAGE = 50;

/**
 * Team chat: public/private channels and direct messages inside a workspace.
 * Visibility is enforced twice: here (permission checks, 404 for invisible channels) and by Postgres row-level
 * security on channels/messages (app_user_visible_channel_ids), so a missing check cannot leak a private message.
 * Live events are pointers sent only to people who may see the channel; clients refetch through this API.
 */
@Injectable()
export class ChatService {
  constructor(
    private readonly dbs: DbService,
    private readonly access: AccessService,
    private readonly collab: CollaborationService,
  ) {}

  // ---------- helpers ----------

  /** Channel the user can see (RLS) in a workspace they still have access to; 404 otherwise. */
  private async visibleChannel(userId: string, channelId: string) {
    const ch = await this.dbs.db.query.channels.findFirst({ where: eq(channels.id, channelId) });
    if (!ch) throw notFound('Channel');
    const ws = await this.access.workspaceAccess(userId, ch.workspaceId);
    if (!ws) throw notFound('Channel');
    const [member] = await this.dbs.db.select().from(channelMembers).where(and(eq(channelMembers.channelId, ch.id), eq(channelMembers.userId, userId)));
    if (ch.kind !== 'public' && !member) throw notFound('Channel');
    return { ch, ws, member: member ?? null };
  }

  private async requireMember(userId: string, channelId: string) {
    const v = await this.visibleChannel(userId, channelId);
    if (!v.member) throw forbidden('Join the channel first.');
    if (v.ch.archivedAt) throw conflict('CONFLICT', 'This channel is archived.');
    return v;
  }

  /** Who should receive live events for a channel (null = everyone in the workspace). */
  private async audience(ch: Channel, db: DbOrTx = this.dbs.db): Promise<string[] | null> {
    if (ch.kind === 'public') return null;
    const rows = await db.select({ u: channelMembers.userId }).from(channelMembers).where(eq(channelMembers.channelId, ch.id));
    return rows.map((r) => r.u);
  }

  private async emit(ch: Channel, kind: ChatEventKind, extra: { messageId?: string; parentId?: string | null; actorId: string }, onlyUser?: string) {
    const memberIds = onlyUser ? [onlyUser] : await this.audience(ch);
    const payload = { workspaceId: ch.workspaceId, channelId: ch.id, kind, messageId: extra.messageId ?? null, parentId: extra.parentId ?? null, actorId: extra.actorId, memberIds, at: new Date().toISOString() };
    await this.dbs.db.execute(sql`select pg_notify('monty_chat', ${JSON.stringify(payload)})`);
  }

  private async names(ids: string[]) {
    if (!ids.length) return new Map<string, string>();
    const rows = await this.dbs.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  // ---------- channels ----------

  async list(userId: string, workspaceId: string): Promise<ChannelDto[]> {
    await this.access.requireWorkspace(userId, workspaceId, 'workspace.read');
    // RLS already limits this to public channels + the user's private channels and DMs.
    const rows = await this.dbs.db.execute<{
      id: string; kind: ChannelDto['kind']; name: string | null; topic: string; archived_at: string | null; role: 'member' | 'admin' | null;
      member_count: number; unread: number; mentions: number; last_message_at: string | null;
    }>(sql`
      select c.id, c.kind, c.name, c.topic, c.archived_at, me.role,
        (select count(*)::int from channel_members x where x.channel_id = c.id) as member_count,
        coalesce((select count(*)::int from messages m where m.channel_id = c.id and m.parent_id is null and m.deleted_at is null
                   and m.author_id <> ${userId} and me.id is not null and m.created_at > me.last_read_at), 0) as unread,
        coalesce((select count(*)::int from messages m where m.channel_id = c.id and m.deleted_at is null and m.author_id <> ${userId}
                   and me.id is not null and m.created_at > me.last_read_at and m.body like ${'%<@' + userId + '>%'}), 0) as mentions,
        (select max(m.created_at)::text from messages m where m.channel_id = c.id and m.deleted_at is null) as last_message_at
      from channels c
      left join channel_members me on me.channel_id = c.id and me.user_id = ${userId}
      where c.workspace_id = ${workspaceId} and (c.kind = 'public' or me.id is not null)
      order by c.kind = 'dm', c.name nulls last, last_message_at desc nulls last`);
    const dmIds = rows.rows.filter((r) => r.kind === 'dm').map((r) => r.id);
    const dmMembers = dmIds.length
      ? await this.dbs.db
          .select({ channelId: channelMembers.channelId, id: users.id, name: users.name })
          .from(channelMembers)
          .innerJoin(users, eq(users.id, channelMembers.userId))
          .where(inArray(channelMembers.channelId, dmIds))
      : [];
    return rows.rows.map((r) => {
      const members = dmMembers.filter((m) => m.channelId === r.id).map((m) => ({ id: m.id, name: m.name }));
      const others = members.filter((m) => m.id !== userId);
      return {
        id: r.id,
        workspaceId,
        kind: r.kind,
        name: r.kind === 'dm' ? (others.map((m) => m.name).join(', ') || 'Just you') : r.name!,
        topic: r.topic,
        isMember: r.role !== null,
        role: r.role,
        memberCount: r.member_count,
        ...(r.kind === 'dm' ? { members } : {}),
        unread: r.unread,
        mentions: r.mentions,
        lastMessageAt: r.last_message_at ? new Date(r.last_message_at).toISOString() : null,
        archived: r.archived_at !== null,
      };
    });
  }

  private async dto(userId: string, channelId: string): Promise<ChannelDto> {
    const ch = await this.dbs.db.query.channels.findFirst({ where: eq(channels.id, channelId) });
    return (await this.list(userId, ch!.workspaceId)).find((c) => c.id === channelId)!;
  }

  async create(userId: string, workspaceId: string, input: CreateChannelInput): Promise<ChannelDto> {
    const { workspace, role } = await this.access.requireWorkspace(userId, workspaceId, 'workspace.read');
    if (!canInWorkspace(role, 'task.create')) throw forbidden('Viewers cannot create channels.');
    const others = [...new Set(input.memberIds)].filter((m) => m !== userId);
    if (input.private && others.length + 1 > PRIVATE_MEMBER_LIMIT) throw badRequest(`Private channels can have up to ${PRIVATE_MEMBER_LIMIT} members.`);
    for (const m of others) await this.access.assertCanBeAssigned(m, workspaceId, 'memberIds');
    const id = input.id ?? crypto.randomUUID();
    try {
      // No RETURNING: a new private channel isn't visible (RLS) until its first member row exists.
      await this.dbs.db.insert(channels).values({ id, organisationId: workspace.organisationId, workspaceId, kind: input.private ? 'private' : 'public', name: input.name, topic: input.topic, createdById: userId });
    } catch (err) {
      if ((err as { cause?: { code?: string } }).cause?.code === '23505' || (err as { code?: string }).code === '23505') {
        throw conflict('CONFLICT', `#${input.name} already exists in this workspace.`);
      }
      throw err;
    }
    await this.dbs.db.insert(channelMembers).values([
      { channelId: id, organisationId: workspace.organisationId, workspaceId, userId, role: 'admin' },
      ...(input.private ? others.map((u) => ({ channelId: id, organisationId: workspace.organisationId, workspaceId, userId: u })) : []),
    ]);
    return this.dto(userId, id);
  }

  async update(userId: string, channelId: string, input: UpdateChannelInput): Promise<ChannelDto> {
    const { ch, ws, member } = await this.visibleChannel(userId, channelId);
    if (ch.kind === 'dm') throw badRequest('Direct messages cannot be renamed or archived.');
    if (member?.role !== 'admin' && !canInWorkspace(ws.role, 'workspace.manage')) throw forbidden('Only the channel creator or a workspace admin can change this channel.');
    try {
      await this.dbs.db
        .update(channels)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.topic !== undefined ? { topic: input.topic } : {}),
          ...(input.archived !== undefined ? { archivedAt: input.archived ? new Date() : null } : {}),
        })
        .where(eq(channels.id, ch.id));
    } catch (err) {
      if (JSON.stringify(err).includes('23505') || String(err).includes('channels_name_unique')) throw conflict('CONFLICT', `#${input.name} already exists in this workspace.`);
      throw err;
    }
    await this.emit(ch, 'channel.updated', { actorId: userId });
    return this.dto(userId, ch.id);
  }

  async join(userId: string, channelId: string): Promise<ChannelDto> {
    const { ch, member } = await this.visibleChannel(userId, channelId);
    if (ch.kind !== 'public') throw forbidden('Ask a member to add you.');
    if (!member) await this.dbs.db.insert(channelMembers).values({ channelId: ch.id, organisationId: ch.organisationId, workspaceId: ch.workspaceId, userId }).onConflictDoNothing();
    return this.dto(userId, ch.id);
  }

  async leave(userId: string, channelId: string): Promise<void> {
    const { ch, member } = await this.visibleChannel(userId, channelId);
    if (!member) return;
    if (ch.kind === 'dm') throw badRequest('You can’t leave a direct message.');
    await this.dbs.db.delete(channelMembers).where(eq(channelMembers.id, member.id));
  }

  async addMembers(userId: string, channelId: string, userIds: string[]): Promise<ChannelDto> {
    const { ch } = await this.requireMember(userId, channelId);
    if (ch.kind === 'dm') throw badRequest('Start a new direct message to include more people.');
    const current = await this.audience(ch);
    const toAdd = [...new Set(userIds)].filter((u) => !current?.includes(u));
    if (ch.kind === 'private' && (current?.length ?? 0) + toAdd.length > PRIVATE_MEMBER_LIMIT) throw badRequest(`Private channels can have up to ${PRIVATE_MEMBER_LIMIT} members.`);
    for (const u of toAdd) await this.access.assertCanBeAssigned(u, ch.workspaceId, 'userIds');
    if (toAdd.length) {
      await this.dbs.db
        .insert(channelMembers)
        .values(toAdd.map((u) => ({ channelId: ch.id, organisationId: ch.organisationId, workspaceId: ch.workspaceId, userId: u })))
        .onConflictDoNothing();
    }
    await this.emit(ch, 'channel.updated', { actorId: userId });
    return this.dto(userId, ch.id);
  }

  async removeMember(userId: string, channelId: string, targetId: string): Promise<void> {
    if (targetId === userId) return this.leave(userId, channelId);
    const { ch, ws, member } = await this.requireMember(userId, channelId);
    if (ch.kind === 'dm') throw badRequest('People can’t be removed from a direct message.');
    if (member?.role !== 'admin' && !canInWorkspace(ws.role, 'workspace.manage')) throw forbidden();
    const audienceBefore = await this.audience(ch);
    await this.dbs.db.delete(channelMembers).where(and(eq(channelMembers.channelId, ch.id), eq(channelMembers.userId, targetId)));
    if (audienceBefore) {
      const payload = { workspaceId: ch.workspaceId, channelId: ch.id, kind: 'channel.updated', messageId: null, parentId: null, actorId: userId, memberIds: audienceBefore, at: new Date().toISOString() };
      await this.dbs.db.execute(sql`select pg_notify('monty_chat', ${JSON.stringify(payload)})`);
    }
  }

  async members(userId: string, channelId: string) {
    const { ch } = await this.visibleChannel(userId, channelId);
    return this.dbs.db
      .select({ id: users.id, name: users.name, role: channelMembers.role })
      .from(channelMembers)
      .innerJoin(users, eq(users.id, channelMembers.userId))
      .where(eq(channelMembers.channelId, ch.id))
      .orderBy(asc(users.name));
  }

  /** Finds or creates the direct message between the caller and the given people (same workspace). */
  async openDm(userId: string, workspaceId: string, userIds: string[]): Promise<ChannelDto> {
    const { workspace } = await this.access.requireWorkspace(userId, workspaceId, 'workspace.read');
    const people = [...new Set([userId, ...userIds])].sort();
    if (people.length > 8) throw badRequest('Direct messages are limited to 8 people.');
    for (const p of people) if (p !== userId) await this.access.assertCanBeAssigned(p, workspaceId, 'userIds');
    const dmKey = people.join(',');
    const existing = await this.dbs.runAsSystem(() =>
      this.dbs.db.select({ id: channels.id }).from(channels).where(and(eq(channels.workspaceId, workspaceId), eq(channels.kind, 'dm'), eq(channels.dmKey, dmKey))),
    );
    if (existing[0]) return this.dto(userId, existing[0].id);
    const id = crypto.randomUUID();
    await this.dbs.db.insert(channels).values({ id, organisationId: workspace.organisationId, workspaceId, kind: 'dm', dmKey, createdById: userId }).onConflictDoNothing();
    const [winner] = await this.dbs.runAsSystem(() =>
      this.dbs.db.select({ id: channels.id }).from(channels).where(and(eq(channels.workspaceId, workspaceId), eq(channels.kind, 'dm'), eq(channels.dmKey, dmKey))),
    );
    if (winner!.id === id) {
      await this.dbs.db.insert(channelMembers).values(people.map((u) => ({ channelId: id, organisationId: workspace.organisationId, workspaceId, userId: u }))).onConflictDoNothing();
    }
    return this.dto(userId, winner!.id);
  }

  // ---------- messages ----------

  private async toDtos(userId: string, rows: (typeof messages.$inferSelect)[]): Promise<MessageDto[]> {
    const names = await this.names([...new Set(rows.map((r) => r.authorId))]);
    const ids = rows.map((r) => r.id);
    const reacts = ids.length
      ? await this.dbs.db
          .select({ messageId: messageReactions.messageId, emoji: messageReactions.emoji, userId: messageReactions.userId })
          .from(messageReactions)
          .where(inArray(messageReactions.messageId, ids))
      : [];
    return rows.map((m) => {
      const mine = reacts.filter((r) => r.messageId === m.id);
      const byEmoji = new Map<string, { count: number; mine: boolean }>();
      for (const r of mine) {
        const e = byEmoji.get(r.emoji) ?? { count: 0, mine: false };
        e.count += 1;
        if (r.userId === userId) e.mine = true;
        byEmoji.set(r.emoji, e);
      }
      return {
        id: m.id,
        channelId: m.channelId,
        parentId: m.parentId,
        author: { id: m.authorId, name: names.get(m.authorId) ?? 'Someone' },
        body: m.deletedAt ? '' : m.body,
        createdAt: m.createdAt.toISOString(),
        editedAt: m.editedAt?.toISOString() ?? null,
        deleted: !!m.deletedAt,
        replyCount: m.replyCount,
        lastReplyAt: m.lastReplyAt?.toISOString() ?? null,
        reactions: [...byEmoji].map(([emoji, v]) => ({ emoji, ...v })),
      };
    });
  }

  /** Top-level messages, newest page first returned in chronological order. `before` pages backwards. */
  async history(userId: string, channelId: string, before?: string): Promise<{ messages: MessageDto[]; hasMore: boolean }> {
    const { ch } = await this.visibleChannel(userId, channelId);
    const cursor = before ? await this.dbs.db.query.messages.findFirst({ where: and(eq(messages.id, before), eq(messages.channelId, ch.id)) }) : null;
    const rows = await this.dbs.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.channelId, ch.id),
          isNull(messages.parentId),
          cursor ? or(lt(messages.createdAt, cursor.createdAt), and(eq(messages.createdAt, cursor.createdAt), lt(messages.id, cursor.id))) : undefined,
        ),
      )
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(PAGE + 1);
    const page = rows.slice(0, PAGE).reverse();
    return { messages: await this.toDtos(userId, page), hasMore: rows.length > PAGE };
  }

  async thread(userId: string, messageId: string): Promise<{ root: MessageDto; replies: MessageDto[] }> {
    const root = await this.dbs.db.query.messages.findFirst({ where: eq(messages.id, messageId) });
    if (!root) throw notFound('Message');
    await this.visibleChannel(userId, root.channelId);
    if (root.parentId) return this.thread(userId, root.parentId);
    const replies = await this.dbs.db.select().from(messages).where(eq(messages.parentId, root.id)).orderBy(asc(messages.createdAt)).limit(500);
    const [r, ...rest] = await this.toDtos(userId, [root, ...replies]);
    return { root: r!, replies: rest };
  }

  async post(userId: string, channelId: string, input: PostMessageInput): Promise<{ message: MessageDto; created: boolean }> {
    if (input.id) {
      const existing = await this.dbs.db.query.messages.findFirst({ where: eq(messages.id, input.id) });
      if (existing) {
        if (existing.authorId !== userId || existing.channelId !== channelId) throw conflict('CONFLICT', 'This id is already in use');
        return { message: (await this.toDtos(userId, [existing]))[0]!, created: false };
      }
    }
    const { ch } = await this.requireMember(userId, channelId);
    let parent: typeof messages.$inferSelect | undefined;
    if (input.parentId) {
      parent = await this.dbs.db.query.messages.findFirst({ where: and(eq(messages.id, input.parentId), eq(messages.channelId, ch.id)) });
      if (!parent || parent.deletedAt) throw badRequest('That message no longer exists.', [{ path: 'parentId', message: 'Not found' }]);
      if (parent.parentId) parent = await this.dbs.db.query.messages.findFirst({ where: eq(messages.id, parent.parentId) }); // replies stay one level deep
    }
    const [m] = await this.dbs.db
      .insert(messages)
      .values({ id: input.id, channelId: ch.id, organisationId: ch.organisationId, workspaceId: ch.workspaceId, authorId: userId, parentId: parent?.id ?? null, body: input.body })
      .returning();
    if (parent) {
      await this.dbs.db.update(messages).set({ replyCount: sql`${messages.replyCount} + 1`, lastReplyAt: m!.createdAt }).where(eq(messages.id, parent.id));
    }
    // Posting marks the conversation read for the author.
    await this.dbs.db.update(channelMembers).set({ lastReadAt: m!.createdAt }).where(and(eq(channelMembers.channelId, ch.id), eq(channelMembers.userId, userId)));

    // Mentions notify people who can see the channel (members of private channels / DMs only).
    const mentioned = extractMentions(input.body).filter((u) => u !== userId);
    const audience = await this.audience(ch);
    const recipients = audience ? mentioned.filter((u) => audience.includes(u)) : mentioned;
    if (recipients.length) {
      const author = (await this.names([userId])).get(userId);
      await this.collab.notify({
        recipients,
        actorId: userId,
        organisationId: ch.organisationId,
        workspaceId: ch.workspaceId,
        projectId: null,
        type: 'mention',
        entityType: 'message',
        entityId: m!.id,
        data: { workspaceId: ch.workspaceId, channelId: ch.id, channelName: ch.kind === 'dm' ? 'a direct message' : `#${ch.name}`, threadId: parent?.id ?? null, preview: input.body.replace(/<@[0-9a-f-]{36}>/g, '@…').slice(0, 140), authorName: author },
        dedupeKey: `message:${m!.id}`,
      });
    }
    await this.emit(ch, 'message.created', { messageId: m!.id, parentId: parent?.id ?? null, actorId: userId });
    return { message: (await this.toDtos(userId, [m!]))[0]!, created: true };
  }

  async edit(userId: string, messageId: string, body: string): Promise<MessageDto> {
    const m = await this.dbs.db.query.messages.findFirst({ where: eq(messages.id, messageId) });
    if (!m) throw notFound('Message');
    const { ch } = await this.visibleChannel(userId, m.channelId);
    if (m.authorId !== userId) throw forbidden('You can only edit your own messages.');
    if (m.deletedAt) throw conflict('CONFLICT', 'This message was deleted.');
    const [u] = await this.dbs.db.update(messages).set({ body, editedAt: new Date() }).where(eq(messages.id, m.id)).returning();
    await this.emit(ch, 'message.updated', { messageId: m.id, parentId: m.parentId, actorId: userId });
    return (await this.toDtos(userId, [u!]))[0]!;
  }

  async remove(userId: string, messageId: string): Promise<void> {
    const m = await this.dbs.db.query.messages.findFirst({ where: eq(messages.id, messageId) });
    if (!m) throw notFound('Message');
    const { ch, ws, member } = await this.visibleChannel(userId, m.channelId);
    const moderator = member?.role === 'admin' || canInWorkspace(ws.role, 'workspace.manage');
    if (m.authorId !== userId && !moderator) throw forbidden('You can only delete your own messages.');
    if (m.deletedAt) return;
    await this.dbs.db.update(messages).set({ deletedAt: new Date(), body: '' }).where(eq(messages.id, m.id));
    await this.emit(ch, 'message.deleted', { messageId: m.id, parentId: m.parentId, actorId: userId });
  }

  async react(userId: string, messageId: string, emoji: string): Promise<MessageDto> {
    const m = await this.dbs.db.query.messages.findFirst({ where: eq(messages.id, messageId) });
    if (!m || m.deletedAt) throw notFound('Message');
    const { ch } = await this.requireMember(userId, m.channelId);
    const removed = await this.dbs.db
      .delete(messageReactions)
      .where(and(eq(messageReactions.messageId, m.id), eq(messageReactions.userId, userId), eq(messageReactions.emoji, emoji)))
      .returning({ id: messageReactions.id });
    if (!removed.length) {
      await this.dbs.db.insert(messageReactions).values({ messageId: m.id, organisationId: m.organisationId, workspaceId: m.workspaceId, userId, emoji }).onConflictDoNothing();
    }
    await this.emit(ch, 'reaction', { messageId: m.id, parentId: m.parentId, actorId: userId });
    return (await this.toDtos(userId, [m]))[0]!;
  }

  async markRead(userId: string, channelId: string): Promise<void> {
    const { ch, member } = await this.visibleChannel(userId, channelId);
    if (!member) return;
    await this.dbs.db.update(channelMembers).set({ lastReadAt: new Date() }).where(eq(channelMembers.id, member.id));
    await this.emit(ch, 'channel.read', { actorId: userId }, userId);
  }

  /** Unread totals per workspace for the sidebar badge (top-level messages in channels the user belongs to). */
  async unread(userId: string): Promise<ChatUnreadDto[]> {
    const rows = await this.dbs.db.execute<{ workspace_id: string; unread: number; mentions: number }>(sql`
      select me.workspace_id,
        count(m.id) filter (where m.parent_id is null)::int as unread,
        count(m.id) filter (where m.body like ${'%<@' + userId + '>%'})::int as mentions
      from channel_members me
      join channels c on c.id = me.channel_id and c.archived_at is null
      join messages m on m.channel_id = me.channel_id and m.created_at > me.last_read_at and m.deleted_at is null and m.author_id <> ${userId}
      where me.user_id = ${userId}
      group by me.workspace_id`);
    const accessible = new Set(await this.access.accessibleWorkspaceIds(userId));
    return rows.rows.filter((r) => accessible.has(r.workspace_id)).map((r) => ({ workspaceId: r.workspace_id, unread: r.unread, mentions: r.mentions }));
  }

  /** Message search results for the global search (RLS limits to visible channels). */
  async search(userId: string, tsQuery: string, limit = 10) {
    const workspaceIds = await this.access.accessibleWorkspaceIds(userId);
    if (!workspaceIds.length) return [];
    const r = await this.dbs.db.execute<{ id: string; channel_id: string; parent_id: string | null; workspace_id: string; kind: string; name: string | null; snippet: string; created_at: string }>(sql`
      select m.id, m.channel_id, m.parent_id, m.workspace_id, c.kind, c.name,
        ts_headline('simple', m.body, to_tsquery('simple', ${tsQuery}), 'StartSel=[[, StopSel=]], MaxWords=18, MinWords=6') as snippet, m.created_at::text
      from messages m join channels c on c.id = m.channel_id
      where m.search @@ to_tsquery('simple', ${tsQuery}) and m.deleted_at is null
        and m.workspace_id in (${sql.join(workspaceIds.map((w) => sql`${w}::uuid`), sql`, `)})
      order by m.created_at desc limit ${limit}`);
    return r.rows;
  }
}

