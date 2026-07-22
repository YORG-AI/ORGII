export const RAW_TRANSCRIPT_VIRTUAL_BASE_INDEX = 1_000_000_000;

interface ReplayVirtualEntry {
  id: string;
}

export interface ReplayVirtualAnchorInput {
  sessionId: string;
  generation: string;
  revision: number;
  throughSequence: number;
  newerContentReleased: boolean;
  entries: readonly ReplayVirtualEntry[];
}

export interface ReplayVirtualAnchorState extends ReplayVirtualAnchorInput {
  firstItemIndex: number;
}

function resetReplayVirtualAnchor(
  input: ReplayVirtualAnchorInput
): ReplayVirtualAnchorState {
  return {
    ...input,
    firstItemIndex: Math.max(
      0,
      RAW_TRANSCRIPT_VIRTUAL_BASE_INDEX - input.entries.length
    ),
  };
}

/**
 * Keep Virtuoso's logical first index aligned with the number of rows that
 * were actually prepended, not the size of the bounded in-memory window.
 *
 * Once Raw Transcript reaches its event/byte cap, loading an older page adds a
 * prefix and releases the same number of newer rows. `entries.length` then
 * stays constant, but Virtuoso still needs a decreasing `firstItemIndex` to
 * preserve the user's scroll anchor.
 */
export function reconcileReplayVirtualAnchor(
  current: ReplayVirtualAnchorState | null,
  input: ReplayVirtualAnchorInput
): ReplayVirtualAnchorState {
  if (current?.entries === input.entries) return current;

  const sourceReset =
    !current ||
    current.sessionId !== input.sessionId ||
    current.generation !== input.generation ||
    input.throughSequence > current.throughSequence ||
    (current.newerContentReleased && !input.newerContentReleased);
  if (sourceReset) return resetReplayVirtualAnchor(input);

  const previousFirstId = current.entries[0]?.id;
  if (!previousFirstId || input.entries.length === 0) {
    return resetReplayVirtualAnchor(input);
  }

  const prependedCount = input.entries.findIndex(
    (entry) => entry.id === previousFirstId
  );
  if (prependedCount < 0) {
    // A same-generation refresh can replace an older browsing window with the
    // latest bounded tail. With no shared leading anchor, treat it as a reset.
    return resetReplayVirtualAnchor(input);
  }

  return {
    ...input,
    firstItemIndex: Math.max(0, current.firstItemIndex - prependedCount),
  };
}
