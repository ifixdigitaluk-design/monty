'use client';

import type { WorkspaceMemberDto, WorkspaceRoleValue } from '@monty/validation';
import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { ORG_ROLE_LABEL, WS_ROLE_LABEL } from '@/lib/labels';
import { Badge, Button, ErrorBanner, Modal, PageLoading, Select, useToast } from './ui';

/** Lets workspace admins grant, change and remove access for members of the organisation. */
export function WorkspaceAccess({ workspaceId, open, onClose }: { workspaceId: string; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [members, setMembers] = useState<WorkspaceMemberDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMembers((await api.members.workspace(workspaceId)).members);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [workspaceId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function set(m: WorkspaceMemberDto, role: WorkspaceRoleValue | '') {
    try {
      if (role === '') await api.members.removeFromWorkspace(workspaceId, m.id);
      else await api.members.setWorkspaceRole(workspaceId, m.id, role);
      void load();
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Workspace access">
      {error ? (
        <ErrorBanner message={error} />
      ) : !members ? (
        <PageLoading />
      ) : (
        <div className="space-y-3">
          <p className="text-[13px] text-muted">
            Organisation owners and admins can always access every workspace. Invite new people from the organisation’s Members &amp; settings page.
          </p>
          <ul className="max-h-[50vh] divide-y divide-line overflow-y-auto rounded-lg border border-line">
            {members.map((m) => {
              const implicit = m.orgRole === 'OWNER' || m.orgRole === 'ADMIN';
              return (
                <li key={m.id} className="flex items-center gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{m.name}</p>
                    <p className="truncate text-[12px] text-muted">
                      {ORG_ROLE_LABEL[m.orgRole]} in organisation
                      {m.orgRole === 'GUEST' ? ' · guests are limited to Member' : ''}
                    </p>
                  </div>
                  {implicit ? (
                    <Badge tone="accent">Admin (via organisation)</Badge>
                  ) : (
                    <Select aria-label={`Workspace access for ${m.name}`} value={m.workspaceRole ?? ''} onChange={(e) => void set(m, e.target.value as WorkspaceRoleValue | '')}>
                      <option value="">No access</option>
                      {(['ADMIN', 'MEMBER', 'VIEWER'] as const).map((r) => (
                        <option key={r} value={r}>
                          {WS_ROLE_LABEL[r]}
                        </option>
                      ))}
                    </Select>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
