import { createDecipheriv } from 'node:crypto';

import type { BotSession } from './session.ts';

/**
 * Open an AES-256-GCM body — a DM under its conversation key, a channel message
 * under the channel key. The tag is the last 16 bytes, concatenated by the Dart
 * side rather than carried beside them.
 */
export function open(ciphertext: string, nonce: string, key: Buffer): string {
  const sealed = Buffer.from(ciphertext, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64'));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([
    decipher.update(sealed.subarray(0, sealed.length - 16)),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Ed25519 public keys, by user, fetched once.
 *
 * Every message is verified before a bot acts on it, so this is asked for on
 * every row of every poll — and a member's signing key does not change under a
 * running process. A miss is cached as nothing rather than as null so an
 * author who has published no key is not re-fetched forever.
 */
export class SenderKeys {
  readonly session: BotSession;
  readonly #keys = new Map<string, Buffer | null>();

  constructor(session: BotSession) {
    this.session = session;
  }

  async publicKeyFor(userId: string): Promise<Buffer | null> {
    const cached = this.#keys.get(userId);
    if (cached !== undefined) return cached;

    const rows = await this.session.select<{ public_key: string | null }>(
      `users?select=public_key&id=eq.${userId}`,
    );
    const key = rows[0]?.public_key;
    const bytes = key ? Buffer.from(key, 'base64') : null;
    this.#keys.set(userId, bytes);
    return bytes;
  }
}
