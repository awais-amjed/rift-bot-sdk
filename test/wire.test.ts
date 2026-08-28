import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPublicKey, verify } from 'node:crypto';

import {
  conversationContext,
  deriveServerIdentity,
  hmac,
  sign,
  signedPayload,
  toBase58,
} from '../src/crypto.ts';

/**
 * The whole reason `WIRE.md` and the vectors exist.
 *
 * This is a *second* implementation checking itself against numbers the first
 * one produced. Nothing here reads the Dart code, and nothing in the Dart code
 * reads this — they meet at one JSON file, which is the only arrangement in
 * which "they agree" means anything.
 *
 * A payload that differs by one character stores fine, verifies as false, and
 * renders as nothing: the bot watches it send and nobody ever sees it. That
 * failure is invisible in both codebases and obvious here.
 */
const vectors = JSON.parse(readFileSync(new URL('../../test/wire_vectors.json', import.meta.url), 'utf8'));
const seed = Buffer.from(vectors.seed_base64, 'base64');

test('the key ladder: HMAC over the domain strings', () => {
  for (const [key, expected] of Object.entries(vectors.hmac)) {
    const message = key === 'vault_key' ? 'vault:v1' : key.slice('context_'.length);
    assert.equal(hmac(seed, message).toString('base64'), expected, message);
  }
});

test('a server identity is scoped to host and server', () => {
  const v = vectors.server_identity;
  const identity = deriveServerIdentity(seed, v.host, v.server_id);
  assert.equal(identity.publicKey.toString('base64'), v.public_key_base64);
  assert.equal(identity.stableId, v.stable_id);
});

test('the base58 address SIWS signs is the same key', () => {
  const v = vectors.server_identity;
  const identity = deriveServerIdentity(seed, v.host, v.server_id);
  assert.equal(toBase58(identity.publicKey), v.public_key_base58);
});

test('the central identity has no server in its scope', () => {
  const v = vectors.central_identity;
  const identity = deriveServerIdentity(seed, v.host);
  assert.equal(identity.publicKey.toString('base64'), v.public_key_base64);
  assert.equal(identity.stableId, v.stable_id);
});

test('the signed payload, both shapes', () => {
  const v = vectors.signed_payload;
  assert.equal(
    signedPayload('aaaa1111-0000-4000-8000-000000000001', 3, 'bm9uY2U=', 'Y2lwaGVy'),
    v.channel,
  );
  // Version 0 and an empty nonce leave two colons together. Dropping the empty
  // field is the mistake that produces a signature nothing verifies.
  assert.equal(
    signedPayload('aaaa1111-0000-4000-8000-000000000001', 0, '', '/echo hello'),
    v.bot_plaintext,
  );
  assert.match(v.bot_plaintext, /:0::/);
});

test('a DM context is sorted, so both sides derive the same one', () => {
  const a = '00000000-0000-4000-8000-000000000001';
  const b = 'ffffffff-0000-4000-8000-000000000002';
  assert.equal(conversationContext(a, b), vectors.signed_payload.dm_context);
  assert.equal(conversationContext(b, a), vectors.signed_payload.dm_context);
});

test('a signature Dart produced, byte for byte', () => {
  // Ed25519 is deterministic, so this one line proves the ladder and the
  // payload construction at once: get either wrong and the bytes differ.
  const v = vectors.server_identity;
  const identity = deriveServerIdentity(seed, v.host, v.server_id);
  assert.equal(
    sign(vectors.signed_payload.channel, identity.privateKey),
    vectors.signature.base64,
  );
});

test('and this implementation can verify it', () => {
  // The half a bot's readers run. An implementation that only signed correctly
  // would produce messages nobody could read, which is the same as producing
  // none.
  const v = vectors.server_identity;
  const identity = deriveServerIdentity(seed, v.host, v.server_id);
  const spki = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    identity.publicKey,
  ]);
  const publicKey = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  assert.ok(
    verify(
      null,
      Buffer.from(vectors.signed_payload.channel, 'utf8'),
      publicKey,
      Buffer.from(vectors.signature.base64, 'base64'),
    ),
  );
});
