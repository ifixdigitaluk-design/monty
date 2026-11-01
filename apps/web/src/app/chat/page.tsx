'use client';

import type { ChannelDto, MessageDto, WorkspaceMemberDto } from '@monty/validation';
import { REACTION_EMOJI } from '@monty/validation';
import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { renderBody } from '@/components/CommentThread';
import { AttachmentChip } from '@/components/Attachments';
import type { AttachmentDto } from '@monty/validation';
import { Badge, Button, cx, EmptyState, ErrorBanner, Field, Input, Modal, PageLoading, Select, Textarea, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { LiveChatEvent, useLiveEvents } from '@/lib/live';
import { useSession } from '@/lib/session';

export default function ChatPage() {
  return (
    <AppShell>
      <Chat />
    </AppShell>
  );
}

type Member = { id: string; name: string; email: string };

function Chat() {
  const params = useSearchParams();
  const router = useRouter();
  const { organisations, user } = useSession();
  const workspaces = useMemo(
    () => organisations.flatMap((o) => o.workspaces.map((w) => ({ id: w.id, label: o.kind === 'PERSONAL' ? 'Personal' : `${o.name} · ${w.name}`, team: o.kind === 'TEAM' }))),
    [organisations],
  );
  const ws = params.get('ws') ?? workspaces.find((w) => w.team)?.id ?? workspaces[0]?.id ?? null;
  const channelId = params.get('c');
  const threadId = params.get('t');
  const [channels, setChannels] = useState<ChannelDto[] | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<'channel' | 'dm' | null>(null);
  const [tick, setTick] = useState(0); // bumps on live events so the open conversation refetches

  const lastGo = useRef<string | null>(null);
  if (lastGo.current === `/chat?${params.toString()}`) lastGo.current = null; // landed; allow it again later
  const go = useCallback(
    (next: { ws?: string | null; c?: string | null; t?: string | null }) => {
      const q = new URLSearchParams();
      const w = next.ws === undefined ? ws : next.ws;
      const c = next.c === undefined ? channelId : next.c;
      const t = next.t === undefined ? threadId : next.t;
      if (w) q.set('ws', w);
      if (c) q.set('c', c);
      if (t) q.set('t', t);
      const url = `/chat?${q.toString()}`;
      // Don't queue the same replace twice while the URL catches up; a stale repeat can land after
      // the user has already clicked away and pull them back to Chat.
      if (url === lastGo.current) return;
      lastGo.current = url;
      router.replace(url);
    },
    [router, ws, channelId, threadId],
  );

  const loadChannels = useCallback(async () => {
    if (!ws) return;
    try {
      setChannels((await api.chat.channels(ws)).channels);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [ws]);

  useEffect(() => {
    setChannels(null);
    void loadChannels();
    if (ws)
      api.members
        .workspace(ws)
        .then((r) => setMembers((r.members as WorkspaceMemberDto[]).filter((m) => m.effectiveRole).map((m) => ({ id: m.id, name: m.name, email: m.email }))))
        .catch(() => setMembers([]));
  }, [ws, loadChannels]);

  // Open the first channel (or the general one) when none is selected.
  useEffect(() => {
    if (!channels) return;
    // Also move on when the open channel disappears (deleted, or access removed).
    if (channelId && channels.some((c) => c.id === channelId)) return;
    const first = channels.find((c) => c.isMember && c.kind !== 'dm' && !c.archived) ?? channels[0];
    if (first) go({ c: first.id, t: null });
    else if (channelId) go({ c: null, t: null });
  }, [channels, channelId, go]);

  useLiveEvents(ws, null, {
    onChange: () => undefined,
    onReset: () => {
      void loadChannels();
      setTick((t) => t + 1);
    },
    onChat: (e: LiveChatEvent) => {
      void loadChannels();
      if (e.channelId === channelId && e.kind !== 'channel.read') setTick((t) => t + 1);
    },
  });

  if (!ws) return <div className="p-8"><EmptyState title="No workspace" body="Join or create a workspace to start chatting." /></div>;
  if (error) return <div className="p-8"><ErrorBanner message={error} onRetry={loadChannels} /></div>;
  if (!channels) return <PageLoading />;

  const current = channels.find((c) => c.id === channelId) ?? null;
  const rooms = channels.filter((c) => c.kind !== 'dm');
  const dms = channels.filter((c) => c.kind === 'dm');

  return (
    <div className="flex h-[calc(100vh-3rem)] min-h-0 flex-col md:h-screen md:flex-row">
      <h1 className="sr-only">Chat</h1>
      <nav aria-label="Conversations" className={cx('flex-col overflow-y-auto border-b border-line p-3 md:flex md:w-64 md:border-b-0 md:border-r', current ? 'hidden' : 'flex')}>
        {workspaces.length > 1 ? (
          <Field label="Workspace" htmlFor="chat-ws">
            <Select id="chat-ws" value={ws} onChange={(e) => go({ ws: e.target.value, c: null, t: null })}>
              {workspaces.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
            </Select>
          </Field>
        ) : null}
        <div className="mt-3 flex items-center justify-between">
          <h2 className="text-[12px] font-medium uppercase tracking-wide text-muted">Channels</h2>
          <Button variant="ghost" className="h-7 px-2 text-accent" aria-label="New channel" onClick={() => setCreating('channel')}>+ New</Button>
        </div>
        <ul>
          {rooms.map((c) => <ChannelLink key={c.id} c={c} active={c.id === channelId} onOpen={() => go({ c: c.id, t: null })} />)}
          {rooms.length === 0 ? <li className="px-2 text-[13px] text-muted">No channels yet.</li> : null}
        </ul>
        <div className="mt-4 flex items-center justify-between">
          <h2 className="text-[12px] font-medium uppercase tracking-wide text-muted">Direct messages</h2>
          <Button variant="ghost" className="h-7 px-2 text-accent" aria-label="New direct message" onClick={() => setCreating('dm')}>+ New</Button>
        </div>
        <ul>
          {dms.map((c) => <ChannelLink key={c.id} c={c} active={c.id === channelId} onOpen={() => go({ c: c.id, t: null })} />)}
          {dms.length === 0 ? <li className="px-2 text-[13px] text-muted">No direct messages yet.</li> : null}
        </ul>
      </nav>

      {current ? (
        <Conversation
          key={current.id}
          channel={current}
          members={members}
          tick={tick}
          threadId={threadId}
          onOpenThread={(id) => go({ t: id })}
          onCloseThread={() => go({ t: null })}
          onBack={() => go({ c: null, t: null })}
          onChanged={loadChannels}
          meId={user.id}
        />
      ) : (
        <div className="hidden flex-1 items-center justify-center md:flex">
          <EmptyState title="Pick a conversation" body="Or start one with the + buttons." />
        </div>
      )}

      {creating === 'channel' ? (
        <NewChannel workspaceId={ws} members={members.filter((m) => m.id !== user.id)} onClose={() => setCreating(null)} onCreated={(c) => { setCreating(null); setChannels((all) => (all && !all.some((x) => x.id === c.id) ? [...all, c] : all)); void loadChannels(); go({ c: c.id, t: null }); }} />
      ) : null}
      {creating === 'dm' ? (
        <NewDm workspaceId={ws} members={members.filter((m) => m.id !== user.id)} onClose={() => setCreating(null)} onOpened={(c) => { setCreating(null); setChannels((all) => (all && !all.some((x) => x.id === c.id) ? [...all, c] : all)); void loadChannels(); go({ c: c.id, t: null }); }} />
      ) : null}
    </div>
  );
}

function ChannelLink({ c, active, onOpen }: { c: ChannelDto; active: boolean; onOpen: () => void }) {
  const label = c.kind === 'dm' ? c.name : `${c.kind === 'private' ? '🔒 ' : '# '}${c.name}`;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? 'page' : undefined}
        aria-label={`${c.kind === 'dm' ? 'Direct message with' : c.kind === 'private' ? 'Private channel' : 'Channel'} ${c.name}${c.unread ? `, ${c.unread} unread` : ''}${c.mentions ? `, ${c.mentions} mentions` : ''}`}
        className={cx('flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent', active && 'bg-surface-2', c.unread > 0 && 'font-semibold', c.archived && 'text-muted')}
      >
        <span className="truncate">{label}</span>
        {c.mentions > 0 ? <Badge tone="danger">@{c.mentions}</Badge> : c.unread > 0 ? <Badge tone="accent">{c.unread}</Badge> : null}
      </button>
    </li>
  );
}

function Conversation(props: {
  channel: ChannelDto;
  members: Member[];
  tick: number;
  threadId: string | null;
  meId: string;
  onOpenThread: (id: string) => void;
  onCloseThread: () => void;
  onBack: () => void;
  onChanged: () => void;
}) {
  const { channel, members } = props;
  const toast = useToast();
  const [msgs, setMsgs] = useState<MessageDto[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  const load = useCallback(async () => {
    try {
      const r = await api.chat.messages(channel.id);
      setMsgs((prev) => {
        // Keep older pages the user already loaded.
        if (!prev || prev.length <= r.messages.length) return r.messages;
        const firstNew = r.messages[0]?.id;
        const idx = prev.findIndex((m) => m.id === firstNew);
        return idx > 0 ? [...prev.slice(0, idx), ...r.messages] : r.messages;
      });
      setHasMore((h) => (msgs && msgs.length > r.messages.length ? h : r.hasMore));
      setError(null);
      if (channel.isMember && channel.unread > 0) void api.chat.read(channel.id).then(props.onChanged);
    } catch (err) {
      setError(errorMessage(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id, channel.isMember, channel.unread]);

  useEffect(() => {
    void load();
  }, [load, props.tick]);

  useEffect(() => {
    if (atBottom.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [msgs]);

  async function older() {
    if (!msgs?.length) return;
    const r = await api.chat.messages(channel.id, msgs[0]!.id);
    atBottom.current = false;
    setMsgs([...r.messages, ...msgs]);
    setHasMore(r.hasMore);
  }

  async function join() {
    try {
      await api.chat.join(channel.id);
      props.onChanged();
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
    }
  }

  const title = channel.kind === 'dm' ? channel.name : `${channel.kind === 'private' ? '🔒' : '#'} ${channel.name}`;
  const writable = channel.isMember && !channel.archived;

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <section aria-labelledby="conv-title" className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-line px-4 py-2">
          <Button variant="ghost" className="md:hidden" aria-label="Back to conversations" onClick={props.onBack}>‹</Button>
          <div className="min-w-0 flex-1">
            <h2 id="conv-title" className="truncate font-semibold">{title}</h2>
            {channel.topic ? <p className="truncate text-[12px] text-muted">{channel.topic}</p> : null}
          </div>
          <span className="text-[12px] text-muted">{channel.memberCount} {channel.memberCount === 1 ? 'member' : 'members'}</span>
          {channel.kind !== 'dm' ? <Button onClick={() => setManaging(true)}>Details</Button> : null}
        </header>
        {error ? <div className="p-4"><ErrorBanner message={error} onRetry={load} /></div> : null}
        <div
          ref={logRef}
          role="log"
          aria-label={`Messages in ${channel.name}`}
          aria-live="polite"
          className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {!msgs ? <PageLoading /> : null}
          {hasMore ? <div className="mb-3 text-center"><Button onClick={() => void older()}>Load older messages</Button></div> : null}
          {msgs && msgs.length === 0 ? <p className="text-muted">No messages yet. Say hello 👋</p> : null}
          <ul className="space-y-3">
            {msgs?.map((m) => (
              <MessageItem key={m.id} m={m} members={members} meId={props.meId} canReact={writable} onThread={() => props.onOpenThread(m.id)} onChanged={(u) => setMsgs((all) => all?.map((x) => (x.id === u.id ? u : x)) ?? null)} onDeleted={() => void load()} />
            ))}
          </ul>
        </div>
        {writable ? (
          <Composer channelId={channel.id} members={members} label={`Message ${channel.kind === 'dm' ? channel.name : `#${channel.name}`}`} onSent={(m) => { atBottom.current = true; setMsgs((all) => (all?.some((x) => x.id === m.id) ? all : [...(all ?? []), m])); }} />
        ) : channel.archived ? (
          <p className="border-t border-line px-4 py-3 text-[13px] text-muted">This channel is archived. You can read it but not post.</p>
        ) : (
          <div className="flex items-center justify-between border-t border-line px-4 py-3">
            <span className="text-[13px] text-muted">You’re viewing #{channel.name}.</span>
            <Button variant="primary" onClick={() => void join()}>Join channel</Button>
          </div>
        )}
      </section>
      {props.threadId ? <Thread rootId={props.threadId} members={members} meId={props.meId} writable={writable} tick={props.tick} channelId={channel.id} onClose={props.onCloseThread} /> : null}
      {managing ? <ChannelDetails channel={channel} members={members} onClose={() => setManaging(false)} onChanged={props.onChanged} /> : null}
    </div>
  );
}

function MessageItem(props: { m: MessageDto; members: Member[]; meId: string; canReact: boolean; inThread?: boolean; onThread?: () => void; onChanged: (m: MessageDto) => void; onDeleted: () => void }) {
  const { m } = props;
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.body);
  const mine = m.author.id === props.meId;
  const time = new Date(m.createdAt);

  async function react(emoji: string) {
    try {
      props.onChanged((await api.chat.react(m.id, emoji)).message);
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
    }
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      props.onChanged((await api.chat.edit(m.id, draft.trim())).message);
      setEditing(false);
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
    }
  }
  async function remove() {
    if (!window.confirm('Delete this message?')) return;
    try {
      await api.chat.remove(m.id);
      props.onDeleted();
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
    }
  }

  return (
    <li className="group" data-message={m.id}>
      <p className="text-[13px]">
        <strong>{m.author.name}</strong>{' '}
        <time className="text-[12px] text-muted" dateTime={m.createdAt} title={time.toLocaleString()}>
          {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </time>
        {m.editedAt && !m.deleted ? <span className="text-[12px] text-muted"> (edited)</span> : null}
      </p>
      {m.deleted ? (
        <p className="text-[13px] italic text-muted">This message was deleted.</p>
      ) : editing ? (
        <form onSubmit={save} className="mt-1 space-y-1">
          <Textarea aria-label="Edit message" rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="flex gap-2">
            <Button type="submit" variant="primary">Save</Button>
            <Button type="button" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </form>
      ) : (
        <>
          {m.body ? <p className="whitespace-pre-wrap break-words text-[14px]">{renderBody(m.body, props.members)}</p> : null}
          {m.attachments.length ? (
            <ul className="mt-1 flex flex-wrap gap-2" aria-label="Files">
              {m.attachments.map((a) => <li key={a.id}><AttachmentChip a={a} /></li>)}
            </ul>
          ) : null}
        </>
      )}
      {!m.deleted ? (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {m.reactions.map((r) => (
            <button
              key={r.emoji}
              type="button"
              disabled={!props.canReact}
              onClick={() => void react(r.emoji)}
              aria-pressed={r.mine}
              aria-label={`${r.emoji} ${r.count}${r.mine ? ', including you' : ''}`}
              className={cx('rounded-full border px-2 text-[12px]', r.mine ? 'border-accent bg-accent/10' : 'border-line')}
            >
              {r.emoji} {r.count}
            </button>
          ))}
          {props.canReact ? (
            <details className="relative">
              <summary className="cursor-pointer list-none rounded px-1 text-[12px] text-muted hover:bg-surface-2" aria-label="Add reaction">☺+</summary>
              <div className="absolute z-10 mt-1 flex gap-1 rounded-lg border border-line bg-surface p-1 shadow">
                {REACTION_EMOJI.map((e) => (
                  <button key={e} type="button" className="rounded px-1 hover:bg-surface-2" aria-label={`React with ${e}`} onClick={() => void react(e)}>{e}</button>
                ))}
              </div>
            </details>
          ) : null}
          {!props.inThread && props.onThread ? (
            <button type="button" className="text-[12px] text-accent hover:underline" onClick={props.onThread}>
              {m.replyCount ? `${m.replyCount} ${m.replyCount === 1 ? 'reply' : 'replies'}` : 'Reply in thread'}
            </button>
          ) : null}
          {mine ? <button type="button" className="text-[12px] text-muted hover:underline" onClick={() => { setDraft(m.body); setEditing(true); }}>Edit</button> : null}
          {mine ? <button type="button" className="text-[12px] text-muted hover:underline" onClick={() => void remove()}>Delete</button> : null}
        </div>
      ) : null}
    </li>
  );
}

/** Enter sends, Shift+Enter adds a line. Typing @ offers workspace members; mentions are stored as <@id>. */
function Composer({ channelId, parentId, members, label, onSent }: { channelId: string; parentId?: string; members: Member[]; label: string; onSent: (m: MessageDto) => void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [picked, setPicked] = useState<Map<string, string>>(new Map()); // "@Name" → id
  const [files, setFiles] = useState<AttachmentDto[]>([]);
  const [uploading, setUploading] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function attach(list: FileList | File[]) {
    setUploading(true);
    try {
      for (const f of Array.from(list).slice(0, 10 - files.length)) {
        const a = await api.files.upload('channel', channelId, f);
        setFiles((all) => [...all, a]);
      }
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  const matches = mentionQuery === null ? [] : members.filter((m) => m.name.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 6);

  function onChange(v: string) {
    setText(v);
    const upto = v.slice(0, ref.current?.selectionStart ?? v.length);
    const m = /(?:^|\s)@([\p{L}\p{N}._-]{0,30})$/u.exec(upto);
    setMentionQuery(m ? m[1]! : null);
  }
  function pick(m: Member) {
    const at = text.lastIndexOf('@');
    const label = `@${m.name}`;
    setText(`${text.slice(0, at)}${label} `);
    setPicked(new Map(picked).set(label, m.id));
    setMentionQuery(null);
    ref.current?.focus();
  }
  async function send() {
    let body = text.trim();
    if ((!body && files.length === 0) || busy || uploading) return;
    for (const [label, id] of picked) body = body.split(label).join(`<@${id}>`);
    setBusy(true);
    try {
      const { message } = await api.chat.post(channelId, { id: crypto.randomUUID(), body, attachmentIds: files.map((f) => f.id), ...(parentId ? { parentId } : {}) });
      setText('');
      setPicked(new Map());
      setFiles([]);
      onSent(message);
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }
  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (matches.length && mentionQuery !== null) pick(matches[0]!);
      else void send();
    }
    if (e.key === 'Escape') setMentionQuery(null);
  }

  return (
    <form
      className="relative border-t border-line p-3"
      onSubmit={(e) => { e.preventDefault(); void send(); }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length) void attach(e.dataTransfer.files); }}
      onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); void attach(e.clipboardData.files); } }}
    >
      {matches.length && mentionQuery !== null ? (
        <ul role="listbox" aria-label="Mention someone" className="absolute bottom-full left-3 mb-1 w-64 rounded-lg border border-line bg-surface p-1 shadow">
          {matches.map((m) => (
            <li key={m.id} role="option" aria-selected={false}>
              <button type="button" className="w-full rounded px-2 py-1 text-left hover:bg-surface-2" onClick={() => pick(m)}>{m.name}</button>
            </li>
          ))}
        </ul>
      ) : null}
      {files.length ? (
        <ul className="mb-2 flex flex-wrap gap-2" aria-label="Files to send">
          {files.map((f) => <li key={f.id}><AttachmentChip a={f} onRemove={() => setFiles((all) => all.filter((x) => x.id !== f.id))} /></li>)}
        </ul>
      ) : null}
      <div className="flex items-end gap-2">
        <input ref={fileInput} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => e.target.files && void attach(e.target.files)} />
        <Button type="button" variant="ghost" aria-label="Attach files" busy={uploading} onClick={() => fileInput.current?.click()}>📎</Button>
        <Textarea ref={ref} aria-label={label} placeholder={`${label} — Enter to send, Shift+Enter for a new line`} rows={2} value={text} onChange={(e) => onChange(e.target.value)} onKeyDown={onKey} className="flex-1" />
        <Button type="submit" variant="primary" busy={busy} disabled={(!text.trim() && files.length === 0) || uploading}>Send</Button>
      </div>
    </form>
  );
}

function Thread({ rootId, members, meId, writable, tick, channelId, onClose }: { rootId: string; members: Member[]; meId: string; writable: boolean; tick: number; channelId: string; onClose: () => void }) {
  const [data, setData] = useState<{ root: MessageDto; replies: MessageDto[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await api.chat.thread(rootId));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [rootId]);
  useEffect(() => {
    void load();
  }, [load, tick]);
  const update = (u: MessageDto) => setData((d) => (d ? { root: d.root.id === u.id ? u : d.root, replies: d.replies.map((r) => (r.id === u.id ? u : r)) } : d));
  return (
    <aside aria-label="Thread" className="fixed inset-0 z-20 flex flex-col bg-surface md:static md:w-96 md:border-l md:border-line">
      <header className="flex items-center justify-between border-b border-line px-4 py-2">
        <h2 className="font-semibold">Thread</h2>
        <Button variant="ghost" aria-label="Close thread" onClick={onClose}>✕</Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" role="log" aria-label="Thread replies" aria-live="polite">
        {error ? <ErrorBanner message={error} onRetry={load} /> : !data ? <PageLoading /> : (
          <ul className="space-y-3">
            <MessageItem m={data.root} members={members} meId={meId} canReact={writable} inThread onChanged={update} onDeleted={() => void load()} />
            <li aria-hidden="true" className="border-t border-line" />
            {data.replies.map((r) => <MessageItem key={r.id} m={r} members={members} meId={meId} canReact={writable} inThread onChanged={update} onDeleted={() => void load()} />)}
          </ul>
        )}
      </div>
      {writable && data ? <Composer channelId={channelId} parentId={data.root.id} members={members} label="Reply" onSent={(m) => setData((d) => (d ? { ...d, replies: [...d.replies.filter((x) => x.id !== m.id), m] } : d))} /> : null}
    </aside>
  );
}

function NewChannel({ workspaceId, members, onClose, onCreated }: { workspaceId: string; members: Member[]; onClose: () => void; onCreated: (c: ChannelDto) => void }) {
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [priv, setPriv] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onCreated((await api.chat.createChannel(workspaceId, { name, topic, private: priv, memberIds: priv ? chosen : [] })).channel);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }
  return (
    <Modal open onClose={onClose} title="New channel">
      <form onSubmit={submit} className="space-y-3">
        <Field label="Name" htmlFor="ch-name" hint="Lower-case, e.g. marketing or release-2026">
          <Input id="ch-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </Field>
        <Field label="Topic (optional)" htmlFor="ch-topic">
          <Input id="ch-topic" value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={250} />
        </Field>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} /> Private — only people you add can see it
        </label>
        {priv ? (
          <fieldset className="max-h-48 overflow-y-auto rounded-lg border border-line p-2">
            <legend className="px-1 text-[13px]">Add people</legend>
            {members.map((m) => (
              <label key={m.id} className="flex items-center gap-2 text-[13px]">
                <input type="checkbox" checked={chosen.includes(m.id)} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, m.id] : c.filter((x) => x !== m.id)))} /> {m.name}
              </label>
            ))}
          </fieldset>
        ) : null}
        {error ? <p role="alert" className="text-danger">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!name.trim()}>Create channel</Button>
        </div>
      </form>
    </Modal>
  );
}

