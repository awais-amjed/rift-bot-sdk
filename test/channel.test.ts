import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCipheriv,
  createHmac,
  createPrivateKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto';

import { ChannelReader } from '../src/channel.ts';
import { signedPayload, sign } from '../src/crypto.ts';
import { deriveChatIdentity, x25519PublicFrom, type ChatIdentity } from '../src/sealed.ts';
import type { BotSession } from '../src/session.ts';

/**
 * The one place a bot reads what it was not addressed — BOTS.md §6.
 *
 * The database decides whether it may; these are about what the SDK does with
 * the rows it is handed. Two of them are the failures that would be invisible
 * in production: a forged row acted on as though it were real, and a stretch of
 * conversation skipped because its key had not arrived yet.
 */

const CHANNEL = 'cccccccc-0000-4000-8000-000000000001';
const BOT = 'bbbbbbbb-0000-4000-8000-000000000001';
const MEMBER = 'aaaaaaaa-0000-4000-8000-000000000001';

/** Seal a body the way the Dart client does, and sign it the same way. */
function sealed(
  text: string,
  key: Buffer,
  keyVersion: number,
  signer: { privateKey: ReturnType<typeof createPrivateKey> },
) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const ciphertext = Buffer.concat([body, cipher.getAuthTag()]).toString('base64');
  const nonceB64 = nonce.toString('base64');
  return {
    ciphertext,
    nonce: nonceB64,
    signature: sign(
      signedPayload(CHANNEL, keyVersion, nonceB64, ciphertext),
      signer.privateKey,
    ),
    key_version: keyVersion,
  };
}

/** Wrap a channel key for the bot, exactly as a member's client does. */
function wrapFor(identity: ChatIdentity, key: Buffer) {
  const ephemeral = generateKeyPairSync('x25519');
  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: x25519PublicFrom(identity.publicKey),
  });
  const wrappingKey = createHmac('sha256', shared).update('wrap:v1', 'utf8').digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', wrappingKey, nonce);
  // The *base64* of the key, not its bytes — the doubled encoding is the trap.
  const body = Buffer.concat([
    cipher.update(key.toString('base64'), 'utf8'),
    cipher.final(),
  ]);
  return {
    ephemeral_public_key: ephemeral.publicKey
      .export({ format: 'der', type: 'spki' })
      .subarray(-32)
      .toString('base64'),
    ciphertext: Buffer.concat([body, cipher.getAuthTag()]).toString('base64'),
    nonce: nonce.toString('base64'),
  };
}

interface Fixture {
  reader: ChannelReader;
  rows: Record<string, unknown>[];
  keyring: Record<string, unknown>[];
  queries: string[];
}

function fixture(identity: ChatIdentity, memberPublicKey: Buffer): Fixture {
  const rows: Record<string, unknown>[] = [];
  const keyring: Record<string, unknown>[] = [];
  const queries: string[] = [];

  const session = {
    userId: BOT,
    chatIdentity: identity,
    async select(query: string) {
      queries.push(query);
      if (query.startsWith('messages?')) return rows;
      if (query.startsWith('channel_keyring?')) return keyring;
      if (query.startsWith('users?')) {
        return [{ public_key: memberPublicKey.toString('base64') }];
      }
      if (query.startsWith('bot_channel_keys?')) return [{ from_key_version: 2 }];
      return [];
    },
  } as unknown as BotSession;

  return { reader: new ChannelReader(session, CHANNEL), rows, keyring, queries };
}

function member() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
  };
}

test('a granted bot opens what was sealed under a version it holds', async () => {
  const identity = deriveChatIdentity(randomBytes(32), 'localhost');
  const author = member();
  const f = fixture(identity, author.publicKey);
  const key = randomBytes(32);

  f.keyring.push({ key_version: 2, ...wrapFor(identity, key) });
  f.rows.push({
    id: 7,
    channel_id: CHANNEL,
    sender_id: MEMBER,
    created_at: '2026-09-02T00:00:00Z',
    ...sealed('the quiet part', key, 2, author),
  });

  const out = await f.reader.since(0);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'the quiet part');
  assert.equal(out[0].senderId, MEMBER);
  assert.equal(out[0].keyVersion, 2);
});

