// A bot that answers its DMs.
//
//   node example/dm_bot.ts <url> <anonKey> <serverId> <seedFile>
//
// The only place a bot does real chat crypto. Everything it writes in a channel
// is signed but not sealed — a bot never holds a channel key — but a DM is
// sealed to the two of you, and the server cannot read it any more than the
// other members can (BOTS.md §3).
//
// The key is not stored or sent anywhere: both ends derive the same bytes from
// opposite halves of an X25519 exchange, so the only thing that had to be
// published is a public key.
import { readFileSync } from 'node:fs';
import { Bot, BotSession } from '../src/index.ts';

const [url, anonKey, serverId, seedFile] = process.argv.slice(2);

const session = new BotSession(
  url,
  anonKey,
  serverId,
  Buffer.from(readFileSync(seedFile, 'utf8').trim(), 'base64'),
);
const bot = new Bot(session);

bot.onDirectMessage(async (dm) => {
  // `dm.text` is already opened and its signature already checked — a row that
  // failed either never reaches here, because a bot acting on a message that is
  // not from who it claims is the whole attack.
  if (dm.text.trim().toLowerCase() === 'ping') {
    await bot.dms.reply(dm, 'pong');
    return;
  }
  await bot.dms.reply(dm, `You said: ${dm.text}`);
});

// The channel handler is still required — `listen` drives both from one tick,
// so a slow DM cannot let two channel polls overlap.
await bot.listen(async () => {});
console.log('answering DMs. ctrl-c to stop.');
