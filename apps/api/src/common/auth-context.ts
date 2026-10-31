import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import { unauthenticated } from './errors';

export interface AuthContext {
  userId: string;
  sessionId: string;
}

export type AuthedRequest = Request & { auth?: AuthContext };

export const IS_PUBLIC = 'monty:isPublic';
/** Marks a route as not requiring a session. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Injects the authenticated user's context. */
export const Auth = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.auth) throw unauthenticated();
  return req.auth;
});
