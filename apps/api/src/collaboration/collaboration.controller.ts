import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  AddDependencyInput,
  AddDependencySchema,
  CreateCommentInput,
  CreateCommentSchema,
  CreateMilestoneInput,
  CreateMilestoneSchema,
  MarkNotificationsReadInput,
  MarkNotificationsReadSchema,
  UpdateMilestoneInput,
  UpdateMilestoneSchema,
} from '@monty/validation';
import { Auth, AuthContext } from '../common/auth-context';
import { notFound } from '../common/errors';
import { UuidPipe, ZodPipe } from '../common/pipes';
import { CollaborationService } from './collaboration.service';
import { DbService } from '../db/db.service';
import { tasks } from '@monty/database';
import { and, eq, isNull } from 'drizzle-orm';

@Controller()
export class CollaborationController {
  constructor(
    private readonly collab: CollaborationService,
    private readonly dbs: DbService,
  ) {}

  // ----- milestones -----
  @Get('projects/:projectId/milestones')
  async milestones(@Auth() a: AuthContext, @Param('projectId', UuidPipe) projectId: string) {
    return { milestones: await this.collab.listMilestones(a.userId, projectId) };
  }

  @Post('projects/:projectId/milestones')
  async createMilestone(
    @Auth() a: AuthContext,
    @Param('projectId', UuidPipe) projectId: string,
    @Body(new ZodPipe(CreateMilestoneSchema)) body: CreateMilestoneInput,
  ) {
    return { milestone: await this.collab.createMilestone(a.userId, projectId, body) };
  }

  @Patch('milestones/:id')
  async updateMilestone(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(UpdateMilestoneSchema)) body: UpdateMilestoneInput) {
    return { milestone: await this.collab.updateMilestone(a.userId, id, body) };
  }

  @Delete('milestones/:id')
  @HttpCode(204)
  async deleteMilestone(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string) {
    await this.collab.deleteMilestone(a.userId, id);
  }

  // ----- dependencies -----
  @Get('projects/:projectId/dependencies')
  async dependencies(@Auth() a: AuthContext, @Param('projectId', UuidPipe) projectId: string) {
    return { dependencies: await this.collab.listDependencies(a.userId, projectId) };
  }

  @Post('tasks/:taskId/dependencies')
  async addDependency(@Auth() a: AuthContext, @Param('taskId', UuidPipe) taskId: string, @Body(new ZodPipe(AddDependencySchema)) body: AddDependencyInput) {
    return { dependency: await this.collab.addDependency(a.userId, taskId, body.dependsOnTaskId) };
  }

  @Delete('tasks/:taskId/dependencies/:id')
  @HttpCode(204)
  async removeDependency(@Auth() a: AuthContext, @Param('taskId', UuidPipe) taskId: string, @Param('id', UuidPipe) id: string) {
    await this.collab.removeDependency(a.userId, taskId, id);
  }

  // ----- comments -----
  @Get('projects/:projectId/comments')
  async projectComments(@Auth() a: AuthContext, @Param('projectId', UuidPipe) projectId: string) {
    return { comments: await this.collab.listComments(a.userId, projectId, null) };
  }

  @Post('projects/:projectId/comments')
  async postProjectComment(
    @Auth() a: AuthContext,
    @Param('projectId', UuidPipe) projectId: string,
    @Body(new ZodPipe(CreateCommentSchema)) body: CreateCommentInput,
  ) {
    return { comment: await this.collab.createComment(a.userId, projectId, null, body) };
  }

  @Get('tasks/:taskId/comments')
  async taskComments(@Auth() a: AuthContext, @Param('taskId', UuidPipe) taskId: string) {
    const projectId = await this.projectOf(taskId);
    return { comments: await this.collab.listComments(a.userId, projectId, taskId) };
  }

  @Post('tasks/:taskId/comments')
  async postTaskComment(@Auth() a: AuthContext, @Param('taskId', UuidPipe) taskId: string, @Body(new ZodPipe(CreateCommentSchema)) body: CreateCommentInput) {
    const projectId = await this.projectOf(taskId);
    return { comment: await this.collab.createComment(a.userId, projectId, taskId, body) };
  }

  @Delete('comments/:id')
  @HttpCode(204)
  async deleteComment(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string) {
    await this.collab.deleteComment(a.userId, id);
  }

  // ----- notifications -----
  @Get('me/notifications')
  async notifications(@Auth() a: AuthContext, @Query('unread') unread?: string) {
    return this.collab.listNotifications(a.userId, unread === '1' || unread === 'true');
  }

  @Post('me/notifications/read')
  @HttpCode(200)
  async markRead(@Auth() a: AuthContext, @Body(new ZodPipe(MarkNotificationsReadSchema)) body: MarkNotificationsReadInput) {
    return { updated: await this.collab.markRead(a.userId, body.ids) };
  }

  /** Row-level security hides tasks the caller can't see, so an inaccessible task is simply not found. */
  private async projectOf(taskId: string): Promise<string> {
    const [t] = await this.dbs.db.select({ projectId: tasks.projectId }).from(tasks).where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt)));
    if (!t) throw notFound('Task');
    return t.projectId;
  }
}
