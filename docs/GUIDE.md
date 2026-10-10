# The bot guide

Everything about writing a Rift bot with this package, past the
[README](../README.md)'s first example. The exact formats are in
[`WIRE.md`](../WIRE.md).

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
    { name: 'play', description: 'Play something', usage: '<url>', summon: true },
    { name: 'stop', description: 'Stop the track, stay in the call' },
    { name: 'disconnect', description: 'Stop and leave the call', dismiss: true },
  ],
});

const [summon] = await bot.summons();          // newest first
if (summon) await bot.joinVoice(summon.channelId);
```

Rift knows none of those verb names. `summon` and `dismiss` are what **you**
say a command means, and the client acts on them — which is why `stop` and
`disconnect` are two commands rather than one. Ending a track and leaving the
room are different things to want, and a bot with neither flag is simply never
summoned by typing.

`summons()` is the only source that works for a **private** voice channel — the
bot is not in the roster there either. Call `bot.dismissSelf(channelId)` when
you leave: it drops the summon and the media key together, so members stop
seeing the bot listed as in the call.

`dismiss: true` is a backstop as much as a convenience: the client drops the
summon whether or not your bot is still running, so a crashed one still loses
its key and its connection. It lands after the message, so a bot that *is*
running still gets to edit its panel and say it stopped — call
`bot.dismissSelf(channelId)` there and tidy up properly.

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

A panel can show a picture, but never from a URL: upload it, and put the block
you get back where it goes.

```ts
const cover = await bot.uploadImage(channelId, readFileSync('cover.jpg'), {
  alt: 'Album cover',
});
await bot.editPanel(channelId, id, [{ type: 'heading', text: 'Now playing' }, cover]);
// Moving on to the next track: show the new cover, then delete the old file.
await bot.deleteImage(cover.path);
```

The picture goes to the server's own storage, under the channel, **unencrypted**
— the server can see it, as it can see the panel. Only members who can see the
channel can fetch it, and Rift draws it only in a panel in that channel. PNG,
JPEG, WebP or GIF; the size is read from the file so the panel keeps its height
while it loads. It needs `ATTACH_FILES` and counts against the server's storage,
so delete a picture once no panel shows it.

The vocabulary is fixed and versioned — see `../WIRE.md` §5. A block type this
client's Rift does not know is **not drawn**, which is the safety property
rather than a limitation: a bot never controls a pixel, only a structure.

## Checked against the other implementation

```bash
npm test
```

`test/wire.test.ts` verifies this package against `test/wire_vectors.json`.
This package reproduces one of Rift's signatures byte for byte, derives the same
DM key, and opens a blob it sealed. Neither codebase reads the other; they meet
at one JSON file, which is the only arrangement in which "they agree" means
anything.

There was a Dart bot SDK too, and it is gone (BOTS.md §10) — it could never
publish audio, and it fell a feature behind every time this one gained something.
The second implementation that matters is the app itself, and it is still there.

That matters more than it sounds. A payload that differs by one character
stores fine, verifies as false, and renders as nothing: the bot watches it send
and nobody ever sees it. That failure is invisible in both codebases and
obvious in a vector.

## The contract

Two files here are **vendored from the Rift app repository** and must not be
edited in place:

| File | Generated by | Owns |
|---|---|---|
| `test/wire_vectors.json` | `tool/gen_wire_vectors.dart` | the numbers |
| `WIRE.md` | written by hand | the formats |

`rift_crypto` is the reference implementation. Its generator writes both this
copy and the app's, in one run, so the two cannot be refreshed apart — which is
the whole point, because a vendored copy that could go stale would let this
package pass its tests against a contract nobody uses any more.

`WIRE.md` is the complete specification a second implementation has to match.
`BOTS.md` and `ARCHITECTURE.md` are referenced throughout the source for the
*reasoning* behind a rule; both live in the Rift app repository, and neither is
needed to write a bot.

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

**Playing music, say so:** `voice.play(pcm, { quality: 'music' })`. The default
is LiveKit's, made for a voice — about 32 kbps and DTX, which sends next to
nothing while it is quiet — and a song played through it came out dull and
smeared. `music` is 128 kbps with DTX off. It is still sent mono, and Rift's
desktop clients play everything mono and nothing much above 16 kHz (see the
app's ARCHITECTURE.md, *How a call is played out on the desktop*), so that is
the ceiling a listener hears whatever is sent.

`voice.stats()` hands back WebRTC's own figures for the connection — what is
actually going out, at what bitrate, with which codec settings. Look there
before guessing at settings when something sounds wrong.

**The room can end without the bot being told why.** A member's client acts on a
`dismiss: true` command by dropping the summon, and the server takes the bot out
of the room — in a private channel before the bot could even look the channel up.
`voice.closed` settles whenever the bot is out, by `leave()` or not, and
`voice.connected` says the same thing now. A closed connection cannot play again:
drop it, stop what was feeding it, and `joinVoice` afresh next time, as the
example does.

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
a plain `npm install` is enough to run `music_bot.ts`. (Running
`npm install @livekit/rtc-node` *here* does nothing: npm will not install a
package the root declares as an optional peer of itself.)

Decoding is yours. This package publishes PCM and has no opinion about codecs,
which is what keeps "a URL" an `ffmpeg` flag rather than a dependency tree.

## How a bot hears the server

`listen` holds one connection to the server's Realtime and joins the bot's own
topic, `user:<bot id>`, which nobody else may join. The database announces what
the bot may hear there: a message addressed to it, a button press, a DM, and
anything written in a channel it has been **granted**. Nothing else reaches it,
and what does is only ids — every read still goes through the same queries and
the same policies, so a broadcast can never widen what a bot sees.

A slow poll runs behind that, every 30 seconds by default (`pollMs`), and it is
the backstop rather than the delivery: a broadcast is best-effort, and a bot
that missed one and waited for the next would have stopped working without
saying so. `new Bot(session, 2000, { realtime: false })` goes back to polling
alone.

A session lasts an hour. The poll signs in again when one of its reads comes
back 401, and tells the socket the new token. A call of your own can get there
first — a panel redraw an hour into a playlist — so catch a `BotError` with
`status === 401`, call `bot.renewSession()`, and try once more. Calling
`session.login()` instead leaves the socket on the old token, and the bot drops
back to polling without a word.

Replies, panels and DMs need no announcement of their own — the database makes
it when the row is written, which is also why a bot's answers now appear for
members who have the channel open even when the bot writes them through the
REST API.

## Letting people find it

A finished bot can be listed in the central directory, which is where a
server admin browses from **Manage server → Bots → Browse bots**. Listing is
in the app, under **List a bot** in that same browser: a name, a description,
tags, and a link to the source. Ten per account, delistable, withdrawable.

Nothing is verified, and the listing carries no invite — a bot has no address
for one to point at. Adding your bot is the *admin's* server minting a
single-use invite marked `is_bot` and handing the string to whoever runs the
program, which is exactly the `BotSession.join` at the top of this file.
Central never hears that it happened.

So the only thing on a listing anybody can check is the source link, and the
directory ranks on likes rather than installs for the same reason: an install
happens entirely on somebody else's server.

Publish `manifest` from the running bot and the listing can carry a copy, so
the browser shows your commands and your data-use sentence *before* somebody
installs — which is the one moment that sentence is still a decision.

## What this package does not do yet

- **Hearing a call.** The grant exists and the token honours it, but this
  package has no `onAudio`: a granted bot connects and subscribes, and reading
  the frames is `@livekit/rtc-node`'s API directly for now.
- **Surviving a key rotation mid-call.** Removing somebody from a channel
  rotates its key, and the bot's key is derived from it. This package sets the
  key once, when it joins, and does not yet fetch the new one — so a bot that
  was speaking when a rotation happened goes inaudible. Leave and `joinVoice`
  again, which fetches the new key. (The slot does not move: a bot always
  encrypts in slot 0, see WIRE.md §6, so re-keying is a `setSharedKey` away.)
- **Attachments.** A bot's reply is text or a panel, in a channel or a DM. A
  panel can show a picture (`uploadImage`), but a bot cannot attach a file to a
  message.
- **Speaking in a private channel it only *reads*.** A grant is read access; a
  seat is what lets a bot post. Give it a role with `channel_role_access` if it
  needs to answer in there.