test('a row signed by somebody else is dropped, not delivered', async () => {
  // The whole attack: a bot that acts on a forged row is a bot that can be
  // told to do anything by anyone who can write to the table.
  const identity = deriveChatIdentity(randomBytes(32), 'localhost');
  const author = member();
  const impostor = member();
  const f = fixture(identity, author.publicKey);
  const key = randomBytes(32);

  f.keyring.push({ key_version: 2, ...wrapFor(identity, key) });
  f.rows.push({
    id: 8,
    channel_id: CHANNEL,
    sender_id: MEMBER,
    created_at: '2026-09-02T00:00:00Z',
    ...sealed('transfer everything', key, 2, impostor),
  });

  assert.deepEqual(await f.reader.since(0), []);
});

test('it stops at a version whose key has not been sealed yet', async () => {
  // A rotation lands, and the member who will seal it for this bot has not
  // opened the channel yet. Skipping those rows would drop that stretch of the
  // conversation for good; standing still is recoverable.
  const identity = deriveChatIdentity(randomBytes(32), 'localhost');
  const author = member();
  const f = fixture(identity, author.publicKey);
  const two = randomBytes(32);

  f.keyring.push({ key_version: 2, ...wrapFor(identity, two) });
  f.rows.push(
    { id: 9, channel_id: CHANNEL, sender_id: MEMBER, created_at: 'x',
      ...sealed('before the rotation', two, 2, author) },
    { id: 10, channel_id: CHANNEL, sender_id: MEMBER, created_at: 'x',
      ...sealed('after it', randomBytes(32), 3, author) },
    { id: 11, channel_id: CHANNEL, sender_id: MEMBER, created_at: 'x',
      ...sealed('and after that', two, 2, author) },
  );

  const out = await f.reader.since(0);
  assert.deepEqual(out.map((m) => m.id), [9]);
});

test('a plaintext row is skipped rather than stalling the reader', async () => {
  // Webhook posts, system notices and commands to other bots are key_version 0
  // and were never sealed. No amount of waiting produces a key for them, so
  // unlike a missing rotation these must not stop the cursor.
  const identity = deriveChatIdentity(randomBytes(32), 'localhost');
  const author = member();
  const f = fixture(identity, author.publicKey);
  const key = randomBytes(32);

  f.keyring.push({ key_version: 2, ...wrapFor(identity, key) });
  f.rows.push(
    { id: 12, channel_id: CHANNEL, sender_id: null, ciphertext: 'build passed',
      nonce: '', signature: null, key_version: 0, created_at: 'x' },
    { id: 13, channel_id: CHANNEL, sender_id: MEMBER, created_at: 'x',
      ...sealed('still reading', key, 2, author) },
  );

  const out = await f.reader.since(0);
  assert.deepEqual(out.map((m) => m.id), [13]);
});

test('an ungranted channel says so instead of going quiet', async () => {
  const identity = deriveChatIdentity(randomBytes(32), 'localhost');
  const session = {
    userId: BOT,
    chatIdentity: identity,
    async select() {
      return [];
    },
  } as unknown as BotSession;

  assert.equal(await new ChannelReader(session, CHANNEL).grantedFrom(), null);
});

test('the keyring is fetched once, not once per message', async () => {
  const identity = deriveChatIdentity(randomBytes(32), 'localhost');
  const author = member();
  const f = fixture(identity, author.publicKey);
  const key = randomBytes(32);

  f.keyring.push({ key_version: 2, ...wrapFor(identity, key) });
  for (let id = 20; id < 25; id++) {
    f.rows.push({ id, channel_id: CHANNEL, sender_id: MEMBER, created_at: 'x',
      ...sealed(`m${id}`, key, 2, author) });
  }

  await f.reader.since(0);
  const fetches = f.queries.filter((q) => q.startsWith('channel_keyring?'));
  assert.equal(fetches.length, 1);
});
