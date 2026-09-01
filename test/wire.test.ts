import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac, createPublicKey, verify } from 'node:crypto';

import {
  conversationContext,
  deriveServerIdentity,
  hmac,
  sign,
  signedPayload,
  toBase58,
  verifySignature,
} from '../src/crypto.ts';
import { decodeBody, deriveDmKey, encodeBody } from '../src/dm.ts';
import { parseInvite } from '../src/invite.ts';
import { deriveChatIdentity, unwrapKey } from '../src/sealed.ts';

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

/// `wrap:v1` — the format a member seals a bot's media key in.
///
/// Both halves of this are new territory for this package: it had no X25519 and
/// no AES-GCM at all until a bot needed to open something. Which makes it
/// exactly the kind of second implementation the vectors exist for — the two
/// codebases share no code and meet at one JSON file, and a port that decoded
/// the doubled base64 once, or read the GCM tag from the wrong end, would fail
/// here and nowhere else.

test('a bot opens what a member sealed for it', () => {
  const identity = deriveChatIdentity(seed, vectors.chat_identity.host);
  // Same X25519 public key the Dart side derived, or nothing below can work.
  assert.equal(
    identity.publicKey.toString('base64'),
    vectors.chat_identity.public_key_base64,
  );

  const opened = unwrapKey(identity, vectors.wrapped_key);
  assert.equal(opened.toString('base64'), vectors.wrapped_key.key_base64);
});

test('tampering with the sealed bytes is caught, not silently opened', () => {
  const identity = deriveChatIdentity(seed, vectors.chat_identity.host);
  const bad = Buffer.from(vectors.wrapped_key.ciphertext, 'base64');
  bad[0] ^= 0xff;
  assert.throws(() =>
    unwrapKey(identity, {
      ...vectors.wrapped_key,
      ciphertext: bad.toString('base64'),
    }),
  );
});

test('the key a bot speaks with is a one-way function of the channel key', () => {
  // Members derive this and hear the bot; the bot is given only the result and
  // cannot invert it to reach the channel key. That asymmetry is the whole of
  // "publishes but does not listen" (BOTS.md §6b).
  const channelKey = Buffer.from(vectors.wrapped_key.key_base64, 'base64');
  const derived = createHmac('sha256', channelKey)
    .update(`voicebot:v1:${vectors.bot_voice_key.bot_id}`, 'utf8')
    .digest();
  assert.equal(derived.toString('base64'), vectors.bot_voice_key.key_base64);
  assert.notEqual(derived.toString('base64'), vectors.wrapped_key.key_base64);
});

/// `dm:v1` — the key a bot shares with one person and nobody else.
///
/// Derived rather than distributed: both ends compute it from opposite halves
/// of an X25519 exchange, so there is nothing for the server to hold and
/// nothing to go wrong in delivery. Which also means the two implementations
/// have to agree exactly, with no round trip to notice a disagreement on.

test('a bot derives the same DM key the app does', () => {
  const identity = deriveChatIdentity(seed, vectors.chat_identity.host);
  const key = deriveDmKey(identity, vectors.dm_key.peer_chat_public_key);
  assert.equal(key.toString('base64'), vectors.dm_key.key_base64);
});

test('a DM key is not the chat identity it came from', () => {
  const identity = deriveChatIdentity(seed, vectors.chat_identity.host);
  const key = deriveDmKey(identity, vectors.dm_key.peer_chat_public_key);
  assert.notEqual(key.toString('base64'), vectors.chat_identity.public_key_base64);
});

test('a different peer is a different conversation', () => {
  // Two people DMing the same bot must not be able to read each other, which
  // falls out of the exchange rather than being enforced anywhere.
  const identity = deriveChatIdentity(seed, vectors.chat_identity.host);
  const other = deriveChatIdentity(Buffer.alloc(32, 9), vectors.chat_identity.host);
  assert.notEqual(
    deriveDmKey(identity, vectors.dm_key.peer_chat_public_key).toString('base64'),
    deriveDmKey(identity, other.publicKey.toString('base64')).toString('base64'),
  );
});

test('a body round-trips, and a bare string is its own text', () => {
  // Anything that is not the tagged object predates the shape, so it has to
  // come back verbatim rather than throwing.
  assert.equal(decodeBody(encodeBody('hello')), 'hello');
  assert.equal(decodeBody('just text'), 'just text');
  assert.equal(decodeBody('{"not":"ours"}'), '{"not":"ours"}');
});

test('a signature verifies, and one bit off does not', () => {
  const identity = deriveServerIdentity(
    seed,
    vectors.server_identity.host,
    vectors.server_identity.server_id,
  );
  const payload = vectors.signed_payload.channel;
  assert.ok(verifySignature(payload, vectors.signature.base64, identity.publicKey));
  assert.ok(!verifySignature(payload + 'x', vectors.signature.base64, identity.publicKey));
});

/// An invite link, which is the one string an admin hands a bot.
///
/// Not crypto, but a format two implementations have to read the same way —
/// and the failure is the quiet kind: a bot that cannot join a server whose
/// invite works for everybody else. These are the three shapes
/// `lib/data/invite_link.dart` builds.

test('the plain form', () => {
  const invite = parseInvite('http://localhost:8000#abc123');
  assert.equal(invite?.serverUrl, 'http://localhost:8000');
  assert.equal(invite?.inviteCode, 'abc123');
});

test('the app-scheme form keeps the wrapper off the server URL', () => {
  // Split on the last `#` alone and the code comes off correctly while
  // `rift://join#http://...` stays glued together as the "URL".
  const invite = parseInvite('rift://join#http://localhost:8000#abc123');
  assert.equal(invite?.serverUrl, 'http://localhost:8000');
  assert.equal(invite?.inviteCode, 'abc123');
});

test('the clickable form', () => {
  const invite = parseInvite('https://joinrift.app/join#https://x.supabase.co#dead99');
  assert.equal(invite?.serverUrl, 'https://x.supabase.co');
  assert.equal(invite?.inviteCode, 'dead99');
});

test('a trailing slash on the server URL is dropped', () => {
  // The app trims it when building; an invite typed by hand may not have been.
  assert.equal(parseInvite('http://localhost:8000/#abc')?.serverUrl, 'http://localhost:8000');
});

test('anything that is not a complete pair is not an invite', () => {
  for (const input of ['', 'http://localhost:8000', '#abc', '   ']) {
    assert.equal(parseInvite(input), null, `"${input}" parsed as an invite`);
  }
});
