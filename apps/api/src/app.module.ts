import { Controller, DynamicModule, Get, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
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

@Controller('health')
class HealthController {
  constructor(private readonly dbs: DbService) {}

  @Public()
  @Get()
  async health() {
    await this.dbs.db.execute(sql`select 1`);
    return { status: 'ok', db: 'ok' };
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
      controllers: [HealthController, AuthController, OrganisationsController, ProjectsController, MembersController],
      providers: [
        { provide: CONFIG, useValue: config },
        AuthService,
        AuditService,
        MembersService,
        AccessService,
        OrganisationsService,
        ProjectsService,
        TasksService,
        // Order matters: rate limit → CSRF → session.
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: CsrfGuard },
        { provide: APP_GUARD, useClass: SessionGuard },
      ],
      exports: [CONFIG],
    };
  }
}
