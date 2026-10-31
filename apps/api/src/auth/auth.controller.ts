import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { LoginInput, LoginSchema, RegisterInput, RegisterSchema } from '@monty/validation';
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
  ) {}

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
  async logout(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    await this.auth.revoke(auth.userId, auth.sessionId);
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
  async revoke(@Auth() auth: AuthContext, @Param('id', UuidPipe) id: string) {
    await this.auth.revoke(auth.userId, id);
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
