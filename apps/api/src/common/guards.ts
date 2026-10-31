import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppConfig, CONFIG } from '../config';
import { AuthService } from '../auth/auth.service';
import { AppException, unauthenticated } from './errors';
import { AuthedRequest, IS_PUBLIC } from './auth-context';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CLIENTS = new Set(['web', 'desktop']);

/**
 * CSRF defence (with SameSite=Lax cookies):
 *  1. State-changing requests must carry `X-Monty-Client`, which a cross-site form cannot set
 *     and a cross-site fetch cannot send without a CORS preflight we never approve.
 *  2. If the browser sends an Origin header it must be on the allow-list.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (SAFE_METHODS.has(req.method)) return true;
    const client = req.header('x-monty-client');
    if (!client || !CLIENTS.has(client)) {
      throw new AppException(403, 'CSRF_REJECTED', 'Missing or invalid client header');
    }
    const origin = req.header('origin');
    if (origin && !this.config.allowedOrigins.includes(origin)) {
      throw new AppException(403, 'CSRF_REJECTED', 'Origin not allowed');
    }
    return true;
  }
}

/** Resolves the session from cookie or bearer token; rejects unauthenticated access to non-public routes. */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = this.extractToken(req);
    if (token) {
      const session = await this.auth.resolveSession(token);
      if (session) req.auth = { userId: session.userId, sessionId: session.id };
    }
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;
    if (!req.auth) throw unauthenticated();
    return true;
  }

  private extractToken(req: AuthedRequest): string | null {
    const header = req.header('authorization');
    if (header?.startsWith('Bearer ')) return header.slice(7).trim() || null;
    const cookies = req.cookies as Record<string, string> | undefined;
    return cookies?.[this.config.cookieName] ?? null;
  }
}
