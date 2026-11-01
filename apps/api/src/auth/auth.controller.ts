import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  ConfirmPasswordResetInput,
  ConfirmPasswordResetSchema,
  LoginInput,
  LoginMfaInput,
  LoginMfaSchema,
  LoginSchema,
  MfaDisableInput,
  MfaDisableSchema,
  MfaEnableSchema,
  MfaSetupSchema,
  RegisterResultDto,
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
import { MfaService } from './mfa.service';
import { GoogleService, GoogleSignInError } from './google.service';

const OIDC_COOKIE = 'monty_oidc';
const OIDC_COOKIE_PATH = '/api/v1/auth/google';

const authThrottle = { default: { limit: () => getConfig().authRateLimit, ttl: 60_000 } };

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly recovery: AccountRecoveryService,
    private readonly mfa: MfaService,
    private readonly google: GoogleService,
  ) {}

  /** Which sign-in methods the server offers (the web app shows buttons accordingly). */
  @Public()
  @Get('providers')
  providers() {
    return { google: this.google.enabled };
  }

  /** Starts "Continue with Google": remembers state/nonce/PKCE in a sealed, short-lived cookie and redirects. */
  @Public()
  @Throttle(authThrottle)
  @Get('google/start')
  async googleStart(@Query('next') next: string | undefined, @Res() res: Response) {
    if (!this.google.enabled) return res.redirect(302, '/login?error=google_failed');
    try {
      const { url, cookie } = await this.google.start(next);
      res.cookie(OIDC_COOKIE, cookie, { httpOnly: true, sameSite: 'lax', secure: this.config.isProduction, path: OIDC_COOKIE_PATH, maxAge: 10 * 60_000 });
      res.setHeader('Cache-Control', 'no-store');
      return res.redirect(302, url);
    } catch (err) {
      this.google.logFailure(err as Error);
      return res.redirect(302, '/login?error=google_failed');
    }
  }

  /** The provider returns here. Success → session cookie and the original destination; failure → sign-in page with a reason. */
  @Public()
  @Throttle(authThrottle)
  @Get('google/callback')
  async googleCallback(
    @Query() query: { code?: string; state?: string; error?: string },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    res.clearCookie(OIDC_COOKIE, { path: OIDC_COOKIE_PATH, httpOnly: true, sameSite: 'lax', secure: this.config.isProduction });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const sealed = (req.cookies as Record<string, string> | undefined)?.[OIDC_COOKIE];
      const result = await this.google.callback(
        { code: typeof query.code === 'string' ? query.code : undefined, state: typeof query.state === 'string' ? query.state : undefined, error: typeof query.error === 'string' ? query.error : undefined },
        sealed,
        clientInfo(req),
      );
      if ('mfaToken' in result) {
        // The challenge only allows entering the second factor (5 minutes, 5 attempts); it is not a session.
        const q = new URLSearchParams({ mfa: result.mfaToken, ...(result.next ? { next: result.next } : {}) });
        return res.redirect(302, `/login?${q.toString()}`);
      }
      this.setCookie(res, result.token);
      return res.redirect(302, result.next ?? '/home');
    } catch (err) {
      this.google.logFailure(err as Error);
      return res.redirect(302, `/login?error=${err instanceof GoogleSignInError ? err.code : 'google_failed'}`);
    }
  }

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
  @HttpCode(200)
  async verifyEmail(@Body(new ZodPipe(VerifyEmailSchema)) body: VerifyEmailInput, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { userId, mfaEnabled } = await this.recovery.verifyEmail(body.token, clientInfo(req));
    // The link proves inbox access, so it also signs the user in — except for accounts protected by a second factor.
    if (mfaEnabled) return { verified: true, signedIn: false };
    const { user, token } = await this.auth.sessionAfterVerification(userId, clientInfo(req));
    this.setCookie(res, token);
    return { verified: true, signedIn: true, user };
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
  @HttpCode(202)
  async register(@Body(new ZodPipe(RegisterSchema)) body: RegisterInput, @Req() req: Request): Promise<RegisterResultDto> {
    await this.auth.register(body, clientInfo(req));
    return { status: 'check_email', message: 'Check your email: we’ve sent you a link to finish signing up.' };
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
    const result = await this.auth.login(body, clientInfo(req));
    if ('mfaToken' in result) return { mfaRequired: true, mfaToken: result.mfaToken };
    this.setCookie(res, result.token);
    return { user: result.user };
  }

  @Public()
  @Throttle(authThrottle)
  @Post('login/mfa')
  @HttpCode(200)
  async loginMfa(@Body(new ZodPipe(LoginMfaSchema)) body: LoginMfaInput, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { user, token } = await this.mfa.completeLogin(body.mfaToken, body.code, body.recoveryCode, clientInfo(req));
    this.setCookie(res, token);
    return { user };
  }

  // ----- two-factor authentication management -----
  @Get('mfa')
  async mfaStatus(@Auth() auth: AuthContext) {
    return this.mfa.status(auth.userId);
  }

  @Throttle(authThrottle)
  @Post('mfa/setup')
  @HttpCode(200)
  async mfaSetup(@Auth() auth: AuthContext, @Body(new ZodPipe(MfaSetupSchema)) body: { password: string }) {
    return this.mfa.setup(auth.userId, body.password);
  }

  @Throttle(authThrottle)
  @Post('mfa/enable')
  @HttpCode(200)
  async mfaEnable(@Auth() auth: AuthContext, @Body(new ZodPipe(MfaEnableSchema)) body: { code: string }, @Req() req: Request) {
    return this.mfa.enable(auth.userId, body.code, clientInfo(req));
  }

  @Throttle(authThrottle)
  @Post('mfa/disable')
  @HttpCode(204)
  async mfaDisable(@Auth() auth: AuthContext, @Body(new ZodPipe(MfaDisableSchema)) body: MfaDisableInput, @Req() req: Request) {
    await this.mfa.disable(auth.userId, body.password, body.code, body.recoveryCode, clientInfo(req));
  }

  @Throttle(authThrottle)
  @Post('mfa/recovery-codes')
  @HttpCode(200)
  async mfaRecovery(@Auth() auth: AuthContext, @Body(new ZodPipe(MfaEnableSchema)) body: { code: string }, @Req() req: Request) {
    return this.mfa.regenerateRecoveryCodes(auth.userId, body.code, clientInfo(req));
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
