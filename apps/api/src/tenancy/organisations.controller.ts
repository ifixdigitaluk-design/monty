import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  CreateOrganisationInput,
  CreateOrganisationSchema,
  CreateWorkspaceInput,
  CreateWorkspaceSchema,
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
  async create(@Auth() auth: AuthContext, @Body(new ZodPipe(CreateOrganisationSchema)) body: CreateOrganisationInput) {
    return { organisation: await this.orgs.create(auth.userId, body) };
  }

  @Post(':orgId/workspaces')
  async createWorkspace(
    @Auth() auth: AuthContext,
    @Param('orgId', UuidPipe) orgId: string,
    @Body(new ZodPipe(CreateWorkspaceSchema)) body: CreateWorkspaceInput,
  ) {
    return { workspace: await this.orgs.createWorkspace(auth.userId, orgId, body) };
  }
}
