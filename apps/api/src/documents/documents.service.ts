import { Injectable } from '@nestjs/common';
import { aliasedTable, and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { DbOrTx, Document, documents, documentVersions, isUniqueViolation, projects, users } from '@monty/database';
import type {
  CreateDocumentInput,
  DocumentDto,
  DocumentSummaryDto,
  DocumentVersionDto,
  UpdateDocumentInput,
} from '@monty/validation';
import { badRequest, conflict, notFound } from '../common/errors';
import { DbService } from '../db/db.service';
import { AccessService } from '../tenancy/access.service';

/** Successive saves by the same author within this window update one history entry instead of creating many. */
const VERSION_COALESCE_MS = 10 * 60 * 1000;

@Injectable()
export class DocumentsService {
  constructor(
    private readonly dbs: DbService,
    private readonly access: AccessService,
  ) {}

  async list(userId: string, workspaceId: string, projectId?: string): Promise<DocumentSummaryDto[]> {
    await this.access.requireWorkspace(userId, workspaceId, 'workspace.read');
    const rows = await this.dbs.db
      .select({ id: documents.id, title: documents.title, parentId: documents.parentId, projectId: documents.projectId, updatedAt: documents.updatedAt })
      .from(documents)
      .where(and(eq(documents.workspaceId, workspaceId), isNull(documents.deletedAt), projectId ? eq(documents.projectId, projectId) : undefined))
      .orderBy(asc(documents.title))
      .limit(2000);
    return rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() }));
  }

  async load(userId: string, id: string, action: 'workspace.read' | 'task.update') {
    const doc = await this.dbs.db.query.documents.findFirst({ where: and(eq(documents.id, id), isNull(documents.deletedAt)) });
    if (!doc) throw notFound('Document');
    const access = await this.access.workspaceAccess(userId, doc.workspaceId);
    if (!access) throw notFound('Document');
    if (action !== 'workspace.read') await this.access.requireWorkspace(userId, doc.workspaceId, 'task.update');
    return { doc, role: access.role };
  }

  async get(userId: string, id: string): Promise<DocumentDto> {
    const { doc, role } = await this.load(userId, id, 'workspace.read');
    return this.toDto(doc, role);
  }

  private async validatePlacement(db: DbOrTx, workspaceId: string, docId: string | null, parentId?: string | null, projectId?: string | null) {
    if (projectId) {
      const p = await db.query.projects.findFirst({ where: and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt)) });
      if (!p) throw badRequest('Project must be in the same workspace', [{ path: 'projectId', message: 'Not found in workspace' }]);
    }
    if (parentId) {
      // Walk up from the new parent: it must be in this workspace and must not be the document itself or one of its descendants.
      let cursor: string | null = parentId;
      for (let depth = 0; cursor; depth++) {
        if (cursor === docId) throw badRequest('A page cannot be moved inside itself', [{ path: 'parentId', message: 'Creates a cycle' }]);
        if (depth > 50) throw badRequest('Pages can be nested at most 50 levels deep');
        const row: { workspaceId: string; parentId: string | null } | undefined = await db.query.documents.findFirst({
          where: and(eq(documents.id, cursor), isNull(documents.deletedAt)),
          columns: { workspaceId: true, parentId: true },
        });
        if (!row || row.workspaceId !== workspaceId) throw badRequest('Parent page must be in the same workspace', [{ path: 'parentId', message: 'Not found' }]);
        cursor = row.parentId;
      }
    }
  }

  async create(userId: string, workspaceId: string, input: CreateDocumentInput): Promise<{ document: DocumentDto; created: boolean }> {
    const { workspace, role } = await this.access.requireWorkspace(userId, workspaceId, 'task.create');
    if (input.id) {
      const existing = await this.dbs.db.query.documents.findFirst({ where: eq(documents.id, input.id) });
      if (existing) {
        if (existing.createdById !== userId || existing.workspaceId !== workspaceId) throw conflict('CONFLICT', 'This id is already in use');
        return { document: await this.toDto(existing, role), created: false };
      }
    }
    await this.validatePlacement(this.dbs.db, workspaceId, input.id ?? null, input.parentId, input.projectId);
    try {
      const doc = await this.dbs.db.transaction(async (tx) => {
        const [d] = await tx
          .insert(documents)
          .values({
            id: input.id,
            organisationId: workspace.organisationId,
            workspaceId,
            projectId: input.projectId ?? null,
            parentId: input.parentId ?? null,
            title: input.title,
            body: input.body ?? '',
            createdById: userId,
            updatedById: userId,
          })
          .returning();
        await tx.insert(documentVersions).values({
          documentId: d!.id, organisationId: d!.organisationId, workspaceId, version: 1, title: d!.title, body: d!.body, authorId: userId,
        });
        return d!;
      });
      return { document: await this.toDto(doc, role), created: true };
    } catch (err) {
      if (input.id && isUniqueViolation(err)) return this.create(userId, workspaceId, input);
      throw err;
    }
  }

  async update(userId: string, id: string, input: UpdateDocumentInput): Promise<DocumentDto> {
    const { doc, role } = await this.load(userId, id, 'task.update');
    if (input.parentId !== undefined || input.projectId !== undefined) {
      await this.validatePlacement(this.dbs.db, doc.workspaceId, doc.id, input.parentId, input.projectId);
    }
    const { expectedVersion, ...changes } = input;
    const updated = await this.dbs.db.transaction(async (tx) => {
      const [d] = await tx
        .update(documents)
        .set({ ...changes, updatedById: userId, version: sql`${documents.version} + 1` })
        .where(and(eq(documents.id, id), eq(documents.version, expectedVersion), isNull(documents.deletedAt)))
        .returning();
      if (!d) return null;
      if (changes.title !== undefined || changes.body !== undefined) await this.snapshot(tx, d, userId);
      return d;
    });
    if (!updated) {
      const current = await this.dbs.db.query.documents.findFirst({ where: eq(documents.id, id) });
      throw conflict('VERSION_CONFLICT', 'This page was changed by someone else. Reload to see the latest version.', {
        current: current ? await this.toDto(current, role) : null,
      });
    }
    return this.toDto(updated, role);
  }

  /** Records history: coalesces rapid saves by the same author; a new author or a pause starts a new entry. */
  private async snapshot(tx: DbOrTx, d: Document, userId: string) {
    const [latest] = await tx
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.documentId, d.id))
      .orderBy(desc(documentVersions.createdAt))
      .limit(1);
    if (latest && latest.authorId === userId && Date.now() - latest.createdAt.getTime() < VERSION_COALESCE_MS && latest.version > 1) {
      await tx.update(documentVersions).set({ title: d.title, body: d.body, version: d.version }).where(eq(documentVersions.id, latest.id));
    } else {
      await tx.insert(documentVersions).values({
        documentId: d.id, organisationId: d.organisationId, workspaceId: d.workspaceId, version: d.version, title: d.title, body: d.body, authorId: userId,
      });
    }
  }

  async versions(userId: string, id: string): Promise<DocumentVersionDto[]> {
    await this.load(userId, id, 'workspace.read');
    const rows = await this.dbs.db
      .select({ v: documentVersions, authorName: users.name })
      .from(documentVersions)
      .innerJoin(users, eq(users.id, documentVersions.authorId))
      .where(eq(documentVersions.documentId, id))
      .orderBy(desc(documentVersions.createdAt))
      .limit(200);
    return rows.map(({ v, authorName }) => ({
      id: v.id, version: v.version, title: v.title, author: { id: v.authorId, name: authorName },
      createdAt: v.createdAt.toISOString(), updatedAt: v.updatedAt.toISOString(), body: v.body,
    }));
  }

  /** Restoring is itself a new, audited change: history is never rewritten. */
  async restore(userId: string, id: string, versionId: string): Promise<DocumentDto> {
    const { doc, role } = await this.load(userId, id, 'task.update');
    const v = await this.dbs.db.query.documentVersions.findFirst({ where: and(eq(documentVersions.id, versionId), eq(documentVersions.documentId, id)) });
    if (!v) throw notFound('Version');
    const updated = await this.dbs.db.transaction(async (tx) => {
      const [d] = await tx
        .update(documents)
        .set({ title: v.title, body: v.body, updatedById: userId, version: sql`${documents.version} + 1` })
        .where(eq(documents.id, id))
        .returning();
      await tx.insert(documentVersions).values({
        documentId: id, organisationId: doc.organisationId, workspaceId: doc.workspaceId, version: d!.version, title: d!.title, body: d!.body, authorId: userId,
      });
      return d!;
    });
    return this.toDto(updated, role);
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.load(userId, id, 'task.update');
    // Soft-delete the page and all its descendants.
    await this.dbs.db.execute(sql`
      with recursive tree as (
        select id from documents where id = ${id}
        union all
        select d.id from documents d join tree on d.parent_id = tree.id where d.deleted_at is null
      )
      update documents set deleted_at = now() where id in (select id from tree) and deleted_at is null`);
  }

  private async toDto(d: Document, role: 'ADMIN' | 'MEMBER' | 'VIEWER'): Promise<DocumentDto> {
    const creator = aliasedTable(users, 'creator');
    const [names] = await this.dbs.db
      .select({ createdBy: creator.name, updatedBy: users.name })
      .from(users)
      .innerJoin(creator, eq(creator.id, d.createdById))
      .where(eq(users.id, d.updatedById));
    return {
      id: d.id,
      workspaceId: d.workspaceId,
      projectId: d.projectId,
      parentId: d.parentId,
      title: d.title,
      body: d.body,
      version: d.version,
      updatedAt: d.updatedAt.toISOString(),
      createdBy: { id: d.createdById, name: names?.createdBy ?? '' },
      updatedBy: { id: d.updatedById, name: names?.updatedBy ?? '' },
      role,
    };
  }
}
