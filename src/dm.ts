import { createCipheriv, createHmac, diffieHellman, randomBytes } from 'node:crypto';

import { conversationContext, sign, signedPayload, verifySignature } from './crypto.ts';
import { x25519PublicFrom, type ChatIdentity } from './sealed.ts';
import { BotError, type BotSession } from './session.ts';
import { open, SenderKeys } from './verify.ts';

/**
 * Direct messages to a bot.
 *
 * BOTS.md §3's fourth row, and the one people get wrong: a DM to a bot is
 * private **from the server**, not from the bot. It is sealed exactly like a DM
 * between two people, and the bot is simply one of the two ends.
 *
 * That makes it the one place a bot does real chat crypto. Everything else it
 * writes is `key_version: 0` — signed, not sealed — because a bot never holds a
 * channel key. Here it holds half of a key pair nobody else has, which is a
 * different thing: the conversation key falls out of the two identities and is
 * never stored or sent.
 *
 *     dmKey = HMAC-SHA256(X25519(myChatPrivate, theirChatPublic), "dm:v1")
 *
 * Both ends derive the same bytes from opposite halves, so there is nothing to
 * distribute and nothing for the server to hold.
 */

/** AES-256-GCM, the way the Dart side writes it: ciphertext with the tag on. */
function seal(plaintext: string, key: Buffer): { ciphertext: string; nonce: string } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: Buffer.concat([body, cipher.getAuthTag()]).toString('base64'),
    nonce: nonce.toString('base64'),
  };
}

/**
 * The conversation key shared with one peer.
 *
 * Pure ECDH, so it needs nothing but the two public halves and never leaves
 * this process. A peer who has not opened Rift yet has published no chat key
 * and cannot be talked to at all — the same wall a person hits.
 */
export function deriveDmKey(identity: ChatIdentity, peerChatPublicKey: string): Buffer {
  const shared = diffieHellman({
    privateKey: identity.privateKey,
    publicKey: x25519PublicFrom(Buffer.from(peerChatPublicKey, 'base64')),
  });
  return createHmac('sha256', shared).update('dm:v1', 'utf8').digest();
}

/** The tagged JSON a message's plaintext actually is. */
const BODY_TAG = 'rift.msg';

/**
 * Unwrap the body. Anything that is not the tagged object is a message from
 * before the shape existed and is its own text, which is why this never throws
 * on content it does not recognise.
 */
export function decodeBody(plaintext: string): string {
  try {
    const decoded = JSON.parse(plaintext);
    if (decoded && typeof decoded === 'object' && decoded.t === BODY_TAG) {
      return typeof decoded.text === 'string' ? decoded.text : '';
    }
  } catch {
    // Not JSON at all, so it is the text.
  }
  return plaintext;
}

export function encodeBody(text: string): string {
  return JSON.stringify({ t: BODY_TAG, v: 1, text });
}

/** One direct message, opened. */
export interface DirectMessage {
  readonly id: number;
  /** Who sent it — the person on the other end. */
  readonly peerId: string;
  readonly text: string;
  readonly sentAt: string;
}

/** A row of `dm_messages` as it comes back. */
interface DmRow {
  id: number;
  sender_id: string;
  recipient_id: string;
  ciphertext: string;
  nonce: string;
  key_version: number;
  signature: string | null;
  created_at: string;
}

/**
 * Read and answer direct messages.
 *
 * Held separately from [Bot] because the two have different reach: a bot in a
 * channel is spoken to in front of everybody and answers there, and a DM is a
 * conversation with one person that no member and no server can read. Keeping
 * them apart is also what stops a `reply` going to the wrong one.
 */
export class DirectMessages {
  readonly session: BotSession;

  /** Conversation keys, by peer id. Derived once; they never change. */
  readonly #keys = new Map<string, Buffer>();
  /** Ed25519 public keys, for checking who really wrote a row. */
  readonly #senders: SenderKeys;

  constructor(session: BotSession) {
    this.session = session;
    this.#senders = new SenderKeys(session);
  }

  /** Everything sent to this bot after [afterId], oldest first. */
  async since(afterId: number): Promise<DirectMessage[]> {
    const rows = await this.session.select<DmRow>(
      'dm_messages?select=id,sender_id,recipient_id,ciphertext,nonce,' +
        'key_version,signature,created_at' +
        `&recipient_id=eq.${this.session.userId}&id=gt.${afterId}&order=id.asc`,
    );

    const out: DirectMessage[] = [];
    for (const row of rows) {
      const opened = await this.#open(row);
      if (opened) out.push(opened);
    }
    return out;
  }

  /** The newest id addressed to this bot, so a restart starts from *now*. */
  async newestId(): Promise<number> {
    const rows = await this.session.select<{ id: number }>(
      `dm_messages?select=id&recipient_id=eq.${this.session.userId}&order=id.desc&limit=1`,
    );
    return rows.length === 0 ? 0 : rows[0].id;
  }

  /** Answer one, sealed to the same conversation. */
  async reply(to: DirectMessage, text: string): Promise<void> {
    const key = await this.#keyFor(to.peerId);
    const contextId = conversationContext(this.session.userId!, to.peerId);
    const { ciphertext, nonce } = seal(encodeBody(text), key);

    await this.session.insert('dm_messages', {
      recipient_id: to.peerId,
      ciphertext,
      nonce,
      key_version: 1,
      signature: sign(
        signedPayload(contextId, 1, nonce, ciphertext),
        this.session.identity.privateKey,
      ),
    });
    await this.session.ringDoorbell(`dm:${to.peerId}`);
  }

  /**
   * Open one row, or null if it cannot be trusted.
   *
   * Two ways a row is dropped rather than shown, and both are silent on
   * purpose. A signature that does not check out means the row is not from who
   * it claims — a bot acting on it is the whole attack. And a body that will
   * not decrypt is one sealed to a key this bot does not have, which is a
   * message it was never part of.
   */
  async #open(row: DmRow): Promise<DirectMessage | null> {
    try {
      const key = await this.#keyFor(row.sender_id);
      const contextId = conversationContext(row.sender_id, row.recipient_id);
      const payload = signedPayload(contextId, row.key_version, row.nonce, row.ciphertext);

      const senderKey = await this.#senders.publicKeyFor(row.sender_id);
      if (!senderKey || !row.signature) return null;
      if (!verifySignature(payload, row.signature, senderKey)) return null;

      return {
        id: row.id,
        peerId: row.sender_id,
        text: decodeBody(open(row.ciphertext, row.nonce, key)),
        sentAt: row.created_at,
      };
    } catch {
      return null;
    }
  }

  async #keyFor(peerId: string): Promise<Buffer> {
    const cached = this.#keys.get(peerId);
    if (cached) return cached;

    const rows = await this.session.select<{ chat_public_key: string | null }>(
      `users?select=chat_public_key&id=eq.${peerId}`,
    );
    const theirs = rows[0]?.chat_public_key;
    if (!theirs) {
      throw new BotError(
        `${peerId} has published no chat key, so there is no conversation to open`,
      );
    }
    const key = deriveDmKey(this.session.chatIdentity, theirs);
    this.#keys.set(peerId, key);
    return key;
  }

}
