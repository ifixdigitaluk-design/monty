import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CreateAutomationInput, CreateAutomationSchema, UpdateAutomationInput, UpdateAutomationSchema } from '@monty/validation';
import { Auth, AuthContext } from '../common/auth-context';
import { UuidPipe, ZodPipe } from '../common/pipes';
import { clientOf } from '../tenancy/members.controller';
import { AutomationsService } from './automations.service';

@Controller()
export class AutomationsController {
  constructor(private readonly automations: AutomationsService) {}

  @Get('workspaces/:workspaceId/automations')
  async list(@Auth() a: AuthContext, @Param('workspaceId', UuidPipe) workspaceId: string) {
    return { automations: await this.automations.list(a.userId, workspaceId) };
  }

  @Post('workspaces/:workspaceId/automations')
  async create(
    @Auth() a: AuthContext,
    @Param('workspaceId', UuidPipe) workspaceId: string,
    @Body(new ZodPipe(CreateAutomationSchema)) body: CreateAutomationInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { rule, created } = await this.automations.create(a.userId, workspaceId, body, clientOf(req));
    res.status(created ? 201 : 200);
    return { automation: rule };
  }

  @Patch('automations/:id')
  async update(
    @Auth() a: AuthContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(UpdateAutomationSchema)) body: UpdateAutomationInput,
    @Req() req: Request,
  ) {
    return { automation: await this.automations.update(a.userId, id, body, clientOf(req)) };
  }

  @Delete('automations/:id')
  @HttpCode(204)
  async remove(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string, @Req() req: Request) {
    await this.automations.remove(a.userId, id, clientOf(req));
  }

  @Get('automations/:id/runs')
  async runs(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string) {
    return { runs: await this.automations.runs(a.userId, id) };
  }
}
