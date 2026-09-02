# @rift/bot

Write a Rift bot in TypeScript.

```ts
import { Bot, BotSession, args, command } from '@rift/bot';

// First run: the same invite link an admin would send a person.
const session = await BotSession.join({ invite, seed, username: 'echo' });
console.log('save this:', session.config);

// Every run after: what `config` gave you.
// const session = new BotSession(url, anonKey, serverId, seed);

const bot = new Bot(session);
await bot.listen(async (message) => {
  if (command(message) === 'echo') await bot.reply(message, args(message));
});
```

`BotSession.join` claims the invite, derives the identity scoped to that server,
signs in, and comes back a member — one paste, the same link a person would get.
An invite is spent, so save `session.config` next to the seed and construct a
session directly on every later run.

`example/echo_bot.ts` is a complete one in about thirty lines;
`example/panel_bot.ts` runs a poll on a panel; `example/music_bot.ts` plays into
a call.

## No build step, and nothing to install for a text bot

```bash
node example/echo_bot.ts <url> <anonKey> <serverId> <seedFile>
```

Node runs TypeScript directly by stripping types, so there is nothing to
compile. And a bot needs exactly four primitives — HMAC-SHA256, an Ed25519
keypair from a seed, one signature, and base64 — all of which `node:crypto` has
had for years.

There is **no Argon2id here at all**, and no X25519 or AES-GCM outside
`src/sealed.ts`: a bot never holds a channel key, so the only thing it ever
opens is the one key a member seals for it — its own media key for an encrypted
call. Everything else is `src/crypto.ts`, about a hundred lines.

The one piece of TypeScript this package avoids is a constructor parameter
property, which is the only syntax that needs code generation rather than
erasure. Buildless is worth four extra lines.

Voice is the single exception, and it is arranged so it stays one: the media
library is an optional peer imported inside `joinVoice`, so a bot that never
calls it never loads it and never installs it.

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
mentions it, not the rest of the channel it is sitting in. **And not a call it
is sitting in either** — see Voice.

That is not this package being careful. It is `messages_select`:

```sql
AND (NOT app.is_bot()
     OR to_bot = auth.uid()
     OR sender_id = auth.uid()
     OR app.bot_reads_version(channel_id, key_version))
```

A bug in your bot cannot widen it, and neither can a bug in this SDK. The
fourth line is the moderation grant, below.

The reason is that Rift channels are end-to-end encrypted and a bot can never
hold a channel key — a wrapped key *is* read access, it is arithmetic rather
than a rule, and unlike a rule it cannot be taken back. So a bot is not given
one, and the database refuses to record one for it even if every client asked.

The exception is a **moderation grant**: an admin can hand one bot the key to
one channel, from the next key version onward. The channel says so to everyone
in it for as long as it lasts.

```ts
const from = await bot.watchChannel(channelId, async (message) => {
  console.log(`${message.senderId}: ${message.text}`);
});
if (from === null) throw new Error('this bot was never granted that channel');
```

Call it before `listen`. **Check for null** — an ungranted bot polls forever and
receives nothing, which looks exactly like a quiet channel.

Three things it does that are easy to get wrong by hand:

- **Every signature is checked** before a message reaches your handler. A bot
  acting on a row that is not from who it claims is the whole attack.
- **It stops rather than skips** at a message whose key has not been sealed for
  this bot yet. A rotation is sealed by the next member to open the channel, so
  a version can exist for a moment before its key does — and a cursor that
  jumped that gap would drop exactly the stretch you were granted to see.
- **Nothing arrives from before the grant.** Not a policy you have to trust: the
  keys for it were never sealed to this bot.

Also absent: `key_version` 0 rows (webhook posts, system notices, commands to
other bots — never sealed, so no grant covers them), somebody else's ephemeral
reply, and another bot's button press.

A granted **private** channel is readable but not speakable: posting needs
`can_see_channel`, which a grant does not give. A role with
`channel_role_access` is what gets a bot in far enough to talk — the same door a
`/` command comes through.

## Being summoned into a call

A bot cannot see a voice channel it was not asked into, so `/play` needs
somewhere to go. Mark the command in your manifest and a member's client writes
the summon when they send it from inside a call:

```ts
await session.publishManifest({
  commands: [
    { name: 'play', description: 'Play something', usage: '<url>', voice: true },
    { name: 'stop', description: 'Stop playing' },
  ],
});

const [summon] = await bot.summons();          // newest first
if (summon) await bot.joinVoice(summon.channelId);
```

`summons()` is the only source that works for a **private** voice channel — the
bot is not in the roster there either. Call `bot.dismissSelf(channelId)` when
you leave: it drops the summon and the media key together, so members stop
seeing the bot listed as in the call.

A summon lets a bot **publish and nothing else**. Its token still carries
`canSubscribe: false` unless an admin granted listening, and its media key is
derived from the channel key rather than being it, so members hear the bot and
the bot hears nobody.

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
generated from Rift's own crypto (`rift_crypto/`, which is Dart) and checked
against it by `test/wire_test.dart`. This package reproduces one of its
signatures byte for byte, derives the same DM key, and opens a blob it sealed.
Neither codebase reads the other; they meet at one JSON file, which is the only
arrangement in which "they agree" means anything.

