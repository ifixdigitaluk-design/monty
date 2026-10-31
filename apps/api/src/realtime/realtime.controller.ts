import { Controller, Get, Headers, Param, Query, Res, SetMetadata } from '@nestjs/common';
import type { Response } from 'express';
import { Auth, AuthContext } from '../common/auth-context';
import { UuidPipe } from '../common/pipes';
import { DbService } from '../db/db.service';
import { NO_REQUEST_TRANSACTION } from '../db/request-context.interceptor';
import { AccessService } from '../tenancy/access.service';
import { notFound } from '../common/errors';
import { RealtimeService } from './realtime.service';

const UUID = /^[0-9a-f-]{36}$/i;

@Controller()
export class RealtimeController {
  constructor(
    private readonly realtime: RealtimeService,
    private readonly access: AccessService,
    private readonly dbs: DbService,
  ) {}

  /** Long-lived stream: excluded from the per-request transaction (it would otherwise hold a connection open). */
  @SetMetadata(NO_REQUEST_TRANSACTION, true)
  @Get('workspaces/:workspaceId/events')
  async events(
    @Auth() a: AuthContext,
    @Param('workspaceId', UuidPipe) workspaceId: string,
    @Query('projectId') projectId: string | undefined,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Res() res: Response,
  ) {
    const allowed = await this.dbs.runAsUser(a.userId, () => this.access.workspaceAccess(a.userId, workspaceId));
    if (!allowed) throw notFound('Workspace');
    await this.realtime.subscribe({
      userId: a.userId,
      sessionId: a.sessionId,
      workspaceId,
      projectId: projectId && UUID.test(projectId) ? projectId.toLowerCase() : null,
      lastEventId: lastEventId ?? null,
      res,
    });
  }
}
