# @rift/bot

Write a bot for [Rift](https://joinrift.app) in TypeScript: commands, replies,
live panels, DMs, and voice, against any self-hosted Rift server.

A bot is an ordinary member whose identity lives in a file instead of a phone.
It signs in the same way, sits under the same permissions, and can never read
more than it has been granted. Channels stay end-to-end encrypted; a bot only
reads a channel if an admin hands it that channel's key.

> Not on npm yet (0.1.0): clone this repository and import from
> `src/index.ts`.

## Quick start

Node 22 or newer runs TypeScript directly, so there is nothing to build and,
for a text bot, nothing to install.

```ts
import { Bot, BotSession, args, command } from './src/index.ts';

// First run: join with a bot invite from the server's admin.
const session = await BotSession.join({ invite, seed, username: 'echo' });
console.log('save this:', session.config);

// Every run after: build the session from the saved config.
// const session = new BotSession(url, anonKey, serverId, seed);

const bot = new Bot(session);
await bot.listen(async (message) => {
  if (command(message) === 'echo') await bot.reply(message, args(message));
});
```

`seed` is 32 random bytes and **is the bot** — whoever holds it can act as it,
so keep it out of version control. An invite is spent once used, so save
`session.config` beside the seed.

The examples run as-is:

```bash
node example/echo_bot.ts <url> <anonKey> <serverId> <seedFile>
```

| Example | Shows |
|---|---|
| [`example/join.ts`](example/join.ts) | joining a server with an invite, once |
| [`example/echo_bot.ts`](example/echo_bot.ts) | a command bot, in about thirty lines |
| [`example/panel_bot.ts`](example/panel_bot.ts) | a poll on a panel that redraws itself |
| [`example/dm_bot.ts`](example/dm_bot.ts) | answering direct messages |
| [`example/music_bot.ts`](example/music_bot.ts) | joining a call and playing into it |
| [`example/watch_bot.ts`](example/watch_bot.ts) | reading a channel it has been granted |

Voice needs one optional dependency, loaded only when a bot joins a call:

```bash
npm install @livekit/rtc-node
```

## What a bot can do

- **Commands** — `/name args`, offered to members as they type
- **Replies** — public, or visible only to whoever asked
- **Panels** — a message the bot keeps redrawing, with buttons, menus and pictures
- **DMs** — conversations with members, private from the server too
- **Reading a channel** — only one an admin has granted it
- **Voice** — speak into a call; hear one only if an admin allows it

What it can't do yet — hear a call through this package's own API, survive a
key rotation mid-call, send attachments — is listed in the
[guide](docs/GUIDE.md#what-this-package-does-not-do-yet).

## Documentation

| Document | For |
|---|---|
| [`docs/GUIDE.md`](docs/GUIDE.md) | everything past the first example: identity, hearing, summons, replies, panels, DMs, voice, being listed |
| [`WIRE.md`](WIRE.md) | the exact formats this package implements — the specification for any other implementation |

## Tests

```bash
npm test
```

Includes `test/wire.test.ts`, which checks this package byte for byte against
test vectors generated from the Rift app's own crypto — the two implementations
never read each other's code, so agreeing on the vectors is what "compatible"
means.

## Related repositories

| Repository | What it is |
|---|---|
| [`rift`](https://github.com/awais-amjed/rift) | the app — Flutter client for desktop, mobile and web |
| [`rift-self-host`](https://github.com/awais-amjed/rift-self-host) | a server anyone can run — where a bot lives |
| **`rift-bot-sdk`** | this: the TypeScript SDK for building bots |

## License

[Apache-2.0](LICENSE).
