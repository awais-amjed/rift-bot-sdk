// Adding a bot to a server: one paste.
//
//   node example/join.ts '<invite link>' <username> <seedFile>
//
// The invite is the same link an admin would send a person — any of its three
// shapes. That is not a convenience: an invite already carries exactly the
// right thing, a per-server grant of scoped permissions that whoever minted it
// can revoke (BOTS.md §1).
//
// Run once. An invite is spent, so save what this prints next to the seed and
// construct a `BotSession` directly from then on.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { BotSession } from '../src/index.ts';

const [invite, username, seedFile] = process.argv.slice(2);

// The seed is the whole identity: 32 random bytes, kept out of the repo, and
// whoever holds it *is* the bot. Reused if one is already there so a re-run
// cannot quietly strand the old identity.
if (!existsSync(seedFile)) {
  writeFileSync(seedFile, randomBytes(32).toString('base64'), { mode: 0o600 });
  console.log(`wrote a new seed to ${seedFile} — back it up, it cannot be recovered`);
}
const seed = Buffer.from(readFileSync(seedFile, 'utf8').trim(), 'base64');

const session = await BotSession.join({ invite, seed, username });

console.log(`joined as ${username} (${session.userId})`);
console.log('save this next to the seed:');
console.log(JSON.stringify(session.config, null, 2));
