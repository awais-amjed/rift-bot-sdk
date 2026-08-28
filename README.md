# @rift/bot

Write a Rift bot in TypeScript.

```ts
import { Bot, BotSession, args, command } from '@rift/bot';

const session = new BotSession(url, anonKey, serverId, seed);
const bot = new Bot(session);

await session.login();
await bot.listen(async (message) => {
  if (command(message) === 'echo') await bot.reply(message, args(message));
});
```

`example/echo_bot.ts` is a complete one in about thirty lines;
`example/panel_bot.ts` runs a poll on a panel.

## No build step, no dependencies

```bash
node example/echo_bot.ts <url> <anonKey> <serverId> <seedFile>
```

Node runs TypeScript directly by stripping types, so there is nothing to
compile. And a bot needs exactly four primitives — HMAC-SHA256, an Ed25519
keypair from a seed, one signature, and base64 — all of which `node:crypto` has
had for years.

There is **no X25519, no AES-GCM and no Argon2id here at all**, and that is not
minimalism for its own sake: a bot never holds a channel key, so it never opens
anything. The whole of the crypto is `src/crypto.ts`, about a hundred lines.

The one piece of TypeScript this package avoids is a constructor parameter
property, which is the only syntax that needs code generation rather than
erasure. Buildless is worth four extra lines.

## What a bot is

**A user whose seed lives in a config file instead of on a phone.** Same
Sign-in-with-Solana login, same JWT, same row in `users`, same row-level
security. There is no bot API, no bot token format, and no second auth path —
a capability the app has, a bot has, under the same policies, so the two cannot
drift apart.

The seed is the whole identity. Treat it like an SSH key: 32 random bytes, kept
out of the repo, and whoever holds it *is* the bot. Nothing is ever sent to the
server except signatures.

Identity is derived per `(host, serverId)`, so one deployment across N servers
is N keypairs and N sessions. The same seed on two servers is two unrelated
bots, and neither server can correlate them.

## What a bot can hear

**Only what it is addressed.** Not the message before it, not the one that
mentions it, not the rest of the channel it is sitting in.

That is not this package being careful. It is `messages_select`:

```sql
AND (NOT app.is_bot() OR to_bot = auth.uid() OR sender_id = auth.uid())
```

A bug in your bot cannot widen it, and neither can a bug in this SDK.

The reason is that Rift channels are end-to-end encrypted and a bot can never
hold a channel key — a wrapped key *is* read access, it is arithmetic rather
than a rule, and unlike a rule it cannot be taken back. So a bot is not given
one, and the database refuses to record one for it even if every client asked.

The exception is a **moderation grant**: an admin can hand one bot the key to
one channel, from the next key version onward. The channel says so to everyone
in it for as long as it lasts.

## Replying

| Call | Who sees it | For |
|---|---|---|
| `bot.reply(m, text)` | everyone in the channel | genuinely public output |
| `bot.replyPrivately(m, text)` | only whoever asked | errors, confirmations |
| `bot.panel(channelId, blocks)` | everyone, and it can be redrawn | living state |

A private reply is private from the *channel*, not from the server: it is
stored unencrypted like everything else a bot touches, and enforced by RLS
rather than by clients agreeing to hide it.

## Panels

A panel is a message you keep editing. `bot.panel` returns its id; `editPanel`
redraws it in place, so a queue that changes is one row that changes rather than
forty rows saying what it changed to.

```ts
const id = await bot.panel(channelId, [
  { type: 'heading', text: 'Now playing' },
  { type: 'progress', value: 0.4, text: '1:24 / 3:31' },
  { type: 'actions', items: [{ label: 'Skip', action: 'skip' }] },
]);
```

A press arrives through the same `listen` callback with `isAction(message)`
true, `message.actionId` the button's own id, and `message.panelId` the panel to
redraw. It is **not a message**: nobody's channel shows it, no phone rings for
it, and it does not count as unread.

The vocabulary is fixed and versioned — see `../WIRE.md` §5. A block type this
client's Rift does not know is **not drawn**, which is the safety property
rather than a limitation: a bot never controls a pixel, only a structure.

## Checked against the other implementation

```bash
npm test
```

`test/wire.test.ts` verifies this package against `../test/wire_vectors.json` —
the same file the Dart implementation is checked against, including reproducing
one of its signatures byte for byte. Neither codebase reads the other; they meet
at one JSON file, which is the only arrangement in which "they agree" means
anything.

That matters more than it sounds. A payload that differs by one character
stores fine, verifies as false, and renders as nothing: the bot watches it send
and nobody ever sees it. That failure is invisible in both codebases and
obvious in a vector.

## What this package does not do yet

- **Realtime for *reading*.** `listen` polls, every two seconds by default.
  Replies and panel redraws do ring the channel's doorbell, so they appear at
  once for anyone with the channel open. Polling has no reconnect logic to get
  wrong and spends nothing from the server's shared event budget (~100/second,
  which every member's unread badges also draw on).
- **Voice.** A bot can already get a LiveKit token — `get_channel_token` does
  not special-case bots, and `voice_roster` reads participants by identity
  without asking what they are. What is missing is a wrapper, and the media
  itself is `@livekit/rtc-node`'s job rather than this package's: a text bot
  should not pay for a media dependency it never loads.
- **Attachments.** A bot's reply is text or a panel.
- **DMs.** A bot can be DM'd, and this SDK does not read them yet.
