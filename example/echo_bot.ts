// A bot in about thirty lines.
//
//   node example/echo_bot.ts <url> <anonKey> <serverId> <seedFile>
import { readFileSync } from 'node:fs';
import { Bot, BotSession, args, command } from '../src/index.ts';

const [url, anonKey, serverId, seedFile] = process.argv.slice(2);

const session = new BotSession(
  url,
  anonKey,
  serverId,
  Buffer.from(readFileSync(seedFile, 'utf8').trim(), 'base64'),
);
const bot = new Bot(session);

await session.login();
await session.publishManifest({
  description: 'Says what you said',
  commands: [{ name: 'echo', description: 'Repeat something', usage: '/echo <text>' }],
});

await bot.listen(async (message) => {
  if (command(message) !== 'echo') return;
  const text = args(message);
  if (text) await bot.reply(message, text);
  else await bot.replyPrivately(message, 'Give me something to echo.');
});

console.log('echo bot listening');
