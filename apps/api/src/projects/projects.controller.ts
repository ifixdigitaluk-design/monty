import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { todayUtc } from '@monty/domain';
import {
  CreateProjectInput,
  CreateProjectSchema,
  CreateTaskInput,
  CreateTaskSchema,
  TodayQuerySchema,
  UpdateProjectInput,
  UpdateProjectSchema,
  UpdateTaskInput,
  UpdateTaskSchema,
} from '@monty/validation';
import { Auth, AuthContext } from '../common/auth-context';
import { UuidPipe, ZodPipe } from '../common/pipes';
import { TasksService } from '../tasks/tasks.service';
import { ProjectsService } from './projects.service';

@Controller()
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly tasks: TasksService,
  ) {}

  // ----- projects -----
  @Get('workspaces/:workspaceId/projects')
  list(@Auth() auth: AuthContext, @Param('workspaceId', UuidPipe) workspaceId: string) {
    return this.projects.list(auth.userId, workspaceId);
  }

  @Post('workspaces/:workspaceId/projects')
  async create(
    @Auth() auth: AuthContext,
    @Param('workspaceId', UuidPipe) workspaceId: string,
    @Body(new ZodPipe(CreateProjectSchema)) body: CreateProjectInput,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { project, created } = await this.projects.create(auth.userId, workspaceId, body);
    res.status(created ? 201 : 200);
    return { project };
  }

  @Get('projects/:projectId')
  async get(@Auth() auth: AuthContext, @Param('projectId', UuidPipe) projectId: string) {
    return { project: await this.projects.get(auth.userId, projectId) };
  }

  @Patch('projects/:projectId')
  async update(
    @Auth() auth: AuthContext,
    @Param('projectId', UuidPipe) projectId: string,
    @Body(new ZodPipe(UpdateProjectSchema)) body: UpdateProjectInput,
  ) {
    return { project: await this.projects.update(auth.userId, projectId, body) };
  }

  @Delete('projects/:projectId')
  @HttpCode(204)
  async remove(@Auth() auth: AuthContext, @Param('projectId', UuidPipe) projectId: string) {
    await this.projects.remove(auth.userId, projectId);
  }

  @Get('projects/:projectId/readiness')
  async readiness(
    @Auth() auth: AuthContext,
    @Param('projectId', UuidPipe) projectId: string,
    @Query(new ZodPipe(TodayQuerySchema)) query: { today?: string },
  ) {
    return { readiness: await this.projects.readiness(auth.userId, projectId, query.today ?? todayUtc()) };
  }

  @Get('projects/:projectId/activity')
  async activity(@Auth() auth: AuthContext, @Param('projectId', UuidPipe) projectId: string) {
    return { activity: await this.projects.activity(auth.userId, projectId) };
  }

  // ----- tasks -----
  @Get('projects/:projectId/tasks')
  async listTasks(@Auth() auth: AuthContext, @Param('projectId', UuidPipe) projectId: string) {
    return { tasks: await this.tasks.list(auth.userId, projectId) };
  }

  @Post('projects/:projectId/tasks')
  async createTask(
    @Auth() auth: AuthContext,
    @Param('projectId', UuidPipe) projectId: string,
    @Body(new ZodPipe(CreateTaskSchema)) body: CreateTaskInput,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { task, created } = await this.tasks.create(auth.userId, projectId, body);
    res.status(created ? 201 : 200);
    return { task };
  }

  @Patch('tasks/:taskId')
  async updateTask(
    @Auth() auth: AuthContext,
    @Param('taskId', UuidPipe) taskId: string,
    @Body(new ZodPipe(UpdateTaskSchema)) body: UpdateTaskInput,
  ) {
    return { task: await this.tasks.update(auth.userId, taskId, body) };
  }

  @Delete('tasks/:taskId')
  @HttpCode(204)
  async removeTask(@Auth() auth: AuthContext, @Param('taskId', UuidPipe) taskId: string) {
    await this.tasks.remove(auth.userId, taskId);
  }

  @Get('me/tasks')
  async myTasks(@Auth() auth: AuthContext) {
    return { tasks: await this.tasks.mine(auth.userId) };
  }
}
