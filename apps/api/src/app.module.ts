import { Controller, DynamicModule, Get, Module, Res } from '@nestjs/common';
import type { Response } from 'express';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { RequestContextInterceptor } from './db/request-context.interceptor';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { MfaService } from './auth/mfa.service';
import { Public } from './common/auth-context';
import { CsrfGuard, SessionGuard } from './common/guards';
import { AppConfig, CONFIG } from './config';
import { sql } from 'drizzle-orm';
import { DbModule, DbService } from './db/db.service';
import { ProjectsController } from './projects/projects.controller';
import { ProjectsService } from './projects/projects.service';
import { TasksService } from './tasks/tasks.service';
import { AccessService } from './tenancy/access.service';
import { OrganisationsController } from './tenancy/organisations.controller';
import { OrganisationsService } from './tenancy/organisations.service';
import { AuditService } from './audit/audit.service';
import { MembersController } from './tenancy/members.controller';
import { MembersService } from './tenancy/members.service';
import { CollaborationController } from './collaboration/collaboration.controller';
import { CollaborationService } from './collaboration/collaboration.service';
import { InsightsController } from './insights/insights.controller';
import { InsightsService } from './insights/insights.service';
import { DocumentsController } from './documents/documents.controller';
import { DocumentsService } from './documents/documents.service';
import { RealtimeController } from './realtime/realtime.controller';
import { RealtimeService } from './realtime/realtime.service';
import { AiController } from './ai/ai.controller';
import { AiService } from './ai/ai.service';
import { AutomationsController } from './automations/automations.controller';
import { AutomationsService } from './automations/automations.service';
import { DataLifecycleController } from './account/data-lifecycle.controller';
import { DataLifecycleService } from './account/data-lifecycle.service';
import { MetricsController } from './observability/metrics.controller';
import { MaintenanceService } from './maintenance/maintenance.service';
import { EntitlementsService } from './billing/entitlements.service';
import { AccountRecoveryService } from './auth/account-recovery.service';
import { DevMailboxController, MailService } from './mail/mail.service';

@Controller('health')
class HealthController {
  constructor(
    private readonly dbs: DbService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Liveness + database reachability (used by load balancers and the e2e harness). */
  @Public()
  @Get()
  async health() {
    await this.dbs.db.execute(sql`select 1`);
    return { status: 'ok', db: 'ok' };
  }

  /** Readiness: also requires the live-update listener, so an instance without it is taken out of rotation. */
  @Public()
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const started = Date.now();
    let db = 'ok';
    try {
      await this.dbs.db.execute(sql`select 1`);
    } catch {
      db = 'down';
    }
    const { listening } = this.realtime.stats();
    const ok = db === 'ok' && listening;
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'degraded', db, realtime: listening ? 'ok' : 'down', checkMs: Date.now() - started };
  }
}

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [
        ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: config.rateLimit }]),
        DbModule,
      ],
      controllers: [
        HealthController,
        AuthController,
        OrganisationsController,
        ProjectsController,
        MembersController,
        CollaborationController,
        InsightsController,
        DocumentsController,
        RealtimeController,
        AiController,
        AutomationsController,
        DataLifecycleController,
        MetricsController,
        // Development-only mailbox: never registered in production or with a real mail provider.
        ...(!config.isProduction && config.mail.transport === 'log' ? [DevMailboxController] : []),
      ],
      providers: [
        { provide: CONFIG, useValue: config },
        AuthService,
        MfaService,
        AuditService,
        MailService,
        AccountRecoveryService,
        MembersService,
        CollaborationService,
        InsightsService,
        DocumentsService,
        RealtimeService,
        AiService,
        AutomationsService,
        MaintenanceService,
        DataLifecycleService,
        EntitlementsService,
        AccessService,
        OrganisationsService,
        ProjectsService,
        TasksService,
        // Order matters: rate limit → CSRF → session.
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: CsrfGuard },
        { provide: APP_GUARD, useClass: SessionGuard },
        // After guards: authenticated requests run in one RLS-scoped transaction.
        { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
      ],
      exports: [CONFIG],
    };
  }
}
