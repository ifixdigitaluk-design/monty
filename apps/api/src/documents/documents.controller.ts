import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CreateDocumentInput, CreateDocumentSchema, UpdateDocumentInput, UpdateDocumentSchema } from '@monty/validation';
import { Auth, AuthContext } from '../common/auth-context';
import { UuidPipe, ZodPipe } from '../common/pipes';
import { DocumentsService } from './documents.service';

const UUID = /^[0-9a-f-]{36}$/i;

@Controller()
export class DocumentsController {
  constructor(private readonly docs: DocumentsService) {}

  @Get('workspaces/:workspaceId/documents')
  async list(@Auth() a: AuthContext, @Param('workspaceId', UuidPipe) workspaceId: string, @Query('projectId') projectId?: string) {
    return { documents: await this.docs.list(a.userId, workspaceId, projectId && UUID.test(projectId) ? projectId : undefined) };
  }

  @Post('workspaces/:workspaceId/documents')
  async create(
    @Auth() a: AuthContext,
    @Param('workspaceId', UuidPipe) workspaceId: string,
    @Body(new ZodPipe(CreateDocumentSchema)) body: CreateDocumentInput,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { document, created } = await this.docs.create(a.userId, workspaceId, body);
    res.status(created ? 201 : 200);
    return { document };
  }

  @Get('documents/:id')
  async get(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string) {
    return { document: await this.docs.get(a.userId, id) };
  }

  @Patch('documents/:id')
  async update(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(UpdateDocumentSchema)) body: UpdateDocumentInput) {
    return { document: await this.docs.update(a.userId, id, body) };
  }

  @Delete('documents/:id')
  @HttpCode(204)
  async remove(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string) {
    await this.docs.remove(a.userId, id);
  }

  @Get('documents/:id/versions')
  async versions(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string) {
    return { versions: await this.docs.versions(a.userId, id) };
  }

  @Post('documents/:id/versions/:versionId/restore')
  @HttpCode(200)
  async restore(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string, @Param('versionId', UuidPipe) versionId: string) {
    return { document: await this.docs.restore(a.userId, id, versionId) };
  }
}
