import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { toCsv } from '@monty/domain';
import {
  CreateDatabaseInput,
  CreateDatabaseSchema,
  CreateFieldInput,
  CreateFieldSchema,
  CreateRowInput,
  CreateRowSchema,
  CreateViewInput,
  CreateViewSchema,
  ImportRowsInput,
  ImportRowsSchema,
  UpdateDatabaseInput,
  UpdateDatabaseSchema,
  UpdateFieldInput,
  UpdateFieldSchema,
  UpdateRowInput,
  UpdateRowSchema,
  UpdateViewInput,
  UpdateViewSchema,
} from '@monty/validation';
import { Auth, AuthContext } from '../common/auth-context';
import { UuidPipe, ZodPipe } from '../common/pipes';
import { DatabasesService } from './databases.service';

@Controller()
export class DatabasesController {
  constructor(private readonly dbs: DatabasesService) {}

  @Get('workspaces/:workspaceId/databases')
  async list(@Auth() a: AuthContext, @Param('workspaceId', UuidPipe) workspaceId: string) {
    return { databases: await this.dbs.list(a.userId, workspaceId) };
  }

  @Post('workspaces/:workspaceId/databases')
  async create(
    @Auth() a: AuthContext,
    @Param('workspaceId', UuidPipe) workspaceId: string,
    @Body(new ZodPipe(CreateDatabaseSchema)) body: CreateDatabaseInput,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { database, created } = await this.dbs.create(a.userId, workspaceId, body);
    res.status(created ? 201 : 200);
    return { database };
  }

  @Get('databases/:id')
  async get(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string) {
    return { database: await this.dbs.get(a.userId, id) };
  }

  @Patch('databases/:id')
  async update(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(UpdateDatabaseSchema)) body: UpdateDatabaseInput) {
    return { database: await this.dbs.update(a.userId, id, body) };
  }

  @Delete('databases/:id')
  @HttpCode(204)
  async remove(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string) {
    await this.dbs.remove(a.userId, id);
  }

  @Get('databases/:id/export.csv')
  async exportCsv(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string, @Res() res: Response) {
    const { name, header, rows } = await this.dbs.exportRows(a.userId, id);
    const filename = `${name.replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'database'}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Cache-Control', 'private, no-store');
    // BOM so Excel opens UTF-8 correctly.
    res.send(`\ufeff${toCsv([header, ...rows])}`);
  }

  @Post('databases/:id/import')
  @HttpCode(200)
  async importRows(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(ImportRowsSchema)) body: ImportRowsInput) {
    return this.dbs.importRows(a.userId, id, body);
  }

  @Post('databases/:id/fields')
  async createField(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(CreateFieldSchema)) body: CreateFieldInput) {
    return { field: await this.dbs.createField(a.userId, id, body) };
  }

  @Patch('database-fields/:id')
  async updateField(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(UpdateFieldSchema)) body: UpdateFieldInput) {
    return { field: await this.dbs.updateField(a.userId, id, body) };
  }

  @Delete('database-fields/:id')
  @HttpCode(204)
  async removeField(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string) {
    await this.dbs.removeField(a.userId, id);
  }

  @Post('databases/:id/views')
  async createView(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(CreateViewSchema)) body: CreateViewInput) {
    return { view: await this.dbs.createView(a.userId, id, body) };
  }

  @Patch('database-views/:id')
  async updateView(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(UpdateViewSchema)) body: UpdateViewInput) {
    return { view: await this.dbs.updateView(a.userId, id, body) };
  }

  @Delete('database-views/:id')
  @HttpCode(204)
  async removeView(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string) {
    await this.dbs.removeView(a.userId, id);
  }

  @Post('databases/:id/rows')
  async createRow(
    @Auth() a: AuthContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(CreateRowSchema)) body: CreateRowInput,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { row, created } = await this.dbs.createRow(a.userId, id, body);
    res.status(created ? 201 : 200);
    return { row };
  }

  @Get('database-rows/:id')
  async getRow(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string) {
    return { row: await this.dbs.getRow(a.userId, id) };
  }

  @Patch('database-rows/:id')
  async updateRow(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(UpdateRowSchema)) body: UpdateRowInput) {
    return { row: await this.dbs.updateRow(a.userId, id, body) };
  }

  @Delete('database-rows/:id')
  @HttpCode(204)
  async removeRow(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string) {
    await this.dbs.removeRow(a.userId, id);
  }
}
