import { describe, expect, it } from 'vitest';
import { checkLimit } from '../src/entitlements';

describe('checkLimit', () => {
  it('allows below the limit, blocks at it, and treats null as unlimited', () => {
    expect(checkLimit('FREE', 'projects', 9)).toEqual({ ok: true, limit: 10 });
    expect(checkLimit('FREE', 'projects', 10)).toEqual({ ok: false, limit: 10 });
    expect(checkLimit('ENTERPRISE', 'members', 1e6)).toEqual({ ok: true, limit: null });
  });
});
