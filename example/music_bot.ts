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

/// The call itself, which outlives any one track: `/stop` ends what is playing
/// and stays, `/disconnect` is what leaves.
const connections = new Map<string, VoiceConnection>();

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

/**
 * Where to play — the summon first, the roster second.
 *
 * A summon is written by the caller's own client when they send a command this
 * bot's manifest marked `summon: true`, and it is the only source that works for
 * a **private** voice channel: a bot cannot see one, so it is not in the roster
 * either. The roster is the fallback for a bot with no manifest, or a caller
 * whose client is older than summoning.
 */
async function voiceChannelOf(userId: string): Promise<string | null> {
  const summoned = await bot.summons();
  if (summoned.length > 0) {
    const mine = summoned.find((s) => s.summonedBy === userId);
    if (mine) return mine.channelId;
  }
  const data = await session.callFunction('voice_roster', {});
  return (data.roster as Record<string, string>)[userId] ?? null;
}

/**
 * End the track. **Stays in the call**, ready for the next one.
 *
 * Two different things people mean by "stop", and running them together is the
 * mistake: somebody who wanted quiet for a minute should not have to summon the
 * bot back. Leaving is [disconnect].
 */
async function stopPlaying(channelId: string): Promise<void> {
  const current = playing.get(channelId);
  if (!current) return;
  playing.delete(channelId);
  current.ffmpeg.kill('SIGKILL');
  current.voice.stop();
  if (current.panelId !== null) {
    await bot.editPanel(current.textChannel, current.panelId, [
      { type: 'heading', text: 'Stopped' },
    ]);
  }
}

/**
 * End the track and leave.
 *
 * `dismissSelf` gives the welcome back with the connection: dropping the summon
 * drops the media key too, so the bot stops being able to *arrive* rather than
 * merely stopping, and members stop seeing it listed as in the call. A client
 * sending a command marked `dismiss: true` does the same thing from its end, so
 * this still happens for a bot that has crashed — but a bot that is running
 * should tidy up after itself rather than wait to be removed.
 */
async function disconnect(channelId: string): Promise<void> {
  const current = playing.get(channelId);
  await stopPlaying(channelId);
  await current?.voice.leave();
  await connections.get(channelId)?.leave();
  connections.delete(channelId);
  await bot.dismissSelf(channelId);
}

async function play(message: BotMessage, source: string): Promise<void> {
  const voiceChannel = await voiceChannelOf(message.senderId);
  if (!voiceChannel) {
    await bot.replyPrivately(message, 'Join a voice channel first.');
    return;
  }
  await stopPlaying(voiceChannel);

  // Joined once and kept. Leaving between tracks would mean a fresh token, a
  // fresh key fetch and a participant that flickers in and out of the room for
  // everybody watching.
  let voice = connections.get(voiceChannel);
  if (!voice) {
    voice = await bot.joinVoice(voiceChannel);
    connections.set(voiceChannel, voice);
  }
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
      if (playing.get(voiceChannel)?.voice === voice) {
        void stopPlaying(voiceChannel);
      }
    });
}

await bot.listen(async (message) => {
  if (isAction(message)) {
    if (message.actionId !== 'stop') return;
    for (const [channelId, current] of playing) {
      if (current.panelId === message.panelId) await stopPlaying(channelId);
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
      if (voiceChannel) await stopPlaying(voiceChannel);
      return;
    }
    case 'disconnect': {
      const voiceChannel = await voiceChannelOf(message.senderId);
      if (voiceChannel) await disconnect(voiceChannel);
      return;
    }
  }
});

// Rift knows none of these verbs. `summon` and `dismiss` are what the *author*
// says a command means, and the client acts on them — which is why `/stop` and
// `/disconnect` are two commands here rather than one: stopping a track and
// leaving the room are different things to want, and somebody who wanted quiet
// for a minute should not have to summon the bot back.
//
// `dismiss` on `/disconnect` is a backstop as much as a convenience: the client
// drops the summon whether or not this bot is still running, so a crashed bot
// still loses its key and its connection.
await session.publishManifest({
  description: 'Plays a URL in your voice channel.',
  commands: [
    { name: 'play', description: 'Play something', usage: '<url>', summon: true },
    { name: 'stop', description: 'Stop the track, stay in the call' },
    { name: 'disconnect', description: 'Stop and leave the call', dismiss: true },
  ],
});

console.log('playing. ctrl-c to stop.');
