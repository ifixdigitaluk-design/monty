import { createHash, randomBytes } from 'node:crypto';

/** OWASP baseline parameters for Argon2id. */
export const ARGON_OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

/** Only hashes of bearer secrets (sessions, invitations, email tokens) are ever stored. */
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** 256-bit URL-safe random secret. */
export const newSecret = () => randomBytes(32).toString('base64url');
