/**
 * Suggestions while somebody types a command — WIRE.md §7.
 *
 * A member's Rift asks as they type `/play thats so tr`, on this bot's own
 * topic, and the bot answers on theirs. Nothing is stored: both halves are
 * Realtime broadcasts, gone once delivered.
 *
 * **Who asked is a claim.** A broadcast carries no sender the server vouches
 * for, so `from` is whatever the asking client wrote. The worst a liar gets is
 * suggestions sent to somebody else, and that client drops them, because only
 * the asker knows the request's `id`. So the answer is safe to send; the
 * request is not safe to *act* on. A suggestion handler looks things up and
 * nothing more — the command itself arrives later, signed, through `listen`.
 */

/** The event a member's client sends to `user:<bot id>`. */
export const SUGGEST_EVENT = 'bot_suggest';

/** The event a bot answers with, on `user:<asker id>`. */
export const SUGGESTIONS_EVENT = 'bot_suggestions';

/** At most this many come back; a menu above a composer holds a handful. */
export const MAX_SUGGESTIONS = 10;

const MAX_TEXT = 200;
const MAX_LABEL = 100;
const MAX_VALUE = 500;

/** What somebody has typed so far, after the command's name. */
export interface SuggestRequest {
  /** The client's own id for this request, echoed in the answer. */
  readonly id: string;
  /** Who says they asked. Not verified — see the top of this file. */
  readonly from: string;
  /** The channel they are typing in, as they say. */
  readonly channelId: string;
  /** The command, lower case, without its slash: `play`. */
  readonly command: string;
  /** Everything after `/play `, as typed. */
  readonly text: string;
}

/** One row of the menu. Picking it sends `/<command> <value>`. */
export interface Suggestion {
  readonly label: string;
  readonly value: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A request as it came off the wire, or null for anything malformed. */
export function parseSuggestRequest(payload: Record<string, unknown>): SuggestRequest | null {
  const { v, id, from, channel, command, text } = payload;
  if (v !== 1) return null;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) return null;
  if (typeof from !== 'string' || !UUID.test(from)) return null;
  if (typeof channel !== 'string' || !UUID.test(channel)) return null;
  if (typeof command !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(command)) return null;
  if (typeof text !== 'string' || text.length > MAX_TEXT) return null;
  return { id, from, channelId: channel, command, text };
}

/**
 * What a handler returned, cut to what the wire allows: ten rows, each with a
 * label and a value of sane length. A row that does not fit is dropped rather
 * than cut, since a cut value would send something nobody picked.
 */
export function cleanSuggestions(items: readonly Suggestion[]): Suggestion[] {
  return items
    .filter(
      (s) =>
        typeof s?.label === 'string' &&
        typeof s?.value === 'string' &&
        s.label.trim() !== '' &&
        s.value.trim() !== '' &&
        s.value.length <= MAX_VALUE &&
        !s.value.includes('\n'),
    )
    .slice(0, MAX_SUGGESTIONS)
    .map((s) => ({
      label: s.label.length > MAX_LABEL ? `${s.label.slice(0, MAX_LABEL - 1)}…` : s.label,
      value: s.value,
    }));
}

/** The answer's payload. */
export function suggestionsPayload(
  request: SuggestRequest,
  botId: string,
  items: readonly Suggestion[],
): Record<string, unknown> {
  return { v: 1, id: request.id, bot: botId, items: cleanSuggestions(items) };
}
