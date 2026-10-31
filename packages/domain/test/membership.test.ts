import { describe, expect, it } from 'vitest';
import { canChangeRole, canInvite, canRemoveMember, higherOrgRole } from '../src/membership';

describe('canInvite', () => {
  it('lets owners and admins invite non-owner roles', () => {
    expect(canInvite('OWNER', 'ADMIN').ok).toBe(true);
    expect(canInvite('ADMIN', 'GUEST').ok).toBe(true);
  });
  it('blocks members, guests and owner invitations', () => {
    expect(canInvite('MEMBER', 'MEMBER').ok).toBe(false);
    expect(canInvite('GUEST', 'MEMBER').ok).toBe(false);
    expect(canInvite(null, 'MEMBER').ok).toBe(false);
    expect(canInvite('OWNER', 'OWNER').ok).toBe(false);
  });
});

describe('canChangeRole', () => {
  it('owner can promote to owner and demote an owner when another remains', () => {
    expect(canChangeRole({ actorRole: 'OWNER', targetCurrentRole: 'ADMIN', newRole: 'OWNER', ownerCount: 1 }).ok).toBe(true);
    expect(canChangeRole({ actorRole: 'OWNER', targetCurrentRole: 'OWNER', newRole: 'ADMIN', ownerCount: 2 }).ok).toBe(true);
  });
  it('never removes the last owner', () => {
    const r = canChangeRole({ actorRole: 'OWNER', targetCurrentRole: 'OWNER', newRole: 'ADMIN', ownerCount: 1 });
    expect(r).toEqual({ ok: false, reason: 'An organisation must keep at least one owner.' });
  });
  it('admins cannot touch ownership', () => {
    expect(canChangeRole({ actorRole: 'ADMIN', targetCurrentRole: 'MEMBER', newRole: 'OWNER', ownerCount: 1 }).ok).toBe(false);
    expect(canChangeRole({ actorRole: 'ADMIN', targetCurrentRole: 'OWNER', newRole: 'MEMBER', ownerCount: 3 }).ok).toBe(false);
    expect(canChangeRole({ actorRole: 'ADMIN', targetCurrentRole: 'MEMBER', newRole: 'ADMIN', ownerCount: 1 }).ok).toBe(true);
  });
  it('members cannot change roles', () => {
    expect(canChangeRole({ actorRole: 'MEMBER', targetCurrentRole: 'GUEST', newRole: 'MEMBER', ownerCount: 1 }).ok).toBe(false);
  });
});

describe('canRemoveMember', () => {
  it('anyone can leave except the last owner', () => {
    expect(canRemoveMember({ actorRole: 'GUEST', targetRole: 'GUEST', isSelf: true, ownerCount: 1 }).ok).toBe(true);
    expect(canRemoveMember({ actorRole: 'OWNER', targetRole: 'OWNER', isSelf: true, ownerCount: 1 }).ok).toBe(false);
    expect(canRemoveMember({ actorRole: 'OWNER', targetRole: 'OWNER', isSelf: true, ownerCount: 2 }).ok).toBe(true);
  });
  it('admins remove members but not owners; members remove nobody', () => {
    expect(canRemoveMember({ actorRole: 'ADMIN', targetRole: 'MEMBER', isSelf: false, ownerCount: 1 }).ok).toBe(true);
    expect(canRemoveMember({ actorRole: 'ADMIN', targetRole: 'OWNER', isSelf: false, ownerCount: 2 }).ok).toBe(false);
    expect(canRemoveMember({ actorRole: 'MEMBER', targetRole: 'GUEST', isSelf: false, ownerCount: 1 }).ok).toBe(false);
  });
});

describe('higherOrgRole', () => {
  it('keeps the stronger role', () => {
    expect(higherOrgRole('ADMIN', 'MEMBER')).toBe('ADMIN');
    expect(higherOrgRole('GUEST', 'MEMBER')).toBe('MEMBER');
  });
});
