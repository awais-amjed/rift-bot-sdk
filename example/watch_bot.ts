// A bot that reads a channel it was granted — the one exception in BOTS.md §6.
//
//   node example/watch_bot.ts <url> <anonKey> <serverId> <seedFile> <channelId>
//
// Everything else a bot does, it does because somebody addressed it: a command,
// a press on its own panel, a DM sealed to it. This is the one place a bot holds
// the channel key and reads a conversation nobody pointed at it, because a
// moderation bot cannot work any other way.
//
// It only works after an admin grants it, per channel, on purpose — and the
// channel says so in a message everybody in it can see. `watchChannel` returns
// null when there is no grant, which is worth handling: an ungranted bot polls
// forever and receives nothing, and that looks exactly like a quiet channel.
//
// What still never arrives: anything from before the grant, anything unsealed
// (webhook posts, system notices, other bots' commands), somebody else's
// ephemeral reply, and another bot's button press. None of that is this file
// being careful — `messages_select` decides, so nothing written here can widen
// it.
import { readFileSync } from 'node:fs';
import { Bot, BotSession } from '../src/index.ts';

const [url, anonKey, serverId, seedFile, channelId] = process.argv.slice(2);

const session = new BotSession(
  url,
  anonKey,
  serverId,
  Buffer.from(readFileSync(seedFile, 'utf8').trim(), 'base64'),
);
const bot = new Bot(session);

// A toy rule, and the shape a real one has: count what arrives, say something
// when a threshold trips. Posting rate is the moderation signal that needs no
// judgement about content.
const recent = new Map<string, number[]>();
const WINDOW_MS = 10_000;
const LIMIT = 5;

const granted = await bot.watchChannel(channelId, async (message) => {
  console.log(`[${message.sentAt}] ${message.senderId}: ${message.text}`);

  const now = Date.now();
  const times = (recent.get(message.senderId) ?? []).filter((t) => now - t < WINDOW_MS);
  times.push(now);
  recent.set(message.senderId, times);

  if (times.length === LIMIT) {
    // A bot writes in the clear even in a channel it can read, and that is not
    // an oversight: everything a bot says is signed but not sealed, so a member
    // can always tell which half of the room a message came from.
    await bot.post(channelId, `That is ${LIMIT} messages in ten seconds.`);
  }
});

if (granted === null) {
  console.error(
    `Not granted ${channelId}. An admin has to hand this bot the channel key ` +
      `before there is anything to read.`,
  );
  process.exit(1);
}
console.log(`Reading ${channelId} from key version ${granted}.`);

await bot.listen(async () => {
  // No commands in this example — the channel is what it watches.
});
