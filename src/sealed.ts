import { createDecipheriv, createHmac, createPrivateKey, createPublicKey, diffieHellman, type KeyObject } from 'node:crypto';

/**
 * Opening something a member sealed for this bot.
 *
 * The rest of this package deliberately has no X25519 and no AES-GCM: a bot
 * never held a key, so it never opened anything. End-to-end encrypted calls
 * changed that — a bot has to encrypt its own media to be heard, and the key it
 * encrypts with is derived from the channel key and sealed to it by a member
 * (BOTS.md §6b). It still never holds the channel key.
 *
 * The format is `wrap:v1` from ARCHITECTURE.md §4, and it is a contract with
 * the Dart implementation rather than a choice this file makes:
 *
 *   shared      = X25519(myPrivate, ephemeralPublic)
 *   wrappingKey = HMAC-SHA256(shared, "wrap:v1")
 *   plaintext   = AES-256-GCM(ciphertext||tag, wrappingKey, nonce)
 *   key         = base64-decode(plaintext)
 *
 * The doubled base64 is not an accident: the Dart side seals a *string*, so the
 * plaintext inside the envelope is the key's base64 rather than its bytes. A
 * port that decoded once gets 44 bytes of ASCII where it wanted 32 and fails at
 * the frame cryptor, a long way from here.
 */

/** DER prefixes for a raw 32-byte X25519 key, so `node:crypto` will take one. */
const X25519_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');

export interface ChatIdentity {
  readonly privateKey: KeyObject;
  /** 32 raw bytes — what the server stores as `users.chat_public_key`. */
  readonly publicKey: Buffer;
}

/**
 * This bot's X25519 identity on one host.
 *
 * Per host and pinned at `v1`, deliberately not scoped to a server and
 * deliberately not following the auth key's version — see WIRE.md §2. Rotating
 * it would make everything sealed to the old one unopenable.
 */
export function deriveChatIdentity(seed: Buffer, host: string, version = 'v1'): ChatIdentity {
  const childSeed = createHmac('sha256', seed).update(`${host}:chat:${version}`, 'utf8').digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8, childSeed]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' })
    .subarray(X25519_SPKI.length);
  return { privateKey, publicKey: Buffer.from(publicKey) };
}

/** One sealed key, as it comes off the row. */
export interface Wrapped {
  ephemeral_public_key: string;
  ciphertext: string;
  nonce: string;
}

/** A raw 32-byte X25519 public key, as `node:crypto` will take it. */
export function x25519PublicFrom(raw: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI, raw]),
    format: 'der',
    type: 'spki',
  });
}

/** Open a key sealed to [identity]. Throws if the tag does not check out. */
export function unwrapKey(identity: ChatIdentity, wrapped: Wrapped): Buffer {
  const ephemeral = x25519PublicFrom(Buffer.from(wrapped.ephemeral_public_key, 'base64'));
  const shared = diffieHellman({ privateKey: identity.privateKey, publicKey: ephemeral });
  const wrappingKey = createHmac('sha256', shared).update('wrap:v1', 'utf8').digest();

  // The Dart side stores ciphertext and tag concatenated, with the nonce
  // beside them. GCM's tag is the last 16 bytes.
  const sealed = Buffer.from(wrapped.ciphertext, 'base64');
  const tag = sealed.subarray(sealed.length - 16);
  const body = sealed.subarray(0, sealed.length - 16);

  const decipher = createDecipheriv('aes-256-gcm', wrappingKey, Buffer.from(wrapped.nonce, 'base64'));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  return Buffer.from(plaintext, 'base64');
}
