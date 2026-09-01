// A music bot: `/play <url>` joins the voice channel you are in and plays it,
// with a panel to stop it. Roughly the thing people ask for first, and the
// reason `joinVoice` exists.
//
//   npm install @livekit/rtc-node          # voice is an optional peer
//   node example/music_bot.ts <url> <anonKey> <serverId> <seedFile>
//
// Needs `ffmpeg` on PATH. This package has no opinion about codecs — it
// publishes signed 16-bit PCM, and turning "a URL" into that is one of the
// things ffmpeg has been good at for twenty years.
//
// The bot hears nothing while it does this, and needs no grant to do it.
// Publishing is the half that was never the problem: a bot that could listen
// to a room full of people is the half an admin has to allow, per channel.
import { readFileSync } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  Bot,
  BotSession,
  CHANNELS,
  SAMPLE_RATE,
  args,
  command,
  isAction,
  type BotMessage,
  type VoiceConnection,
} from '../src/index.ts';

const [url, anonKey, serverId, seedFile] = process.argv.slice(2);

const session = new BotSession(
  url,
  anonKey,
  serverId,
  Buffer.from(readFileSync(seedFile, 'utf8').trim(), 'base64'),
);
const bot = new Bot(session);

interface Playing {
  voice: VoiceConnection;
  ffmpeg: ChildProcessWithoutNullStreams;
  panelId: number | null;
  textChannel: string;
}

// One track at a time, per voice channel. In memory, so a restart forgets —
// this is an example of the shape, not of how to keep state.
const playing = new Map<string, Playing>();

/** Decode anything ffmpeg understands into what LiveKit wants. */
function decode(source: string): ChildProcessWithoutNullStreams {
  return spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', source,
    '-f', 's16le',
    '-ar', String(SAMPLE_RATE),
    '-ac', String(CHANNELS),
    // `-` is stdout, which `play` consumes as an async iterable of Buffers.
    'pipe:1',
  ]);
}

/** Which voice channel somebody is in, from the roster LiveKit answers. */
async function voiceChannelOf(userId: string): Promise<string | null> {
  const data = await session.callFunction('voice_roster', {});
  return (data.roster as Record<string, string>)[userId] ?? null;
}

async function stop(channelId: string): Promise<void> {
  const current = playing.get(channelId);
  if (!current) return;
  playing.delete(channelId);
  current.ffmpeg.kill('SIGKILL');
  await current.voice.leave();
  if (current.panelId !== null) {
    await bot.editPanel(current.textChannel, current.panelId, [
      { type: 'heading', text: 'Stopped' },
    ]);
  }
}

async function play(message: BotMessage, source: string): Promise<void> {
  const voiceChannel = await voiceChannelOf(message.senderId);
  if (!voiceChannel) {
    await bot.replyPrivately(message, 'Join a voice channel first.');
    return;
  }
  await stop(voiceChannel);

  const voice = await bot.joinVoice(voiceChannel);
  const ffmpeg = decode(source);

  const panelId = await bot.panel(message.channelId, [
    { type: 'heading', text: 'Now playing' },
    { type: 'text', text: source },
    { type: 'actions', items: [{ label: 'Stop', action: 'stop', style: 'danger' }] },
  ]);

  playing.set(voiceChannel, { voice, ffmpeg, panelId, textChannel: message.channelId });

  // Deliberately not awaited: `play` resolves when the track ends, and the
  // handler has to return so the next command is answered while this one is
  // still going.
  void voice
    .play(ffmpeg.stdout)
    .catch((error) => console.error('playback failed:', error))
    .finally(() => {
      // Only tidy up if this is still the track that is playing — a `/play`
      // that replaced it has already left and started its own.
      if (playing.get(voiceChannel)?.voice === voice) void stop(voiceChannel);
    });
}

await bot.listen(async (message) => {
  if (isAction(message)) {
    if (message.actionId !== 'stop') return;
    for (const [channelId, current] of playing) {
      if (current.panelId === message.panelId) await stop(channelId);
    }
    return;
  }

  switch (command(message)) {
    case 'play': {
      const source = args(message);
      if (!source) {
        await bot.replyPrivately(message, 'Usage: /play <url>');
        return;
      }
      await play(message, source);
      return;
    }
    case 'stop': {
      const voiceChannel = await voiceChannelOf(message.senderId);
      if (voiceChannel) await stop(voiceChannel);
      return;
    }
  }
});

console.log('playing. ctrl-c to stop.');
