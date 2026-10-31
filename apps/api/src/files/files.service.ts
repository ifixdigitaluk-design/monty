import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { canInWorkspace } from '@monty/domain';
import { attachments } from '@monty/database';
import type { AttachmentDto } from '@monty/validation';
import { AppException, badRequest, forbidden, notFound } from '../common/errors';
import { AppConfig, CONFIG } from '../config';
import { DbService } from '../db/db.service';
import { ChatService } from '../chat/chat.service';
import { DocumentsService } from '../documents/documents.service';
import { AccessService } from '../tenancy/access.service';
import { attachmentDto } from './attachment-dto';

export type TargetType = 'task' | 'document' | 'channel';
type Row = typeof attachments.$inferSelect;
const MAX_PER_TARGET = 100;

/** Types the browser may display inline (thumbnails / previews). Everything else is downloaded, never rendered. */
const INLINE: { type: string; magic: (b: Buffer) => boolean }[] = [
  { type: 'image/png', magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: 'image/jpeg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/gif', magic: (b) => b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a' },
  { type: 'image/webp', magic: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { type: 'application/pdf', magic: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
];

/** Strips paths, control characters and anything that could break a Content-Disposition header. */
export function cleanFilename(raw: string | undefined): string {
  let name = '';
  try {
    name = decodeURIComponent(raw ?? '');
  } catch {
    name = raw ?? '';
  }
  name = Array.from(name.split(/[\\/]/).pop()!)
    .filter((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f && !'"<>|*?:'.includes(ch))
    .join('').replace(/^\.+/, '').trim().slice(0, 200);
  return name || 'file';
}

/**
 * File attachments on tasks, documents and chat messages.
 * - Bytes are streamed to disk with a hard size limit and a SHA-256; names on disk are random (never user input).
 * - The stored content type is derived from the file's bytes: only real PNG/JPEG/GIF/WebP/PDF are ever served
 *   inline; everything else is `application/octet-stream` + `Content-Disposition: attachment`, so an uploaded
 *   HTML or SVG file can never run in Monty's origin.
 * - Who can see a file follows its target (task/document → workspace, chat → channel) via the API and RLS.
 */
@Injectable()
export class FilesService implements OnModuleInit {
  private readonly logger = new Logger('Files');
  private readonly root: string;

  constructor(
    private readonly dbs: DbService,
    private readonly access: AccessService,
    private readonly chat: ChatService,
    private readonly docs: DocumentsService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {
    this.root = path.resolve(config.files.dir);
  }

  async onModuleInit() {
    await mkdir(path.join(this.root, 'tmp'), { recursive: true });
  }

  private pathOf(key: string) {
    return path.join(this.root, key.slice(0, 2), key);
  }

  /** Resolves the target and checks the caller may add files to it. */
  private async writableTarget(userId: string, type: TargetType, id: string) {
    if (type === 'task') {
      const { task } = await this.access.requireTask(userId, id, 'task.update');
      return { organisationId: task.organisationId, workspaceId: task.workspaceId, channelId: null as string | null };
    }
    if (type === 'document') {
      const { doc } = await this.docs.load(userId, id, 'task.update');
      return { organisationId: doc.organisationId, workspaceId: doc.workspaceId, channelId: null };
    }
    const { ch } = await this.chat.requireMember(userId, id);
    return { organisationId: ch.organisationId, workspaceId: ch.workspaceId, channelId: ch.id };
  }

  private async readableTarget(userId: string, row: Row) {
    if (row.targetType === 'task') await this.access.requireTask(userId, row.targetId, 'workspace.read');
    else if (row.targetType === 'document') await this.docs.load(userId, row.targetId, 'workspace.read');
    else if (row.channelId) await this.chat.visibleChannel(userId, row.channelId);
    else throw notFound('File');
  }

  toDto(r: Row): AttachmentDto {
    return attachmentDto(r);
  }

  async upload(userId: string, type: TargetType, targetId: string, rawName: string | undefined, body: Readable): Promise<AttachmentDto> {
    const target = await this.writableTarget(userId, type, targetId);
    const n = (await this.dbs.db.execute<{ n: number }>(sql`select count(*)::int as n from attachments where target_id = ${targetId} and deleted_at is null`)).rows[0]?.n ?? 0;
    if (n >= MAX_PER_TARGET) throw badRequest(`At most ${MAX_PER_TARGET} files per item.`);

    const key = randomBytes(24).toString('hex');
    const tmp = path.join(this.root, 'tmp', key);
    const hash = createHash('sha256');
    let size = 0;
    let head = Buffer.alloc(0);
    const max = this.config.files.maxBytes;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > max) return cb(new AppException(413, 'VALIDATION_FAILED', `Files can be up to ${Math.round(max / 1024 / 1024)} MB.`));
        if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(body, meter, createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
    } catch (err) {
      await rm(tmp, { force: true });
      throw err instanceof AppException ? err : badRequest('The upload was interrupted. Try again.');
    }
    if (size === 0) {
      await rm(tmp, { force: true });
      throw badRequest('The file is empty.');
    }
    const contentType = INLINE.find((i) => i.magic(head))?.type ?? 'application/octet-stream';
    await mkdir(path.dirname(this.pathOf(key)), { recursive: true });
    await rename(tmp, this.pathOf(key));
    try {
      const [row] = await this.dbs.db
        .insert(attachments)
        .values({ ...target, uploaderId: userId, targetType: type, targetId, filename: cleanFilename(rawName), contentType, sizeBytes: size, sha256: hash.digest('hex'), storageKey: key })
        .returning();
      return this.toDto(row!);
    } catch (err) {
      await rm(this.pathOf(key), { force: true });
      throw err;
    }
  }

  async list(userId: string, type: 'task' | 'document', targetId: string): Promise<AttachmentDto[]> {
    if (type === 'task') await this.access.requireTask(userId, targetId, 'workspace.read');
    else await this.docs.load(userId, targetId, 'workspace.read');
    const rows = await this.dbs.db
      .select()
      .from(attachments)
      .where(and(eq(attachments.targetType, type), eq(attachments.targetId, targetId), isNull(attachments.deletedAt)))
      .orderBy(attachments.createdAt);
    return rows.map((r) => this.toDto(r));
  }

  /** Attachments of chat messages, keyed by message id (RLS already limits to visible channels). */
  async forMessages(ids: string[]): Promise<Map<string, AttachmentDto[]>> {
    const out = new Map<string, AttachmentDto[]>();
    if (!ids.length) return out;
    const rows = await this.dbs.db
      .select()
      .from(attachments)
      .where(and(eq(attachments.targetType, 'message'), inArray(attachments.targetId, ids), isNull(attachments.deletedAt)));
    for (const r of rows) out.set(r.targetId, [...(out.get(r.targetId) ?? []), this.toDto(r)]);
    return out;
  }

  /** (Chat links uploads itself in ChatService.post; kept for other callers.) */
  async linkToMessage(userId: string, channelId: string, messageId: string, ids: string[]): Promise<number> {
    if (!ids.length) return 0;
    const res = await this.dbs.db
      .update(attachments)
      .set({ targetType: 'message', targetId: messageId })
      .where(and(inArray(attachments.id, ids), eq(attachments.uploaderId, userId), eq(attachments.targetType, 'channel'), eq(attachments.targetId, channelId), isNull(attachments.deletedAt)))
      .returning({ id: attachments.id });
    if (res.length !== new Set(ids).size) throw badRequest('Some files are no longer available. Upload them again.');
    return res.length;
  }

  async open(userId: string, id: string): Promise<{ row: Row; stream: Readable }> {
    const row = await this.dbs.db.query.attachments.findFirst({ where: and(eq(attachments.id, id), isNull(attachments.deletedAt)) });
    if (!row) throw notFound('File');
    await this.readableTarget(userId, row);
    try {
      await stat(this.pathOf(row.storageKey));
    } catch {
      this.logger.error(JSON.stringify({ msg: 'file_missing', id: row.id }));
      throw notFound('File');
    }
    return { row, stream: createReadStream(this.pathOf(row.storageKey)) };
  }

  async remove(userId: string, id: string): Promise<void> {
    const row = await this.dbs.db.query.attachments.findFirst({ where: and(eq(attachments.id, id), isNull(attachments.deletedAt)) });
    if (!row) throw notFound('File');
    await this.readableTarget(userId, row);
    if (row.uploaderId !== userId) {
      const ws = await this.access.workspaceAccess(userId, row.workspaceId);
      if (!ws || !canInWorkspace(ws.role, 'workspace.manage')) throw forbidden('Only the person who uploaded it or a workspace admin can delete this file.');
    }
    await this.dbs.db.update(attachments).set({ deletedAt: new Date() }).where(eq(attachments.id, row.id));
  }

  /**
   * Maintenance: erase deleted files (after 1 day), chat uploads never posted (after 1 day), and bytes on disk
   * whose rows are gone (e.g. purged organisations or deleted messages' cascades).
   */
  async purge(): Promise<{ deleted: number; orphans: number }> {
    return this.dbs.runAsSystem(async () => {
      const dead = await this.dbs.db
        .delete(attachments)
        .where(
          sql`(${attachments.deletedAt} < now() - interval '1 day') or (${attachments.targetType} = 'channel' and ${attachments.createdAt} < now() - interval '1 day')`,
        )
        .returning({ key: attachments.storageKey });
      for (const d of dead) await unlink(this.pathOf(d.key)).catch(() => undefined);
      let orphans = 0;
      const known = new Set((await this.dbs.db.select({ k: attachments.storageKey }).from(attachments)).map((r) => r.k));
      for (const dir of await readdir(this.root).catch(() => [] as string[])) {
        if (dir === 'tmp' || dir.length !== 2) continue;
        for (const f of await readdir(path.join(this.root, dir)).catch(() => [] as string[])) {
          if (known.has(f)) continue;
          const p = path.join(this.root, dir, f);
          const st = await stat(p).catch(() => null);
          if (st && Date.now() - st.mtimeMs > 86_400_000) {
            await unlink(p).catch(() => undefined);
            orphans += 1;
          }
        }
      }
      const tmpDir = path.join(this.root, 'tmp');
      for (const f of await readdir(tmpDir).catch(() => [] as string[])) {
        const st = await stat(path.join(tmpDir, f)).catch(() => null);
        if (st && Date.now() - st.mtimeMs > 3_600_000) await unlink(path.join(tmpDir, f)).catch(() => undefined);
      }
      return { deleted: dead.length, orphans };
    });
  }

  /** Total stored bytes (metrics). */
  async totalBytes(): Promise<number> {
    return this.dbs.runAsSystem(async () => {
      const r = await this.dbs.db.execute<{ n: string }>(sql`select coalesce(sum(size_bytes), 0)::text as n from attachments where deleted_at is null`);
      return Number(r.rows[0]?.n ?? 0);
    });
  }
}