There was a Dart bot SDK too, and it is gone (BOTS.md §11) — it could never
publish audio, and it fell a feature behind every time this one gained something.
The second implementation that matters is the app itself, and it is still there.

That matters more than it sounds. A payload that differs by one character
stores fine, verifies as false, and renders as nothing: the bot watches it send
and nobody ever sees it. That failure is invisible in both codebases and
obvious in a vector.

## DMs

```ts
bot.onDirectMessage(async (dm) => {
  await bot.dms.reply(dm, `You said: ${dm.text}`);
});
await bot.listen(async () => {});   // one tick drives both
```

`example/dm_bot.ts` is the whole thing.

**A DM to a bot is private from the server too**, not just from every member —
it is sealed exactly like a DM between two people, and the bot is one of the two
ends. That makes it the only place a bot does real chat crypto: everything it
writes in a channel is signed but not sealed, because it holds no channel key.

The conversation key is derived, never distributed:

```
dmKey = HMAC-SHA256(X25519(myChatPrivate, theirChatPublic), "dm:v1")
```

Both ends compute the same bytes from opposite halves, so nothing is stored and
nothing is sent — the only thing published is a public key, which `listen` does
for you.

Incoming DMs are **opened and signature-checked before they reach your
handler**, and a row that fails either is dropped rather than passed on. A bot
acting on a message that is not from who it claims is the whole attack, and it
is not a decision worth leaving to each bot author.

## Voice

```ts
const voice = await bot.joinVoice(channelId);
await voice.play(ffmpeg.stdout);   // signed 16-bit PCM, 48kHz stereo
await voice.leave();
```

`example/music_bot.ts` is the whole thing: `/play <url>` joins the channel you
are in, decodes with `ffmpeg`, and puts a Stop button on a panel.

**Calls are end-to-end encrypted**, and a bot is audible and deaf at the same
time. Two things hold that, and only the second is arithmetic:

- its token is minted `canSubscribe: false`, and
- it is given a **different key** from the members:

```
memberKey = channelKey
botKey    = HMAC-SHA256(channelKey, "voicebot:v1:<botId>")
```

Members hold the channel key, derive the bot's, and hear it. The bot is sealed
only its own, and HMAC does not run backwards — so it cannot reach the channel
key and cannot decrypt a single member's audio. Two bots in one call cannot
decrypt each other either.

With one shared room key none of that is expressible: encrypting is what makes a
bot audible, and the key that encrypts also decrypts (BOTS.md §2). Two keys and
a one-way function are what buy it.

**A music bot needs no grant.** Speaking was never the half that had to be
allowed. A bot that genuinely needs to listen — transcription, an AI that answers
out loud — is granted the channel key itself by an admin, per voice channel, and
the channel shows a marker saying so. That is a key grant with everything §6 says
about one: it cannot be taken back, only rotated past. Check `voice.canHear`
rather than wondering why no audio arrives.

A member's client is what seals the key, so a bot cannot be the first thing in a
channel. Until somebody has been in it, `get_channel_token` says so rather than
letting the bot join and publish frames nobody can open.

### Installing it

Media is `@livekit/rtc-node`, an **optional peer dependency**, imported only by
`joinVoice`. A bot that answers `/echo` never loads a WebRTC stack.

```bash
npm install @livekit/rtc-node   # in *your* bot's package
```

Inside this repo it is already a devDependency, because the examples need it —
`npm install` in `bot_sdk_ts/` is enough to run `music_bot.ts`. (Running
`npm install @livekit/rtc-node` *here* does nothing: npm will not install a
package the root declares as an optional peer of itself.)

Decoding is yours. This package publishes PCM and has no opinion about codecs,
which is what keeps "a URL" an `ffmpeg` flag rather than a dependency tree.

## What this package does not do yet

- **Realtime for *reading*.** `listen` polls, every two seconds by default.
  Replies and panel redraws do ring the channel's doorbell, so they appear at
  once for anyone with the channel open. Polling has no reconnect logic to get
  wrong and spends nothing from the server's shared event budget (~100/second,
  which every member's unread badges also draw on).
- **Hearing a call.** The grant exists and the token honours it, but this
  package has no `onAudio`: a granted bot connects and subscribes, and reading
  the frames is `@livekit/rtc-node`'s API directly for now.
- **Surviving a key rotation mid-call.** Removing somebody from a channel
  rotates its key, which changes both the bot's derived key and the ring slot it
  belongs in. Rift's own clients move across without dropping the call; a bot
  cannot, because `@livekit/rtc-node`'s `FrameCryptor.setKeyIndex` sends a
  request with a required `track_sid` it never fills in and throws. Until that
  is fixed upstream, a bot that was speaking when a rotation happened goes
  inaudible: leave and `joinVoice` again, which fetches the new key.
- **Attachments.** A bot's reply is text or a panel, in a channel or a DM.
- **Speaking in a private channel it only *reads*.** A grant is read access; a
  seat is what lets a bot post. Give it a role with `channel_role_access` if it
  needs to answer in there.

