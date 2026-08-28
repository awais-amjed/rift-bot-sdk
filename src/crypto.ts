import { createHmac, createPrivateKey, createPublicKey, sign as nodeSign, randomBytes, KeyObject } from 'node:crypto';

/**
 * The key ladder and the signing format, exactly as `WIRE.md` describes them.
 *
 * No dependencies, and that is the point rather than a boast: everything a bot
 * needs is HMAC-SHA256, an Ed25519 keypair from a seed, one signature and
 * base64 — all of which Node has had for years. A bot never holds a channel
 * key, so it never opens anything, so there is no X25519, no AES-GCM and no
 * Argon2id here at all.
 *
 * Every value this file produces is checked against `../test/wire_vectors.json`
 * — the same file the Dart implementation is checked against. That is the only
 * reason two implementations can be trusted to agree: a payload that differs by
 * one character stores fine, verifies as false, and renders as nothing.
 */

/** Node cannot build an Ed25519 key from a raw seed, but it can read PKCS#8. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface ServerIdentity {
  /** Signs. */
  readonly privateKey: KeyObject;
  /** 32 raw bytes — what the server stores as `users.public_key`. */
  readonly publicKey: Buffer;
  /** base64, and the thing a ban is remembered by. */
  readonly stableId: string;
}

export function hmac(seed: Buffer, message: string): Buffer {
  return createHmac('sha256', seed).update(message, 'utf8').digest();
}

/**
 * The identity a bot logs in with.
 *
 * Scoped to `(host, serverId)`, so one seed across N servers is N unrelated
 * bots and no server can correlate them. `host` is the URL's host **only** —
 * no scheme, no port — which is the mistake a port makes first.
 */
export function deriveServerIdentity(
  seed: Buffer,
  host: string,
  serverId?: string,
  version = 'v1',
): ServerIdentity {
  const scope = serverId ? `${host}:${serverId}` : host;
  const childSeed = hmac(seed, `${scope}:${version}`);

  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, childSeed]),
    format: 'der',
    type: 'pkcs8',
  });
  // SPKI ends with the 32 raw bytes; there is no export that hands them over
  // directly.
  const publicKey = createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' })
    .subarray(-32);

  return {
    privateKey,
    publicKey,
    stableId: hmac(seed, `${scope}:identity`).toString('base64'),
  };
}

/** Ed25519 over the UTF-8 bytes, base64 out. Deterministic, so it is testable. */
export function sign(payload: string, privateKey: KeyObject): string {
  return nodeSign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64');
}

/**
 * The one string every message is signed over.
 *
 * Joined with `:` and nothing else. A bot's message uses version 0 and an empty
 * nonce, which leaves two colons together — dropping the empty field produces a
 * payload one character shorter and a signature nothing verifies.
 */
export function signedPayload(
  contextId: string,
  keyVersion: number,
  nonce: string,
  ciphertext: string,
): string {
  return `chatmsg:v1:${contextId}:${keyVersion}:${nonce}:${ciphertext}`;
}

/** Sorted, so both sides of a DM derive the same one without agreeing first. */
export function conversationContext(a: string, b: string): string {
  const [first, second] = [a, b].sort();
  return `dm:${first}:${second}`;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Only the SIWS address is base58. Everything else on the wire is base64. */
export function toBase58(bytes: Buffer): string {
  if (bytes.length === 0) return '';
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);

  let out = '';
  while (value > 0n) {
    out = B58[Number(value % 58n)] + out;
    value /= 58n;
  }
  // A leading zero byte carries no magnitude, so it has to be counted rather
  // than computed.
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out;
}

/**
 * The SIWS message GoTrue's web3 grant expects, and its signature.
 *
 * `localhost` is a constant and not the server's address — see
 * `crypto_repository_identity.dart` for the long version. GoTrue refuses most
 * real addresses, and the two fields exist so a *wallet* can say which site is
 * asking; Rift has no wallet, and the key is derived per `(host, serverId)` and
 * posted only to the host it was derived for.
 */
export function signSiws(identity: ServerIdentity): { message: string; signature: string } {
  const address = toBase58(identity.publicKey);
  const nonce = randomBytes(12).toString('base64').replace(/[^A-Za-z0-9]/g, '');
  const issuedAt = new Date().toISOString();

  const message =
    `localhost wants you to sign in with your Solana account:\n` +
    `${address}\n` +
    `\n` +
    `Sign in to Rift.\n` +
    `\n` +
    `URI: http://localhost\n` +
    `Version: 1\n` +
    `Chain ID: solana:mainnet\n` +
    `Nonce: ${nonce}\n` +
    `Issued At: ${issuedAt}`;

  return { message, signature: sign(message, identity.privateKey) };
}
