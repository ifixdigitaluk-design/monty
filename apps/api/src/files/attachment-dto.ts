import type { attachments } from '@monty/database';
import type { AttachmentDto } from '@monty/validation';

/** Content types that may be shown inline; must match the magic-byte sniffing in FilesService. */
export const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);

export function attachmentDto(r: typeof attachments.$inferSelect): AttachmentDto {
  return {
    id: r.id,
    filename: r.filename,
    contentType: r.contentType,
    sizeBytes: r.sizeBytes,
    inline: INLINE_TYPES.has(r.contentType),
    uploaderId: r.uploaderId,
    createdAt: r.createdAt.toISOString(),
    url: `/api/v1/attachments/${r.id}`,
  };
}
