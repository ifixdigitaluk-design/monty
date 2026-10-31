/**
 * Typed client for the Monty API, shared by web and (Phase 3) desktop.
 * Web uses same-origin cookies; desktop will pass a bearer token.
 */
import type {
  ActivityDto,
  AiProposalDto,
  AttachmentDto,
  ChannelDto,
  ChatUnreadDto,
  CreateChannelInput,
  MessageDto,
  PostMessageInput,
  UpdateChannelInput,
  LoginMfaInput,
  LoginResultDto,
  MfaSetupDto,
  MfaStatusDto,
  RegisterResultDto,
  AutomationRuleDto,
  CreatedDataExportDto,
  DataExportDto,
  DeletionBlockerDto,
  PendingOrganisationDeletionDto,
  AutomationRunDto,
  CreateAutomationInput,
  UpdateAutomationInput,
  CreateDocumentInput,
  DocumentDto,
  DocumentSummaryDto,
  DocumentVersionDto,
  UpdateDocumentInput,
  CalendarEntryDto,
  HomeDto,
  SearchResultDto,
  CommentDto,
  CreateMilestoneInput,
  DependencyDto,
  MilestoneDto,
  NotificationDto,
  UpdateMilestoneInput,
  AuditEntryDto,
  CreatedInvitationDto,
  CreateInvitationInput,
  InvitationDto,
  InvitationPreviewDto,
  OrgMemberDto,
  OrgRoleValue,
  WorkspaceMemberDto,
  WorkspaceRoleValue,
  ApiErrorBody,
  CreateOrganisationInput,
  CreateProjectInput,
  CreateTaskInput,
  CreateWorkspaceInput,
  LoginInput,
  MyTaskDto,
  OrganisationDto,
  ProjectDetailDto,
  ProjectDto,
  ProjectListItemDto,
  RegisterInput,
  SessionDto,
  TaskDto,
  UpdateProjectInput,
  UpdateTaskInput,
  UserDto,
  WorkspaceSummaryDto,
} from '@monty/validation';
import type { ReadinessReport } from '@monty/domain';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  baseUrl?: string;
  client?: 'web' | 'desktop';
  getToken?: () => string | null;
  fetchImpl?: typeof fetch;
}

