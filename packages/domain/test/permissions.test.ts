import { describe, expect, it } from 'vitest';
import { canInOrg, canInWorkspace, effectiveWorkspaceRole, WorkspaceAction } from '../src/permissions';

describe('effectiveWorkspaceRole', () => {
  it('denies non-members of the organisation even with a workspace row', () => {
    expect(effectiveWorkspaceRole(null, 'ADMIN')).toBeNull();
  });
  it('gives org owners and admins admin on every workspace', () => {
    expect(effectiveWorkspaceRole('OWNER', null)).toBe('ADMIN');
    expect(effectiveWorkspaceRole('ADMIN', 'VIEWER')).toBe('ADMIN');
  });
  it('requires explicit membership for org members', () => {
    expect(effectiveWorkspaceRole('MEMBER', null)).toBeNull();
    expect(effectiveWorkspaceRole('MEMBER', 'VIEWER')).toBe('VIEWER');
  });
  it('caps guests at MEMBER', () => {
    expect(effectiveWorkspaceRole('GUEST', 'ADMIN')).toBe('MEMBER');
    expect(effectiveWorkspaceRole('GUEST', null)).toBeNull();
  });
});

describe('canInWorkspace', () => {
  const all: WorkspaceAction[] = [
    'workspace.read',
    'workspace.manage',
    'project.create',
    'project.update',
    'project.delete',
    'task.create',
    'task.update',
    'task.delete',
  ];
  it('admin can do everything', () => {
    for (const a of all) expect(canInWorkspace('ADMIN', a)).toBe(true);
  });
  it('viewer can only read', () => {
    for (const a of all) expect(canInWorkspace('VIEWER', a)).toBe(a === 'workspace.read');
  });
  it('member cannot manage workspace or delete others projects', () => {
    expect(canInWorkspace('MEMBER', 'workspace.manage')).toBe(false);
    expect(canInWorkspace('MEMBER', 'project.delete')).toBe(false);
    expect(canInWorkspace('MEMBER', 'project.delete', { isCreator: true })).toBe(true);
    expect(canInWorkspace('MEMBER', 'task.update')).toBe(true);
  });
  it('null role can do nothing', () => {
    for (const a of all) expect(canInWorkspace(null, a)).toBe(false);
  });
});

describe('canInOrg', () => {
  it('only owners/admins create workspaces', () => {
    expect(canInOrg('OWNER', 'workspace.create')).toBe(true);
    expect(canInOrg('ADMIN', 'workspace.create')).toBe(true);
    expect(canInOrg('MEMBER', 'workspace.create')).toBe(false);
    expect(canInOrg('GUEST', 'org.read')).toBe(false);
    expect(canInOrg(undefined, 'org.read')).toBe(false);
  });
});
