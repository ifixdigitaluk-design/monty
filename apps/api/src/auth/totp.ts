import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 6238 TOTP (HMAC-SHA1, 30-second steps, 6 digits) — what Google Authenticator, Authy, 1Password etc. use. */
const STEP_SECONDS = 30;
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').toUpperCase().replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(randomBytes(20)); // 160-bit, as recommended by RFC 4226

export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

/**
 * Returns the matched time step, or null. Accepts ±1 step for clock drift. Steps at or before `lastStep`
 * are refused so an observed code can't be replayed.
 */
export function verifyTotp(secretB32: string, code: string, lastStep: number | null, now = Date.now()): number | null {
  const secret = base32Decode(secretB32);
  const step = currentStep(now);
  for (const s of [step - 1, step, step + 1]) {
    if (lastStep !== null && s <= lastStep) continue;
    const expected = Buffer.from(hotp(secret, s));
    const given = Buffer.from(code.padStart(DIGITS, '0').slice(0, DIGITS));
    if (expected.length === given.length && timingSafeEqual(expected, given)) return s;
  }
  return null;
}

export function otpauthUrl(secretB32: string, account: string, issuer = 'Monty'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

/** 10 recovery codes like "k3f9-x2ab-7qpm" (60 bits each). */
export function newRecoveryCodes(n = 10): string[] {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: n }, () => {
    const bytes = randomBytes(12);
    const raw = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  });
}
