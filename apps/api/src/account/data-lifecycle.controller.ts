import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  ConfirmAccountDeletionInput,
  ConfirmAccountDeletionSchema,
  DeleteOrganisationInput,
  DeleteOrganisationSchema,
  RenameOrganisationInput,
  RenameOrganisationSchema,
  RequestAccountDeletionSchema,
} from '@monty/validation';
import { Auth, AuthContext } from '../common/auth-context';
import { notFound } from '../common/errors';
import { UuidPipe, ZodPipe } from '../common/pipes';
import { AppConfig, CONFIG, getConfig } from '../config';
import { clientOf } from '../tenancy/members.controller';
import { DataLifecycleService } from './data-lifecycle.service';
import { Inject } from '@nestjs/common';

const sensitive = { default: { limit: () => getConfig().authRateLimit, ttl: 60_000 } };
const TOKEN = /^[A-Za-z0-9_-]{20,100}$/;

@Controller()
export class DataLifecycleController {
  constructor(
    private readonly lifecycle: DataLifecycleService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  // ----- personal data export -----
  @Get('me/exports')
  async exports(@Auth() a: AuthContext) {
    return { exports: await this.lifecycle.listExports(a.userId) };
  }

  @Throttle(sensitive)
  @Post('me/exports')
  async createExport(@Auth() a: AuthContext, @Req() req: Request) {
    return { export: await this.lifecycle.createExport(a.userId, clientOf(req)) };
  }

  @Throttle(sensitive)
  @Get('me/exports/:id/download')
  async download(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string, @Query('token') token: string, @Req() req: Request, @Res() res: Response) {
    if (!token || !TOKEN.test(token)) throw notFound('Export');
    const file = await this.lifecycle.download(a.userId, id, token, clientOf(req));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Cache-Control', 'no-store, private');
    res.send(file.body);
  }

  // ----- account deletion -----
  @Get('me/deletion-blockers')
  async blockers(@Auth() a: AuthContext) {
    return { blockers: await this.lifecycle.deletionBlockers(a.userId) };
  }

  @Throttle(sensitive)
  @Post('me/deletion-request')
  @HttpCode(202)
  async requestDeletion(@Auth() a: AuthContext, @Body(new ZodPipe(RequestAccountDeletionSchema)) body: { password: string }, @Req() req: Request) {
    return this.lifecycle.requestAccountDeletion(a.userId, body.password, clientOf(req));
  }

  @Throttle(sensitive)
  @Post('me/deletion-confirm')
  @HttpCode(200)
  async confirmDeletion(@Auth() a: AuthContext, @Body(new ZodPipe(ConfirmAccountDeletionSchema)) body: ConfirmAccountDeletionInput, @Res({ passthrough: true }) res: Response) {
    const result = await this.lifecycle.confirmAccountDeletion(a.userId, body.token);
    res.clearCookie(this.config.cookieName, { path: '/' });
    return { deleted: true, ...result };
  }

  // ----- organisations -----
  @Get('organisations/pending-deletion')
  async pending(@Auth() a: AuthContext) {
    return { organisations: await this.lifecycle.pendingDeletions(a.userId) };
  }

  @Patch('organisations/:orgId')
  async rename(@Auth() a: AuthContext, @Param('orgId', UuidPipe) orgId: string, @Body(new ZodPipe(RenameOrganisationSchema)) body: RenameOrganisationInput, @Req() req: Request) {
    return { organisation: await this.lifecycle.rename(a.userId, orgId, body.name, clientOf(req)) };
  }

  @Throttle(sensitive)
  @Delete('organisations/:orgId')
  async remove(@Auth() a: AuthContext, @Param('orgId', UuidPipe) orgId: string, @Body(new ZodPipe(DeleteOrganisationSchema)) body: DeleteOrganisationInput, @Req() req: Request) {
    return { organisation: await this.lifecycle.scheduleDeletion(a.userId, orgId, body.confirmName, body.password, clientOf(req)) };
  }

  @Post('organisations/:orgId/restore')
  @HttpCode(204)
  async restore(@Auth() a: AuthContext, @Param('orgId', UuidPipe) orgId: string, @Req() req: Request) {
    await this.lifecycle.restore(a.userId, orgId, clientOf(req));
  }
}
