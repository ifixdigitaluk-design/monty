import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { ApplyProposalInput, ApplyProposalSchema, RequestPlanSchema } from '@monty/validation';
import { Auth, AuthContext } from '../common/auth-context';
import { UuidPipe, ZodPipe } from '../common/pipes';
import { clientOf } from '../tenancy/members.controller';
import { AiService } from './ai.service';

@Controller()
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Get('ai/status')
  status() {
    return { provider: this.ai.provider.id, label: this.ai.provider.label, model: this.ai.provider.model };
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('projects/:projectId/ai/plan')
  async plan(
    @Auth() a: AuthContext,
    @Param('projectId', UuidPipe) projectId: string,
    @Body(new ZodPipe(RequestPlanSchema)) body: { guidance?: string },
    @Req() req: Request,
  ) {
    return { proposal: await this.ai.requestPlan(a.userId, projectId, body.guidance, clientOf(req)) };
  }

  @Get('projects/:projectId/ai/proposals')
  async list(@Auth() a: AuthContext, @Param('projectId', UuidPipe) projectId: string) {
    return { proposals: await this.ai.list(a.userId, projectId) };
  }

  @Post('ai/proposals/:id/apply')
  @HttpCode(200)
  async apply(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(ApplyProposalSchema)) body: ApplyProposalInput, @Req() req: Request) {
    return { proposal: await this.ai.apply(a.userId, id, body.taskIndexes, clientOf(req)) };
  }

  @Post('ai/proposals/:id/reject')
  @HttpCode(204)
  async reject(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string, @Req() req: Request) {
    await this.ai.reject(a.userId, id, clientOf(req));
  }
}
