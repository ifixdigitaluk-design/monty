import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  ConfirmPasswordResetInput,
  ConfirmPasswordResetSchema,
  LoginInput,
  LoginSchema,
  RegisterInput,
  RegisterSchema,
  RequestPasswordResetInput,
  RequestPasswordResetSchema,
  VerifyEmailInput,
  VerifyEmailSchema,
} from '@monty/validation';
import { AccountRecoveryService } from './account-recovery.service';
import { AppConfig, CONFIG, getConfig } from '../config';
import { Auth, AuthContext, Public } from '../common/auth-context';
import { UuidPipe, ZodPipe } from '../common/pipes';
import { AuthService } from './auth.service';

const authThrottle = { default: { limit: () => getConfig().authRateLimit, ttl: 60_000 } };

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly recovery: AccountRecoveryService,
  ) {}

  /** Always 202 with the same body, whether or not the email has an account. */
  @Public()
  @Throttle(authThrottle)
  @Post('password-reset')
  @HttpCode(202)
  async requestReset(@Body(new ZodPipe(RequestPasswordResetSchema)) body: RequestPasswordResetInput, @Req() req: Request) {
    await this.recovery.requestPasswordReset(body, clientInfo(req));
    return { message: 'If an account exists for that email, we have sent a reset link.' };
  }

  @Public()
  @Throttle(authThrottle)
  @Post('password-reset/confirm')
  @HttpCode(204)
  async confirmReset(@Body(new ZodPipe(ConfirmPasswordResetSchema)) body: ConfirmPasswordResetInput, @Req() req: Request) {
    await this.recovery.confirmPasswordReset(body, clientInfo(req));
  }

  @Public()
  @Throttle(authThrottle)
  @Post('verify-email')
  @HttpCode(204)
  async verifyEmail(@Body(new ZodPipe(VerifyEmailSchema)) body: VerifyEmailInput, @Req() req: Request) {
    await this.recovery.verifyEmail(body.token, clientInfo(req));
  }

  @Throttle(authThrottle)
  @Post('verify-email/resend')
  @HttpCode(202)
  async resendVerification(@Auth() auth: AuthContext) {
    return { sent: await this.recovery.sendVerification(auth.userId) };
  }

  @Public()
  @Throttle(authThrottle)
  @Post('register')
  async register(
    @Body(new ZodPipe(RegisterSchema)) body: RegisterInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, token } = await this.auth.register(body, clientInfo(req));
    this.setCookie(res, token);
    return { user };
  }

  @Public()
  @Throttle(authThrottle)
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodPipe(LoginSchema)) body: LoginInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, token } = await this.auth.login(body, clientInfo(req));
    this.setCookie(res, token);
    return { user };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Auth() auth: AuthContext, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.revoke(auth.userId, auth.sessionId, clientInfo(req), 'logout');
    res.clearCookie(this.config.cookieName, { path: '/' });
  }

  @Get('me')
  async me(@Auth() auth: AuthContext) {
    return { user: await this.auth.me(auth.userId) };
  }

  @Get('sessions')
  async sessions(@Auth() auth: AuthContext) {
    return { sessions: await this.auth.listSessions(auth.userId, auth.sessionId) };
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  async revoke(@Auth() auth: AuthContext, @Param('id', UuidPipe) id: string, @Req() req: Request) {
    await this.auth.revoke(auth.userId, id, clientInfo(req));
  }

  private setCookie(res: Response, token: string) {
    res.cookie(this.config.cookieName, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.isProduction,
      path: '/',
      maxAge: this.config.sessionTtlDays * 86400_000,
    });
  }
}

function clientInfo(req: Request) {
  return { userAgent: req.header('user-agent'), ip: req.ip };
}
