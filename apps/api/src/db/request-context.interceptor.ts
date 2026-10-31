import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { from, lastValueFrom, Observable } from 'rxjs';
import type { AuthedRequest } from '../common/auth-context';
import { DbService } from './db.service';

/**
 * Wraps each authenticated request in a single database transaction carrying the caller's identity,
 * so Postgres row-level security applies to every query the handler runs. A thrown error rolls the
 * whole request back, which also makes multi-step handlers atomic.
 */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  constructor(private readonly dbs: DbService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const userId = req.auth?.userId;
    if (!userId) return next.handle();
    return from(this.dbs.runAsUser(userId, () => lastValueFrom(next.handle(), { defaultValue: undefined })));
  }
}
