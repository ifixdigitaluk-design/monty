import { HttpException } from '@nestjs/common';

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'FORBIDDEN'
  | 'CSRF_REJECTED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VERSION_CONFLICT'
  | 'EMAIL_TAKEN'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export class AppException extends HttpException {
  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super({ error: { code, message, ...(details === undefined ? {} : { details }) } }, status);
  }
}

export const notFound = (what = 'Resource') => new AppException(404, 'NOT_FOUND', `${what} not found`);
export const forbidden = (message = 'You do not have permission to do this') =>
  new AppException(403, 'FORBIDDEN', message);
export const unauthenticated = () => new AppException(401, 'UNAUTHENTICATED', 'Please sign in');
export const badRequest = (message: string, details?: unknown) =>
  new AppException(400, 'VALIDATION_FAILED', message, details);
export const conflict = (code: 'CONFLICT' | 'VERSION_CONFLICT' | 'EMAIL_TAKEN', message: string, details?: unknown) =>
  new AppException(409, code, message, details);
