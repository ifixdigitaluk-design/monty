import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import {
  AddChannelMembersSchema,
  CreateChannelInput,
  CreateChannelSchema,
  EditMessageSchema,
  OpenDmSchema,
  PostMessageInput,
  PostMessageSchema,
  ReactionSchema,
  UpdateChannelInput,
  UpdateChannelSchema,
} from '@monty/validation';
import { Auth, AuthContext } from '../common/auth-context';
import { UuidPipe, ZodPipe } from '../common/pipes';
import { ChatService } from './chat.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller()
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get('workspaces/:workspaceId/channels')
  async list(@Auth() a: AuthContext, @Param('workspaceId', UuidPipe) ws: string) {
    return { channels: await this.chat.list(a.userId, ws) };
  }

  @Post('workspaces/:workspaceId/channels')
  async create(@Auth() a: AuthContext, @Param('workspaceId', UuidPipe) ws: string, @Body(new ZodPipe(CreateChannelSchema)) body: CreateChannelInput) {
    return { channel: await this.chat.create(a.userId, ws, body) };
  }

  @Post('workspaces/:workspaceId/dms')
  @HttpCode(200)
  async dm(@Auth() a: AuthContext, @Param('workspaceId', UuidPipe) ws: string, @Body(new ZodPipe(OpenDmSchema)) body: { userIds: string[] }) {
    return { channel: await this.chat.openDm(a.userId, ws, body.userIds) };
  }

  @Patch('channels/:id')
  async update(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(UpdateChannelSchema)) body: UpdateChannelInput) {
    return { channel: await this.chat.update(a.userId, id, body) };
  }

  @Post('channels/:id/join')
  @HttpCode(200)
  async join(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string) {
    return { channel: await this.chat.join(a.userId, id) };
  }

  @Post('channels/:id/leave')
  @HttpCode(204)
  async leave(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string) {
    await this.chat.leave(a.userId, id);
  }

  @Get('channels/:id/members')
  async members(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string) {
    return { members: await this.chat.members(a.userId, id) };
  }

  @Post('channels/:id/members')
  @HttpCode(200)
  async addMembers(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(AddChannelMembersSchema)) body: { userIds: string[] }) {
    return { channel: await this.chat.addMembers(a.userId, id, body.userIds) };
  }

  @Delete('channels/:id/members/:userId')
  @HttpCode(204)
  async removeMember(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string, @Param('userId', UuidPipe) userId: string) {
    await this.chat.removeMember(a.userId, id, userId);
  }

  @Get('channels/:id/messages')
  async history(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string, @Query('before') before?: string) {
    return this.chat.history(a.userId, id, before && UUID.test(before) ? before : undefined);
  }

  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post('channels/:id/messages')
  async post(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(PostMessageSchema)) body: PostMessageInput, @Res({ passthrough: true }) res: Response) {
    const { message, created } = await this.chat.post(a.userId, id, body);
    res.status(created ? 201 : 200);
    return { message };
  }

  @Post('channels/:id/read')
  @HttpCode(204)
  async read(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string) {
    await this.chat.markRead(a.userId, id);
  }

  @Get('messages/:id/thread')
  async thread(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string) {
    return this.chat.thread(a.userId, id);
  }

  @Patch('messages/:id')
  async edit(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(EditMessageSchema)) body: { body: string }) {
    return { message: await this.chat.edit(a.userId, id, body.body) };
  }

  @Delete('messages/:id')
  @HttpCode(204)
  async remove(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string) {
    await this.chat.remove(a.userId, id);
  }

  @Post('messages/:id/reactions')
  @HttpCode(200)
  async react(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(ReactionSchema)) body: { emoji: string }) {
    return { message: await this.chat.react(a.userId, id, body.emoji) };
  }

  @Get('me/chat/unread')
  async unread(@Auth() a: AuthContext) {
    return { workspaces: await this.chat.unread(a.userId) };
  }
}
