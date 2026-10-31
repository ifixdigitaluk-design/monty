'use client';

import { useEffect, useRef, useState } from 'react';

export interface LiveChange {
  id: string;
  at: string;
  workspaceId: string;
  projectId: string | null;
  topic: string;
  entityId: string;
  version: number | null;
  actorId: string | null;
}

export interface LiveChatEvent {
  workspaceId: string;
  channelId: string;
  kind: 'message.created' | 'message.updated' | 'message.deleted' | 'reaction' | 'channel.updated' | 'channel.read';
  messageId: string | null;
  parentId: string | null;
  actorId: string;
  at: string;
}

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'revoked';

/**
 * Subscribes to a workspace's live change stream (Server-Sent Events).
 * The browser reconnects automatically and sends Last-Event-ID, so the server replays missed events;
 * duplicate deliveries are ignored by event id.
 */
export function useLiveEvents(
  workspaceId: string | null,
  projectId: string | null,
  handlers: { onChange: (e: LiveChange) => void; onReset: () => void; onChat?: (e: LiveChatEvent) => void },
) {
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [viewers, setViewers] = useState<{ userId: string; name: string }[]>([]);
  const h = useRef(handlers);
  h.current = handlers;

  useEffect(() => {
    if (!workspaceId || typeof EventSource === 'undefined') return;
    const seen = new Set<string>();
    const es = new EventSource(`/api/v1/workspaces/${workspaceId}/events${projectId ? `?projectId=${projectId}` : ''}`, { withCredentials: true });
    let connectedBefore = false;
    es.addEventListener('ready', () => {
      setStatus('live');
      // After a reconnect, refetch what may have been missed (chat events are not replayed).
      if (connectedBefore) h.current.onReset();
      connectedBefore = true;
    });
    es.addEventListener('change', (msg) => {
      const e = JSON.parse((msg as MessageEvent).data) as LiveChange;
      if (seen.has(e.id)) return;
      seen.add(e.id);
      if (seen.size > 2000) seen.clear();
      h.current.onChange(e);
    });
    es.addEventListener('chat', (msg) => h.current.onChat?.(JSON.parse((msg as MessageEvent).data) as LiveChatEvent));
    es.addEventListener('reset', () => h.current.onReset());
    es.addEventListener('presence', (msg) => setViewers((JSON.parse((msg as MessageEvent).data) as { viewers: { userId: string; name: string }[] }).viewers));
    es.addEventListener('revoked', () => {
      setStatus('revoked');
      es.close();
    });
    es.onerror = () => setStatus((s) => (s === 'revoked' ? s : 'reconnecting'));
    return () => es.close();
  }, [workspaceId, projectId]);

  return { status, viewers };
}
