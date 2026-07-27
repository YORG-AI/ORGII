/**
 * Stream text accumulator helpers.
 *
 * Live stream transports are intended to send delta fragments, but reconnects,
 * provider retries, and mixed CLI/Rust paths can occasionally replay already
 * delivered text or send a cumulative snapshot. A blind `current + incoming`
 * then renders duplicated assistant text. This helper preserves normal fragment
 * appends while making accumulation idempotent for common replay/snapshot cases.
 */

/**
 * Merge an incoming stream payload into the currently displayed content.
 *
 * Handles common cases:
 * - normal fragment:              "Hello " + "world"       -> "Hello world"
 * - cumulative snapshot:          "Hello" + "Hello world"  -> "Hello world"
 * - meaningful exact/tail replay: "The assistant starts here" + same text -> unchanged
 * - overlapping replay tail:      "A long prefix..." + "prefix...tail" -> merged tail
 */
export function mergeStreamingText(current: string, incoming: string): string {
  if (!current) return incoming;
  if (!incoming) return current;

  // Cumulative/snapshot frame. The backend may resend the whole visible stream.
  // This is the most common duplicated-prefix failure mode and is safe to
  // normalize because the incoming payload already includes all current text.
  if (incoming.length > current.length && incoming.startsWith(current)) {
    return incoming;
  }

  // If the live buffer has already been capped from the front, a full cumulative
  // snapshot can contain more text while ending with the currently visible tail.
  // Replace with the snapshot so capStreamContent can trim it consistently.
  if (
    current.length >= MIN_REPLAY_TEXT_LENGTH &&
    incoming.length > current.length &&
    incoming.endsWith(current)
  ) {
    return incoming;
  }

  // Complete replay of a meaningful recent fragment.
  if (incoming.length >= MIN_REPLAY_TEXT_LENGTH && current.endsWith(incoming)) {
    return current;
  }

  const overlap = findSuffixPrefixOverlap(current, incoming);
  if (overlap >= MIN_REPLAY_TEXT_LENGTH) {
    return current + incoming.slice(overlap);
  }

  return current + incoming;
}

const MIN_REPLAY_TEXT_LENGTH = 12;
export const MAX_TOOL_CALL_DELTA_CHARS = 1_000_000;
export const MAX_TOOL_CALL_DELTA_BUFFERS = 64;

export function appendBoundedToolCallArgs(
  current: string,
  incoming: string
): string {
  const remaining = MAX_TOOL_CALL_DELTA_CHARS - current.length;
  if (remaining <= 0 || !incoming) return current;
  return current + incoming.slice(0, remaining);
}

export function makeRoomForToolCallDelta<T>(
  buffers: Map<number, T>,
  incomingIndex: number
): void {
  if (
    buffers.has(incomingIndex) ||
    buffers.size < MAX_TOOL_CALL_DELTA_BUFFERS
  ) {
    return;
  }
  const oldestIndex = buffers.keys().next().value;
  if (oldestIndex !== undefined) buffers.delete(oldestIndex);
}

function findSuffixPrefixOverlap(current: string, incoming: string): number {
  const max = Math.min(current.length, incoming.length);
  const pattern = incoming.slice(0, max);
  const table = buildPrefixTable(pattern);
  let matched = 0;

  const currentTail = current.slice(-max);
  for (let index = 0; index < currentTail.length; index += 1) {
    const char = currentTail[index];
    while (matched > 0 && char !== pattern[matched]) {
      matched = table[matched - 1];
    }
    if (char === pattern[matched]) {
      matched += 1;
    }
  }

  return matched;
}

function buildPrefixTable(pattern: string): number[] {
  const table = new Array<number>(pattern.length).fill(0);
  let matched = 0;

  for (let index = 1; index < pattern.length; index += 1) {
    while (matched > 0 && pattern[index] !== pattern[matched]) {
      matched = table[matched - 1];
    }
    if (pattern[index] === pattern[matched]) {
      matched += 1;
      table[index] = matched;
    }
  }

  return table;
}
