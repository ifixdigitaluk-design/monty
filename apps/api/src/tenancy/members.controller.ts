import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Patch, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  CreateInvitationInput,
  CreateInvitationSchema,
  SetWorkspaceMemberInput,
  SetWorkspaceMemberSchema,
  UpdateMemberRoleInput,
  UpdateMemberRoleSchema,
} from '@monty/validation';
import { getConfig } from '../config';
import { Auth, AuthContext, Public } from '../common/auth-context';
import { notFound } from '../common/errors';
import { UuidPipe, ZodPipe } from '../common/pipes';
import { MembersService } from './members.service';

export const clientOf = (req: Request) => ({ ip: req.ip, userAgent: req.header('user-agent') });

const TOKEN = /^[A-Za-z0-9_-]{20,100}$/;
const tokenThrottle = { default: { limit: () => getConfig().authRateLimit, ttl: 60_000 } };

@Controller()
export class MembersController {
  constructor(private readonly members: MembersService) {}

  // ----- organisation members -----
  @Get('organisations/:orgId/members')
  async list(@Auth() auth: AuthContext, @Param('orgId', UuidPipe) orgId: string) {
    return { members: await this.members.listMembers(auth.userId, orgId) };
  }

  @Patch('organisations/:orgId/members/:userId')
  @HttpCode(204)
  async changeRole(
    @Auth() auth: AuthContext,
    @Param('orgId', UuidPipe) orgId: string,
    @Param('userId', UuidPipe) userId: string,
    @Body(new ZodPipe(UpdateMemberRoleSchema)) body: UpdateMemberRoleInput,
    @Req() req: Request,
  ) {
    await this.members.changeRole(auth.userId, orgId, userId, body.role, clientOf(req));
  }

  @Delete('organisations/:orgId/members/:userId')
  @HttpCode(204)
  async remove(
    @Auth() auth: AuthContext,
    @Param('orgId', UuidPipe) orgId: string,
    @Param('userId', UuidPipe) userId: string,
    @Req() req: Request,
  ) {
    await this.members.removeMember(auth.userId, orgId, userId, clientOf(req));
  }

  @Get('organisations/:orgId/audit')
  async audit(@Auth() auth: AuthContext, @Param('orgId', UuidPipe) orgId: string) {
    return { entries: await this.members.auditLog(auth.userId, orgId) };
  }

  // ----- invitations -----
  @Get('organisations/:orgId/invitations')
  async invitations(@Auth() auth: AuthContext, @Param('orgId', UuidPipe) orgId: string) {
    return { invitations: await this.members.listInvitations(auth.userId, orgId) };
  }

  @Post('organisations/:orgId/invitations')
  async invite(
    @Auth() auth: AuthContext,
    @Param('orgId', UuidPipe) orgId: string,
    @Body(new ZodPipe(CreateInvitationSchema)) body: CreateInvitationInput,
    @Req() req: Request,
  ) {
    return { invitation: await this.members.createInvitation(auth.userId, orgId, body, clientOf(req)) };
  }

  @Delete('organisations/:orgId/invitations/:invitationId')
  @HttpCode(204)
  async revoke(
    @Auth() auth: AuthContext,
    @Param('orgId', UuidPipe) orgId: string,
    @Param('invitationId', UuidPipe) invitationId: string,
    @Req() req: Request,
  ) {
    await this.members.revokeInvitation(auth.userId, orgId, invitationId, clientOf(req));
  }

  @Public()
  @Throttle(tokenThrottle)
  @Get('invitations/:token')
  async preview(@Param('token') token: string) {
    if (!TOKEN.test(token)) throw notFound('Invitation');
    return { invitation: await this.members.previewInvitation(token) };
  }

  @Throttle(tokenThrottle)
  @Post('invitations/:token/accept')
  @HttpCode(200)
  async accept(@Auth() auth: AuthContext, @Param('token') token: string, @Req() req: Request) {
    if (!TOKEN.test(token)) throw notFound('Invitation');
    return await this.members.acceptInvitation(auth.userId, token, clientOf(req));
  }

  // ----- workspace access -----
  @Get('workspaces/:workspaceId/members')
  async workspaceMembers(@Auth() auth: AuthContext, @Param('workspaceId', UuidPipe) workspaceId: string) {
    return { members: await this.members.listWorkspaceMembers(auth.userId, workspaceId) };
  }

  @Put('workspaces/:workspaceId/members/:userId')
  @HttpCode(204)
  async setWorkspaceMember(
    @Auth() auth: AuthContext,
    @Param('workspaceId', UuidPipe) workspaceId: string,
    @Param('userId', UuidPipe) userId: string,
    @Body(new ZodPipe(SetWorkspaceMemberSchema)) body: SetWorkspaceMemberInput,
    @Req() req: Request,
  ) {
    await this.members.setWorkspaceMember(auth.userId, workspaceId, userId, body.role, clientOf(req));
  }

  @Delete('workspaces/:workspaceId/members/:userId')
  @HttpCode(204)
  async removeWorkspaceMember(
    @Auth() auth: AuthContext,
    @Param('workspaceId', UuidPipe) workspaceId: string,
    @Param('userId', UuidPipe) userId: string,
    @Req() req: Request,
  ) {
    await this.members.removeWorkspaceMember(auth.userId, workspaceId, userId, clientOf(req));
  }
}
