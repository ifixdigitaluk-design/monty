import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { HR_DOC_CATEGORIES } from '@monty/domain';
import {
  ChecklistInput,
  ChecklistItemInput,
  ChecklistItemSchema,
  ChecklistSchema,
  HrRoleSchema,
  LeaveDecisionInput,
  LeaveDecisionSchema,
  LeaveRequestInput,
  LeaveRequestSchema,
  ReviewInput,
  ReviewSchema,
  UpdateChecklistItemInput,
  UpdateChecklistItemSchema,
  UpdateHrProfileInput,
  UpdateHrProfileSchema,
  UpdateReviewInput,
  UpdateReviewSchema,
} from '@monty/validation';
import { Auth, AuthContext } from '../common/auth-context';
import { badRequest } from '../common/errors';
import { UuidPipe, ZodPipe } from '../common/pipes';
import { INLINE_TYPES } from '../files/attachment-dto';
import { HrService } from './hr.service';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f-]{36}$/i;

@Controller('organisations/:org/hr')
export class HrController {
  constructor(private readonly hr: HrService) {}

  @Get('me')
  me(@Auth() a: AuthContext, @Param('org', UuidPipe) org: string) {
    return this.hr.me(a.userId, org);
  }
  @Get('inbox')
  inbox(@Auth() a: AuthContext, @Param('org', UuidPipe) org: string) {
    return this.hr.inbox(a.userId, org);
  }

  @Get('people')
  async people(@Auth() a: AuthContext, @Param('org', UuidPipe) org: string) {
    return { people: await this.hr.directory(a.userId, org) };
  }
  @Get('people/:userId')
  async profile(@Auth() a: AuthContext, @Param('org', UuidPipe) org: string, @Param('userId', UuidPipe) u: string) {
    return { profile: await this.hr.profile(a.userId, org, u) };
  }
  @Patch('people/:userId')
  async updateProfile(@Auth() a: AuthContext, @Param('org', UuidPipe) org: string, @Param('userId', UuidPipe) u: string, @Body(new ZodPipe(UpdateHrProfileSchema)) b: UpdateHrProfileInput) {
    return { profile: await this.hr.updateProfile(a.userId, org, u, b) };
  }
  @Put('admins')
  @HttpCode(204)
  async setAdmin(@Auth() a: AuthContext, @Param('org', UuidPipe) org: string, @Body(new ZodPipe(HrRoleSchema)) b: { userId: string; hrAdmin: boolean }) {
    await this.hr.setHrAdmin(a.userId, org, b.userId, b.hrAdmin);
  }

