import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { clientOf } from './members.controller';
import {
  CreateOrganisationInput,
  CreateOrganisationSchema,
  CreateWorkspaceInput,
  CreateWorkspaceSchema,
  DeleteWorkspaceSchema,
  RenameWorkspaceSchema,
} from '@monty/validation';
import { Auth, AuthContext } from '../common/auth-context';
import { UuidPipe, ZodPipe } from '../common/pipes';
import { OrganisationsService } from './organisations.service';

@Controller('organisations')
export class OrganisationsController {
  constructor(private readonly orgs: OrganisationsService) {}

  @Get()
  async list(@Auth() auth: AuthContext) {
    return { organisations: await this.orgs.listForUser(auth.userId) };
  }

  @Post()
  async create(
    @Auth() auth: AuthContext,
    @Body(new ZodPipe(CreateOrganisationSchema)) body: CreateOrganisationInput,
    @Req() req: Request,
  ) {
    return { organisation: await this.orgs.create(auth.userId, body, clientOf(req)) };
  }

  @Post(':orgId/workspaces')
  async createWorkspace(
    @Auth() auth: AuthContext,
    @Param('orgId', UuidPipe) orgId: string,
    @Body(new ZodPipe(CreateWorkspaceSchema)) body: CreateWorkspaceInput,
    @Req() req: Request,
  ) {
    return { workspace: await this.orgs.createWorkspace(auth.userId, orgId, body, clientOf(req)) };
  }
}

/** Rename or delete a workspace (department): organisation owners and admins. */
@Controller('workspaces')
export class WorkspacesController {
  constructor(private readonly orgs: OrganisationsService) {}

  @Patch(':workspaceId')
  async renameWorkspace(@Auth() auth: AuthContext, @Param('workspaceId', UuidPipe) id: string, @Body(new ZodPipe(RenameWorkspaceSchema)) body: { name: string }, @Req() req: Request) {
    return { workspace: await this.orgs.renameWorkspace(auth.userId, id, body.name, clientOf(req)) };
  }

  @Delete(':workspaceId')
  @HttpCode(204)
  async deleteWorkspace(@Auth() auth: AuthContext, @Param('workspaceId', UuidPipe) id: string, @Body(new ZodPipe(DeleteWorkspaceSchema)) body: { confirmName: string }, @Req() req: Request) {
    await this.orgs.deleteWorkspace(auth.userId, id, body.confirmName, clientOf(req));
  }
}