function NewDm({ workspaceId, members, onClose, onOpened }: { workspaceId: string; members: Member[]; onClose: () => void; onOpened: (c: ChannelDto) => void }) {
  const [chosen, setChosen] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      onOpened((await api.chat.openDm(workspaceId, chosen)).channel);
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  const shown = members.filter((m) => m.name.toLowerCase().includes(filter.toLowerCase()));
  return (
    <Modal open onClose={onClose} title="New direct message">
      <form onSubmit={submit} className="space-y-3">
        <Field label="Find people" htmlFor="dm-filter">
          <Input id="dm-filter" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus />
        </Field>
        <fieldset className="max-h-56 overflow-y-auto rounded-lg border border-line p-2">
          <legend className="px-1 text-[13px]">People (up to 7)</legend>
          {shown.length === 0 ? <p className="text-[13px] text-muted">No one else in this workspace yet.</p> : null}
          {shown.map((m) => (
            <label key={m.id} className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={chosen.includes(m.id)} disabled={!chosen.includes(m.id) && chosen.length >= 7} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, m.id] : c.filter((x) => x !== m.id)))} /> {m.name}
            </label>
          ))}
        </fieldset>
        {error ? <p role="alert" className="text-danger">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={chosen.length === 0}>Open conversation</Button>
        </div>
      </form>
    </Modal>
  );
}