export function createApiClient(opts: ApiClientOptions = {}) {
  const baseUrl = (opts.baseUrl ?? '') + '/api/v1';
  const fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'X-Monty-Client': opts.client ?? 'web' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const token = opts.getToken?.();
    if (token) headers['Authorization'] = `Bearer ${token}`;

    let res: Response;
    try {
      res = await fetchImpl(baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'include',
      });
    } catch (err) {
      throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server. Check your connection.', err);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : undefined;
    if (!res.ok) {
      const e = (json as ApiErrorBody | undefined)?.error;
      throw new ApiError(res.status, e?.code ?? 'UNKNOWN', e?.message ?? `Request failed (${res.status})`, e?.details);
    }
    return json as T;
  }

  const q = (today?: string) => (today ? `?today=${encodeURIComponent(today)}` : '');

  return {
    auth: {
      register: (input: RegisterInput) => request<RegisterResultDto>('POST', '/auth/register', input),
      login: (input: LoginInput) => request<LoginResultDto>('POST', '/auth/login', input),
      loginMfa: (input: LoginMfaInput) => request<{ user: UserDto }>('POST', '/auth/login/mfa', input),
      mfaStatus: () => request<MfaStatusDto>('GET', '/auth/mfa'),
      mfaSetup: (password: string) => request<MfaSetupDto>('POST', '/auth/mfa/setup', { password }),
      mfaEnable: (code: string) => request<{ recoveryCodes: string[] }>('POST', '/auth/mfa/enable', { code }),
      mfaDisable: (input: { password: string; code?: string; recoveryCode?: string }) => request<void>('POST', '/auth/mfa/disable', input),
      mfaRecoveryCodes: (code: string) => request<{ recoveryCodes: string[] }>('POST', '/auth/mfa/recovery-codes', { code }),
      logout: () => request<void>('POST', '/auth/logout'),
      me: () => request<{ user: UserDto }>('GET', '/auth/me'),
      sessions: () => request<{ sessions: SessionDto[] }>('GET', '/auth/sessions'),
      revokeSession: (id: string) => request<void>('DELETE', `/auth/sessions/${id}`),
      requestPasswordReset: (email: string) => request<{ message: string }>('POST', '/auth/password-reset', { email }),
      confirmPasswordReset: (token: string, password: string) =>
        request<void>('POST', '/auth/password-reset/confirm', { token, password }),
      verifyEmail: (token: string) => request<{ verified: true; signedIn: boolean; user?: UserDto }>('POST', '/auth/verify-email', { token }),
      resendVerification: () => request<{ sent: boolean }>('POST', '/auth/verify-email/resend'),
    },
    chat: {
      channels: (workspaceId: string) => request<{ channels: ChannelDto[] }>('GET', `/workspaces/${workspaceId}/channels`),
      createChannel: (workspaceId: string, input: Partial<CreateChannelInput> & { name: string }) =>
        request<{ channel: ChannelDto }>('POST', `/workspaces/${workspaceId}/channels`, input),
      openDm: (workspaceId: string, userIds: string[]) => request<{ channel: ChannelDto }>('POST', `/workspaces/${workspaceId}/dms`, { userIds }),
      updateChannel: (id: string, input: UpdateChannelInput) => request<{ channel: ChannelDto }>('PATCH', `/channels/${id}`, input),
      join: (id: string) => request<{ channel: ChannelDto }>('POST', `/channels/${id}/join`),
      leave: (id: string) => request<void>('POST', `/channels/${id}/leave`),
      members: (id: string) => request<{ members: { id: string; name: string; role: string }[] }>('GET', `/channels/${id}/members`),
      addMembers: (id: string, userIds: string[]) => request<{ channel: ChannelDto }>('POST', `/channels/${id}/members`, { userIds }),
      removeMember: (id: string, userId: string) => request<void>('DELETE', `/channels/${id}/members/${userId}`),
      messages: (id: string, before?: string) =>
        request<{ messages: MessageDto[]; hasMore: boolean }>('GET', `/channels/${id}/messages${before ? `?before=${before}` : ''}`),
      post: (id: string, input: PostMessageInput) => request<{ message: MessageDto }>('POST', `/channels/${id}/messages`, input),
      thread: (messageId: string) => request<{ root: MessageDto; replies: MessageDto[] }>('GET', `/messages/${messageId}/thread`),
      edit: (messageId: string, body: string) => request<{ message: MessageDto }>('PATCH', `/messages/${messageId}`, { body }),
      remove: (messageId: string) => request<void>('DELETE', `/messages/${messageId}`),
      react: (messageId: string, emoji: string) => request<{ message: MessageDto }>('POST', `/messages/${messageId}/reactions`, { emoji }),
      read: (id: string) => request<void>('POST', `/channels/${id}/read`),
      unread: () => request<{ workspaces: ChatUnreadDto[] }>('GET', '/me/chat/unread'),
    },
    files: {
      /** Uploads raw bytes (a browser File/Blob) to a task, document or chat channel. */
      upload: async (targetType: 'task' | 'document' | 'channel', targetId: string, file: Blob & { name?: string }) => {
        let res: Response;
        try {
          res = await fetchImpl(`${baseUrl}/attachments?targetType=${targetType}&targetId=${targetId}`, {
            method: 'POST',
            headers: { 'X-Monty-Client': opts.client ?? 'web', 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name ?? 'file') },
            body: file,
            credentials: 'include',
          });
        } catch (err) {
          throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server. Check your connection.', err);
        }
        const json = (await res.json().catch(() => undefined)) as { attachment?: AttachmentDto } & ApiErrorBody | undefined;
        if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? 'UNKNOWN', json?.error?.message ?? `Upload failed (${res.status})`, json?.error?.details);
        return json!.attachment!;
      },
      forTask: (taskId: string) => request<{ attachments: AttachmentDto[] }>('GET', `/tasks/${taskId}/attachments`),
      forDocument: (docId: string) => request<{ attachments: AttachmentDto[] }>('GET', `/documents/${docId}/attachments`),
      remove: (id: string) => request<void>('DELETE', `/attachments/${id}`),
    },
    account: {
      exports: () => request<{ exports: DataExportDto[] }>('GET', '/me/exports'),
      createExport: () => request<{ export: CreatedDataExportDto }>('POST', '/me/exports'),
      deletionBlockers: () => request<{ blockers: DeletionBlockerDto[] }>('GET', '/me/deletion-blockers'),
      requestDeletion: (password: string) => request<{ emailQueued: boolean }>('POST', '/me/deletion-request', { password }),
      confirmDeletion: (token: string) => request<{ deleted: true; erasedOrganisations: number }>('POST', '/me/deletion-confirm', { token, confirm: 'DELETE' }),
    },
    organisations: {
      list: () => request<{ organisations: OrganisationDto[] }>('GET', '/organisations'),
      rename: (orgId: string, name: string) => request<{ organisation: { id: string; name: string } }>('PATCH', `/organisations/${orgId}`, { name }),
      scheduleDeletion: (orgId: string, confirmName: string, password: string) =>
        request<{ organisation: PendingOrganisationDeletionDto }>('DELETE', `/organisations/${orgId}`, { confirmName, password }),
      pendingDeletion: () => request<{ organisations: PendingOrganisationDeletionDto[] }>('GET', '/organisations/pending-deletion'),
      restore: (orgId: string) => request<void>('POST', `/organisations/${orgId}/restore`),
      create: (input: CreateOrganisationInput) => request<{ organisation: OrganisationDto }>('POST', '/organisations', input),
      createWorkspace: (orgId: string, input: CreateWorkspaceInput) =>
        request<{ workspace: WorkspaceSummaryDto }>('POST', `/organisations/${orgId}/workspaces`, input),
    },
    ai: {
      status: () => request<{ provider: string; label: string; model: string | null }>('GET', '/ai/status'),
      plan: (projectId: string, guidance?: string) =>
        request<{ proposal: AiProposalDto }>('POST', `/projects/${projectId}/ai/plan`, guidance ? { guidance } : {}),
      proposals: (projectId: string) => request<{ proposals: AiProposalDto[] }>('GET', `/projects/${projectId}/ai/proposals`),
      apply: (id: string, taskIndexes: number[]) => request<{ proposal: AiProposalDto }>('POST', `/ai/proposals/${id}/apply`, { taskIndexes }),
      reject: (id: string) => request<void>('POST', `/ai/proposals/${id}/reject`),
    },
    automations: {
      list: (workspaceId: string) => request<{ automations: AutomationRuleDto[] }>('GET', `/workspaces/${workspaceId}/automations`),
      create: (workspaceId: string, input: CreateAutomationInput) =>
        request<{ automation: AutomationRuleDto }>('POST', `/workspaces/${workspaceId}/automations`, input),
      update: (id: string, input: UpdateAutomationInput) => request<{ automation: AutomationRuleDto }>('PATCH', `/automations/${id}`, input),
      remove: (id: string) => request<void>('DELETE', `/automations/${id}`),
      runs: (id: string) => request<{ runs: AutomationRunDto[] }>('GET', `/automations/${id}/runs`),
    },
    usage: (orgId: string) =>
      request<{ plan: string; limits: Record<string, number | null>; usage: Record<string, number> }>('GET', `/organisations/${orgId}/usage`),
    documents: {
      list: (workspaceId: string, projectId?: string) =>
        request<{ documents: DocumentSummaryDto[] }>('GET', `/workspaces/${workspaceId}/documents${projectId ? `?projectId=${projectId}` : ''}`),
      create: (workspaceId: string, input: CreateDocumentInput) =>
        request<{ document: DocumentDto }>('POST', `/workspaces/${workspaceId}/documents`, input),
      get: (id: string) => request<{ document: DocumentDto }>('GET', `/documents/${id}`),
      update: (id: string, input: UpdateDocumentInput) => request<{ document: DocumentDto }>('PATCH', `/documents/${id}`, input),
      remove: (id: string) => request<void>('DELETE', `/documents/${id}`),
      versions: (id: string) => request<{ versions: DocumentVersionDto[] }>('GET', `/documents/${id}/versions`),
      restore: (id: string, versionId: string) => request<{ document: DocumentDto }>('POST', `/documents/${id}/versions/${versionId}/restore`),
    },
    insights: {
      search: (q: string) => request<{ results: SearchResultDto[] }>('GET', `/search?q=${encodeURIComponent(q)}`),
      calendar: (from: string, to: string, mine: boolean) =>
        request<{ entries: CalendarEntryDto[] }>('GET', `/calendar?from=${from}&to=${to}&mine=${mine ? '1' : '0'}`),
      home: (today?: string) => request<HomeDto>('GET', `/me/home${q(today)}`),
    },
    milestones: {
      list: (projectId: string) => request<{ milestones: MilestoneDto[] }>('GET', `/projects/${projectId}/milestones`),
      create: (projectId: string, input: CreateMilestoneInput) =>
        request<{ milestone: MilestoneDto }>('POST', `/projects/${projectId}/milestones`, input),
      update: (id: string, input: UpdateMilestoneInput) => request<{ milestone: MilestoneDto }>('PATCH', `/milestones/${id}`, input),
      remove: (id: string) => request<void>('DELETE', `/milestones/${id}`),
    },
    dependencies: {
      list: (projectId: string) => request<{ dependencies: DependencyDto[] }>('GET', `/projects/${projectId}/dependencies`),
      add: (taskId: string, dependsOnTaskId: string) =>
        request<{ dependency: DependencyDto }>('POST', `/tasks/${taskId}/dependencies`, { dependsOnTaskId }),
      remove: (taskId: string, id: string) => request<void>('DELETE', `/tasks/${taskId}/dependencies/${id}`),
    },
    comments: {
      list: (target: { projectId: string } | { taskId: string }) =>
        request<{ comments: CommentDto[] }>('GET', 'taskId' in target ? `/tasks/${target.taskId}/comments` : `/projects/${target.projectId}/comments`),
      create: (target: { projectId: string } | { taskId: string }, body: string, id?: string) =>
        request<{ comment: CommentDto }>(
          'POST',
          'taskId' in target ? `/tasks/${target.taskId}/comments` : `/projects/${target.projectId}/comments`,
          { body, id },
        ),
      remove: (id: string) => request<void>('DELETE', `/comments/${id}`),
    },
    notifications: {
      list: (unreadOnly = false) =>
        request<{ notifications: NotificationDto[]; unread: number }>('GET', `/me/notifications${unreadOnly ? '?unread=1' : ''}`),
      markRead: (ids?: string[]) => request<{ updated: number }>('POST', '/me/notifications/read', ids ? { ids } : {}),
    },
    members: {
      list: (orgId: string) => request<{ members: OrgMemberDto[] }>('GET', `/organisations/${orgId}/members`),
      changeRole: (orgId: string, userId: string, role: OrgRoleValue) =>
        request<void>('PATCH', `/organisations/${orgId}/members/${userId}`, { role }),
      remove: (orgId: string, userId: string) => request<void>('DELETE', `/organisations/${orgId}/members/${userId}`),
      audit: (orgId: string) => request<{ entries: AuditEntryDto[] }>('GET', `/organisations/${orgId}/audit`),
      workspace: (workspaceId: string) => request<{ members: WorkspaceMemberDto[] }>('GET', `/workspaces/${workspaceId}/members`),
      setWorkspaceRole: (workspaceId: string, userId: string, role: WorkspaceRoleValue) =>
        request<void>('PUT', `/workspaces/${workspaceId}/members/${userId}`, { role }),
      removeFromWorkspace: (workspaceId: string, userId: string) =>
        request<void>('DELETE', `/workspaces/${workspaceId}/members/${userId}`),
    },
    invitations: {
      list: (orgId: string) => request<{ invitations: InvitationDto[] }>('GET', `/organisations/${orgId}/invitations`),
      create: (orgId: string, input: CreateInvitationInput) =>
        request<{ invitation: CreatedInvitationDto }>('POST', `/organisations/${orgId}/invitations`, input),
      revoke: (orgId: string, invitationId: string) => request<void>('DELETE', `/organisations/${orgId}/invitations/${invitationId}`),
      preview: (token: string) => request<{ invitation: InvitationPreviewDto }>('GET', `/invitations/${encodeURIComponent(token)}`),
      accept: (token: string) =>
        request<{ organisationId: string; workspaceId: string | null }>('POST', `/invitations/${encodeURIComponent(token)}/accept`),
    },
    projects: {
      list: (workspaceId: string) =>
        request<{ projects: ProjectListItemDto[]; workspace: WorkspaceSummaryDto }>('GET', `/workspaces/${workspaceId}/projects`),
      create: (workspaceId: string, input: CreateProjectInput) =>
        request<{ project: ProjectDto }>('POST', `/workspaces/${workspaceId}/projects`, input),
      get: (projectId: string) => request<{ project: ProjectDetailDto }>('GET', `/projects/${projectId}`),
      update: (projectId: string, input: UpdateProjectInput) =>
        request<{ project: ProjectDto }>('PATCH', `/projects/${projectId}`, input),
      remove: (projectId: string) => request<void>('DELETE', `/projects/${projectId}`),
      readiness: (projectId: string, today?: string) =>
        request<{ readiness: ReadinessReport }>('GET', `/projects/${projectId}/readiness${q(today)}`),
      activity: (projectId: string) => request<{ activity: ActivityDto[] }>('GET', `/projects/${projectId}/activity`),
    },
    tasks: {
      list: (projectId: string) => request<{ tasks: TaskDto[] }>('GET', `/projects/${projectId}/tasks`),
      create: (projectId: string, input: CreateTaskInput) =>
        request<{ task: TaskDto }>('POST', `/projects/${projectId}/tasks`, input),
      update: (taskId: string, input: UpdateTaskInput) => request<{ task: TaskDto }>('PATCH', `/tasks/${taskId}`, input),
      remove: (taskId: string) => request<void>('DELETE', `/tasks/${taskId}`),
      mine: () => request<{ tasks: MyTaskDto[] }>('GET', '/me/tasks'),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
