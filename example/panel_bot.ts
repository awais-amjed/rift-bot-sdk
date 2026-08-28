// A bot with a panel: `/poll <question>` posts one, and pressing a button
// redraws it in place rather than posting a new line. Which is the point — a
// poll that announced every vote as a message would be the log a panel exists
// to replace.
//
//   node example/panel_bot.ts <url> <anonKey> <serverId> <seedFile>
import { readFileSync } from 'node:fs';
import { Bot, BotSession, args, command, isAction, type PanelBlock } from '../src/index.ts';

const [url, anonKey, serverId, seedFile] = process.argv.slice(2);

const session = new BotSession(
  url,
  anonKey,
  serverId,
  Buffer.from(readFileSync(seedFile, 'utf8').trim(), 'base64'),
);
const bot = new Bot(session);

interface Poll {
  question: string;
  yes: number;
  no: number;
}

// Panel id → its tallies. In memory, so a restart forgets: this is an example
// of the shape, not of how to keep state.
const polls = new Map<number, Poll>();

function draw(poll: Poll): PanelBlock[] {
  const total = poll.yes + poll.no;
  return [
    { type: 'heading', text: poll.question },
    {
      type: 'fields',
      items: [
        { label: 'Yes', value: String(poll.yes) },
        { label: 'No', value: String(poll.no) },
      ],
    },
    {
      type: 'progress',
      value: total === 0 ? 0 : poll.yes / total,
      text: total === 1 ? '1 vote' : `${total} votes`,
    },
    {
      type: 'actions',
      items: [
        { label: 'Yes', action: 'yes', style: 'primary' },
        { label: 'No', action: 'no' },
      ],
    },
  ];
}

await session.login();
await session.publishManifest({
  description: 'Runs a poll on a panel',
  commands: [{ name: 'poll', description: 'Start a poll', usage: '/poll <question>' }],
});

await bot.listen(async (message) => {
  // A press, not a command. `panelId` is the panel it came from, which is the
  // row to redraw.
  if (isAction(message)) {
    const id = message.panelId;
    const poll = id === undefined ? undefined : polls.get(id);
    if (!poll || id === undefined) return;

    if (message.actionId === 'yes') poll.yes += 1;
    else poll.no += 1;
    await bot.editPanel(message.channelId, id, draw(poll));
    return;
  }

  if (command(message) !== 'poll') return;
  const poll: Poll = { question: args(message) || 'Yes or no?', yes: 0, no: 0 };
  const id = await bot.panel(message.channelId, draw(poll));
  if (id !== null) polls.set(id, poll);
});

console.log('panel bot listening');
