import { Controller, Delete, Get, Headers, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Auth, AuthContext } from '../common/auth-context';
import { badRequest } from '../common/errors';
import { UuidPipe } from '../common/pipes';
import { FilesService, TargetType } from './files.service';
import { INLINE_TYPES } from './attachment-dto';

const TARGETS: TargetType[] = ['task', 'document', 'channel'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Upload: POST /attachments?targetType=task|document|channel&targetId=<uuid>
 *   body = the raw file bytes (Content-Type: application/octet-stream), X-Filename = URL-encoded original name.
 */
@Controller()
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('attachments')
  async upload(
    @Auth() a: AuthContext,
    @Query('targetType') targetType: string,
    @Query('targetId') targetId: string,
    @Headers('x-filename') filename: string | undefined,
    @Headers('content-type') contentType: string | undefined,
    @Req() req: Request,
  ) {
    if (!TARGETS.includes(targetType as TargetType) || !UUID.test(targetId ?? '')) throw badRequest('targetType and targetId are required');
    if ((contentType ?? '').split(';')[0]!.trim() !== 'application/octet-stream') throw badRequest('Send the file bytes as application/octet-stream');
    return { attachment: await this.files.upload(a.userId, targetType as TargetType, targetId, filename, req) };
  }

  @Get('tasks/:id/attachments')
  async forTask(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string) {
    return { attachments: await this.files.list(a.userId, 'task', id) };
  }

  @Get('documents/:id/attachments')
  async forDoc(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string) {
    return { attachments: await this.files.list(a.userId, 'document', id) };
  }

  @Get('attachments/:id')
  async download(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string, @Query('inline') inline: string | undefined, @Res() res: Response) {
    const { row, stream } = await this.files.open(a.userId, id);
    const showInline = inline === '1' && INLINE_TYPES.has(row.contentType);
    res.setHeader('Content-Type', row.contentType);
    res.setHeader('Content-Length', String(row.sizeBytes));
    res.setHeader('Content-Disposition', `${showInline ? 'inline' : 'attachment'}; filename="${row.filename.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(row.filename)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Even if a file were rendered, it could not run scripts or load anything.
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('ETag', `"${row.sha256}"`);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  @Delete('attachments/:id')
  @HttpCode(204)
  async remove(@Auth() a: AuthContext, @Param('id', UuidPipe) id: string) {
    await this.files.remove(a.userId, id);
  }
}