function ChannelDetails({ channel, members, onClose, onChanged }: { channel: ChannelDto; members: Member[]; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [list, setList] = useState<{ id: string; name: string; role: string }[] | null>(null);
  const [topic, setTopic] = useState(channel.topic);
  const [name, setName] = useState(channel.name);
  const [add, setAdd] = useState('');
  const load = useCallback(async () => setList((await api.chat.members(channel.id)).members), [channel.id]);
  useEffect(() => {
    void load();
  }, [load]);
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      if (done) toast({ tone: 'success', message: done });
      onChanged();
      await load();
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
    }
  };
  const notIn = members.filter((m) => !list?.some((x) => x.id === m.id));
  return (
    <Modal open onClose={onClose} title={`#${channel.name}`}>
      <div className="space-y-4">
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.chat.updateChannel(channel.id, { ...(name.trim() && name !== channel.name ? { name } : {}), topic }), 'Channel saved');
          }}
        >
          {channel.canManage ? (
            <Field label="Channel name" htmlFor="det-name">
              <Input id="det-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            </Field>
          ) : null}
          <Field label="Topic" htmlFor="det-topic">
            <Input id="det-topic" value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={250} />
          </Field>
          <Button type="submit">Save</Button>
        </form>
        <section aria-labelledby="det-members">
          <h3 id="det-members" className="font-medium">Members ({list?.length ?? '…'})</h3>
          <ul className="max-h-48 overflow-y-auto text-[13px]">
            {list?.map((m) => (
              <li key={m.id} className="flex items-center justify-between py-0.5">
                <span>{m.name} {m.role === 'admin' ? <Badge>admin</Badge> : null}</span>
                {channel.canManage && m.role !== 'admin' ? (
                  <button type="button" className="text-danger hover:underline" onClick={() => void run(() => api.chat.removeMember(channel.id, m.id))}>Remove</button>
                ) : null}
              </li>
            ))}
          </ul>
          {channel.isMember && notIn.length ? (
            <form className="mt-2 flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (add) void run(() => api.chat.addMembers(channel.id, [add]), 'Added'); setAdd(''); }}>
              <Field label="Add someone" htmlFor="det-add">
                <Select id="det-add" value={add} onChange={(e) => setAdd(e.target.value)}>
                  <option value="">Choose…</option>
                  {notIn.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </Select>
              </Field>
              <Button type="submit" disabled={!add}>Add</Button>
            </form>
          ) : null}
        </section>
        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          {channel.isMember ? <Button onClick={() => void run(() => api.chat.leave(channel.id), 'You left the channel').then(onClose)}>Leave channel</Button> : null}
          {channel.canManage ? (
            <>
              <Button onClick={() => void run(() => api.chat.updateChannel(channel.id, { archived: !channel.archived }), channel.archived ? 'Channel restored' : 'Channel archived').then(onClose)}>
                {channel.archived ? 'Unarchive' : 'Archive channel'}
              </Button>
              <Button
                variant="danger"
                className="ml-auto"
                onClick={() => {
                  if (window.prompt(`This deletes #${channel.name} and all its messages for everyone. Type the channel name to confirm:`)?.trim().replace(/^#/, '') !== channel.name) return;
                  void run(() => api.chat.deleteChannel(channel.id), 'Channel deleted').then(onClose);
                }}
              >
                Delete channel
              </Button>
            </>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
