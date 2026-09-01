/**
 * The one string an admin hands a bot.
 *
 * An invite packs the server's URL and the code together so whoever is joining
 * pastes one thing, and it survives being sent through a chat app — three
 * shapes, all the same pair underneath (`lib/data/invite_link.dart`):
 *
 * - `<server-url>#<code>` — the plain form.
 * - `rift://join#<server-url>#<code>` — what a landing page hands the app.
 * - `https://joinrift.app/join#<server-url>#<code>` — the clickable one.
 *
 * A bot takes any of them, which is the point: the admin sends the same link
 * they would send a person, and the bot's config is that link rather than a
 * server id and an anon key somebody had to go and find.
 *
 * This mirrors the app's parser rather than inventing a looser one. A third
 * reading of the format is a third thing that can disagree about where the
 * URL ends, and the failure is a bot that cannot join a server whose invite
 * everybody else can use.
 */
export interface Invite {
  readonly serverUrl: string;
  readonly inviteCode: string;
}

/** Enough to tell a wrapped server URL from an invite code. A code is hex. */
function looksLikeUrl(value: string): boolean {
  return value.startsWith('http');
}

function make(serverUrl: string, inviteCode: string): Invite | null {
  const url = serverUrl.trim().replace(/\/+$/, '');
  const code = inviteCode.trim();
  if (url.length === 0 || code.length === 0) return null;
  return { serverUrl: url, inviteCode: code };
}

/** Parse any of the three shapes. Null if it is not a complete invite. */
export function parseInvite(input: string): Invite | null {
  const trimmed = input.trim();

  // A wrapper first: `<wrapper>#<server-url>#<code>`. Split the plain way round
  // and the last `#` would take the code off correctly but leave the wrapper
  // glued to the front of the server URL.
  const parts = trimmed.split('#');
  if (parts.length === 3 && looksLikeUrl(parts[1])) {
    return make(parts[1], parts[2]);
  }

  const sep = trimmed.lastIndexOf('#');
  if (sep <= 0) return null;
  return make(trimmed.slice(0, sep), trimmed.slice(sep + 1));
}
