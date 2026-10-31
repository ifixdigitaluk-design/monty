/**
 * Central authorisation rules. Every API service method calls these functions;
 * the UI may use them to hide controls, but the server is authoritative.
 */

export type OrgRole = 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST';
export type WorkspaceRole = 'ADMIN' | 'MEMBER' | 'VIEWER';

export type OrgAction = 'org.read' | 'org.manage' | 'workspace.create';

export type WorkspaceAction =
  | 'workspace.read'
  | 'workspace.manage'
  | 'project.create'
  | 'project.update'
  | 'project.delete'
  | 'task.create'
  | 'task.update'
  | 'task.delete';

const ORG_MATRIX: Record<OrgRole, readonly OrgAction[]> = {
  OWNER: ['org.read', 'org.manage', 'workspace.create'],
  ADMIN: ['org.read', 'org.manage', 'workspace.create'],
  MEMBER: ['org.read'],
  GUEST: [],
};

const WORKSPACE_MATRIX: Record<WorkspaceRole, readonly WorkspaceAction[]> = {
  ADMIN: [
    'workspace.read',
    'workspace.manage',
    'project.create',
    'project.update',
    'project.delete',
    'task.create',
    'task.update',
    'task.delete',
  ],
  MEMBER: ['workspace.read', 'project.create', 'project.update', 'task.create', 'task.update', 'task.delete'],
  VIEWER: ['workspace.read'],
};

/**
 * The role a user effectively holds in a workspace.
 * - Must be an organisation member at all (otherwise no access).
 * - Org OWNER/ADMIN administer every workspace in the org.
 * - Org MEMBER needs an explicit workspace membership.
 * - Org GUEST needs an explicit workspace membership and is capped at MEMBER.
 */
export function effectiveWorkspaceRole(
  orgRole: OrgRole | null | undefined,
  workspaceRole: WorkspaceRole | null | undefined,
): WorkspaceRole | null {
  if (!orgRole) return null;
  if (orgRole === 'OWNER' || orgRole === 'ADMIN') return 'ADMIN';
  if (!workspaceRole) return null;
  if (orgRole === 'GUEST' && workspaceRole === 'ADMIN') return 'MEMBER';
  return workspaceRole;
}

export function canInOrg(orgRole: OrgRole | null | undefined, action: OrgAction): boolean {
  if (!orgRole) return false;
  return ORG_MATRIX[orgRole].includes(action);
}

export interface WorkspaceActionContext {
  /** True when the actor created the resource (allows members to delete their own projects). */
  isCreator?: boolean;
}

export function canInWorkspace(
  role: WorkspaceRole | null | undefined,
  action: WorkspaceAction,
  ctx: WorkspaceActionContext = {},
): boolean {
  if (!role) return false;
  if (WORKSPACE_MATRIX[role].includes(action)) return true;
  if (action === 'project.delete' && role === 'MEMBER' && ctx.isCreator) return true;
  return false;
}