  // leave
  @Get('leave')
  async leave(@Auth() a: AuthContext, @Param('org', UuidPipe) org: string, @Query('from') from?: string, @Query('to') to?: string, @Query('userId') userId?: string, @Query('status') status?: string) {
    return {
      leave: await this.hr.leave(a.userId, org, {
        from: from && DATE.test(from) ? from : undefined,
        to: to && DATE.test(to) ? to : undefined,
        userId: userId && UUID.test(userId) ? userId : undefined,
        status: ['pending', 'approved', 'declined', 'cancelled'].includes(status ?? '') ? status : undefined,
      }),
    };
  }
  @Post('leave')
  async requestLeave(@Auth() a: AuthContext, @Param('org', UuidPipe) org: string, @Body(new ZodPipe(LeaveRequestSchema)) b: LeaveRequestInput, @Res({ passthrough: true }) res: Response) {
    const { leave, created } = await this.hr.requestLeave(a.userId, org, b);
    res.status(created ? 201 : 200);
    return { leave };
  }
  @Post('leave/:id/decision')
  @HttpCode(200)
  async decide(@Auth() a: AuthContext, @Param('org', UuidPipe) org: string, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(LeaveDecisionSchema)) b: LeaveDecisionInput) {
    return { leave: await this.hr.decideLeave(a.userId, org, id, b) };
  }
  @Post('leave/:id/cancel')
  @HttpCode(200)
  async cancel(@Auth() a: AuthContext, @Param('org', UuidPipe) org: string, @Param('id', UuidPipe) id: string) {
    return { leave: await this.hr.cancelLeave(a.userId, org, id) };
  }

  // onboarding / offboarding
  @Get('checklists')
  async checklists(@Auth() a: AuthContext, @Param('org', UuidPipe) org: string) {
    return { checklists: await this.hr.checklists(a.userId, org) };
  }
  @Post('checklists')
  async createChecklist(@Auth() a: AuthContext, @Param('org', UuidPipe) org: string, @Body(new ZodPipe(ChecklistSchema)) b: ChecklistInput) {
    return { checklist: await this.hr.createChecklist(a.userId, org, b) };
  }
  @Post('checklists/:id/items')
  async addItem(@Auth() a: AuthContext, @Param('org', UuidPipe) org: string, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(ChecklistItemSchema)) b: ChecklistItemInput) {
    return { checklist: await this.hr.addChecklistItem(a.userId, org, id, b) };
  }
  @Patch('checklist-items/:id')
  async updateItem(@Auth() a: AuthContext, @Param('org', UuidPipe) org: string, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(UpdateChecklistItemSchema)) b: UpdateChecklistItemInput) {
    return { checklist: await this.hr.updateChecklistItem(a.userId, org, id, b) };
  }
  @Delete('checklists/:id')
  @HttpCode(204)
  async removeChecklist(@Auth() a: AuthContext, @Param('org', UuidPipe) org: string, @Param('id', UuidPipe) id: string) {
    await this.hr.removeChecklist(a.userId, org, id);
  }

  // documents
  @Get('people/:userId/documents')
  async documents(@Auth() a: AuthContext, @Param('org', UuidPipe) org: string, @Param('userId', UuidPipe) u: string) {
    return { documents: await this.hr.documents(a.userId, org, u) };
  }
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('people/:userId/documents')
  async upload(
    @Auth() a: AuthContext,
    @Param('org', UuidPipe) org: string,
    @Param('userId', UuidPipe) u: string,
    @Query('category') category: string,
    @Headers('x-filename') filename: string | undefined,
    @Headers('content-type') contentType: string | undefined,
    @Req() req: Request,
  ) {
    if ((contentType ?? '').split(';')[0]!.trim() !== 'application/octet-stream') throw badRequest('Send the file bytes as application/octet-stream');
    const cat = (HR_DOC_CATEGORIES as readonly string[]).includes(category) ? category : 'other';
    return { document: await this.hr.uploadDocument(a.userId, org, u, cat, filename, req) };
  }
  @Get('documents/:id')
  async download(@Auth() a: AuthContext, @Param('org', UuidPipe) org: string, @Param('id', UuidPipe) id: string, @Query('inline') inline: string | undefined, @Res() res: Response) {
    const { doc, bytes } = await this.hr.openDocument(a.userId, org, id);
    const showInline = inline === '1' && INLINE_TYPES.has(doc.contentType);
    res.setHeader('Content-Type', showInline ? doc.contentType : 'application/octet-stream');
    res.setHeader('Content-Disposition', `${showInline ? 'inline' : 'attachment'}; filename="${doc.filename.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(doc.filename)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(bytes);
  }
  @Delete('documents/:id')
  @HttpCode(204)
  async removeDocument(@Auth() a: AuthContext, @Param('org', UuidPipe) org: string, @Param('id', UuidPipe) id: string) {
    await this.hr.removeDocument(a.userId, org, id);
  }

  // reviews
  @Get('reviews')
  async reviews(@Auth() a: AuthContext, @Param('org', UuidPipe) org: string, @Query('userId') userId?: string) {
    return { reviews: await this.hr.reviews(a.userId, org, userId && UUID.test(userId) ? userId : undefined) };
  }
  @Post('reviews')
  async createReview(@Auth() a: AuthContext, @Param('org', UuidPipe) org: string, @Body(new ZodPipe(ReviewSchema)) b: ReviewInput) {
    return { review: await this.hr.createReview(a.userId, org, b) };
  }
  @Patch('reviews/:id')
  async updateReview(@Auth() a: AuthContext, @Param('org', UuidPipe) org: string, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(UpdateReviewSchema)) b: UpdateReviewInput) {
    return { review: await this.hr.updateReview(a.userId, org, id, b) };
  }
  @Delete('reviews/:id')
  @HttpCode(204)
  async removeReview(@Auth() a: AuthContext, @Param('org', UuidPipe) org: string, @Param('id', UuidPipe) id: string) {
    await this.hr.removeReview(a.userId, org, id);
  }
}
