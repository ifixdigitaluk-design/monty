import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, verifyTotp } from '../src/auth/totp';

// RFC 6238 Appendix B (SHA-1) secret "12345678901234567890"; 6-digit codes are the last 6 digits of the 8-digit vectors.
const SECRET = Buffer.from('12345678901234567890');
const B32 = base32Encode(SECRET);

describe('TOTP (RFC 6238 / RFC 4226)', () => {
  it('matches the RFC 4226 HOTP test values', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, counter) => expect(hotp(SECRET, counter)).toBe(code));
  });

  it('matches RFC 6238 SHA-1 vectors at the published times', () => {
    const vectors: [number, string][] = [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
      [20000000000, '353130'],
    ];
    for (const [t, code] of vectors) expect(verifyTotp(B32, code, null, t * 1000), `t=${t}`).toBe(Math.floor(t / 30));
  });

  it('accepts ±1 step, refuses replays and wrong codes', () => {
    const t = 1111111111 * 1000;
    const step = Math.floor(t / 30000);
    expect(verifyTotp(B32, hotp(SECRET, step - 1), null, t)).toBe(step - 1);
    expect(verifyTotp(B32, hotp(SECRET, step + 1), null, t)).toBe(step + 1);
    expect(verifyTotp(B32, hotp(SECRET, step + 2), null, t)).toBeNull();
    expect(verifyTotp(B32, hotp(SECRET, step), step, t)).toBeNull(); // already used
    expect(verifyTotp(B32, '000000', null, t)).toBeNull();
  });

  it('base32 round-trips', () => {
    expect(base32Decode(B32).equals(SECRET)).toBe(true);
    expect(B32).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });
});
