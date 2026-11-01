import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { MeetingInput, MeetingSchema, UpdateMeetingInput, UpdateMeetingSchema } from '@monty/validation';
import { Auth, AuthContext } from '../common/auth-context';
import { UuidPipe, ZodPipe } from '../common/pipes';
import { AppConfig, CONFIG } from '../config';
import { MeetingsService } from './meetings.service';

const when = (v?: string) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v) : undefined);

@Controller()
export class MeetingsController {
  constructor(
    private readonly meetings: MeetingsService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('workspaces/:ws/meetings')
  async list(@Auth() a: AuthContext, @Param('ws', UuidPipe) ws: string, @Query('from') from?: string, @Query('to') to?: string) {
    return { meetings: await this.meetings.list(a.userId, ws, when(from), when(to)) };
  }
  @Post('workspaces/:ws/meetings')
  async create(@Auth() a: AuthContext, @Param('ws', UuidPipe) ws: string, @Body(new ZodPipe(MeetingSchema)) b: MeetingInput, @Res({ passthrough: true }) res: Response) {
    const { meeting, created } = await this.meetings.create(a.userId, ws, b);
    res.status(created ? 201 : 200);
    return { meeting };
  }
  @Get('meetings/:id')
  async get(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string) {
    return { meeting: await this.meetings.get(a.userId, id) };
  }
  @Patch('meetings/:id')
  async update(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(UpdateMeetingSchema)) b: UpdateMeetingInput) {
    return { meeting: await this.meetings.update(a.userId, id, b) };
  }
  @Delete('meetings/:id')
  @HttpCode(204)
  async remove(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string) {
    await this.meetings.remove(a.userId, id);
  }
  @Get('meetings/:id/ics')
  async ics(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string, @Res() res: Response) {
    const { name, body } = await this.meetings.ics(a.userId, id, this.config.appUrl);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(body);
  }
}
