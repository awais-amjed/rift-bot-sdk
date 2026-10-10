import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSuggestions, parseSuggestRequest, suggestionsPayload } from '../src/suggest.ts';

const from = '11111111-2222-3333-4444-555555555555';
const channel = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const good = { v: 1, id: 'k3J9xQ2mPq', from, channel, command: 'play', text: 'thats so tr' };

test('a well-formed request is read as sent', () => {
  assert.deepEqual(parseSuggestRequest(good), {
    id: 'k3J9xQ2mPq',
    from,
    channelId: channel,
    command: 'play',
    text: 'thats so tr',
  });
});

test('anything malformed is no request at all', () => {
  for (const bad of [
    { ...good, v: 2 },
    { ...good, id: 'short' },
    { ...good, id: 'has spaces in it' },
    { ...good, from: 'not-a-uuid' },
    { ...good, channel: 42 },
    { ...good, command: 'Play' },
    { ...good, command: '' },
    { ...good, text: 'x'.repeat(201) },
    { ...good, text: undefined },
  ]) {
    assert.equal(parseSuggestRequest(bad as Record<string, unknown>), null, JSON.stringify(bad));
  }
});

test('the answer keeps ten rows, drops the unsendable, and shortens a long label', () => {
  const many = Array.from({ length: 14 }, (_, i) => ({ label: `Song ${i}`, value: `v${i}` }));
  assert.equal(cleanSuggestions(many).length, 10);
  const cleaned = cleanSuggestions([
    { label: '', value: 'x' },
    { label: 'Two lines', value: 'a\nb' },
    { label: 'Too long a value', value: 'v'.repeat(501) },
    { label: 'L'.repeat(150), value: 'ok' },
  ]);
  assert.equal(cleaned.length, 1);
  assert.equal(cleaned[0].label.length, 100);
  assert.ok(cleaned[0].label.endsWith('…'));
  assert.equal(cleaned[0].value, 'ok');
});

test('the answer echoes the request id, so only the asker takes it', () => {
  const request = parseSuggestRequest(good)!;
  assert.deepEqual(suggestionsPayload(request, 'bot-id', [{ label: 'A', value: 'a' }]), {
    v: 1,
    id: 'k3J9xQ2mPq',
    bot: 'bot-id',
    items: [{ label: 'A', value: 'a' }],
  });
});
