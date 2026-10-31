import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM encryption at rest for data that must be stored but should not be readable from a database dump
 * (queued emails containing one-time links, personal data exports).
 * Format: "v1.<iv b64url>.<tag b64url>.<ciphertext b64url>". The version prefix allows key rotation later.
 */
export function encrypt(key: Buffer, plaintext: Buffer | string, aad = ''): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(typeof plaintext === 'string' ? Buffer.from(plaintext) : plaintext), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decrypt(key: Buffer, sealed: string, aad = ''): Buffer {
  const [v, iv, tag, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Unsupported ciphertext format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]);
}
