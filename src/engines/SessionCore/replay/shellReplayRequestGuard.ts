import type { ReplayWindowDirection } from "./shellReplayRange";

export interface ShellReplayRequestTicket {
  identity: string;
  generation: number;
}

/** Invalidates in-flight reads immediately when the playback cursor changes. */
export class ShellReplayRequestGuard {
  private identity = "";
  private generation = 0;

  setIdentity(identity: string): void {
    if (identity === this.identity) return;
    this.identity = identity;
    this.generation += 1;
  }

  beginRequest(): ShellReplayRequestTicket {
    this.generation += 1;
    return { identity: this.identity, generation: this.generation };
  }

  isCurrent(ticket: ShellReplayRequestTicket): boolean {
    return (
      ticket.identity === this.identity && ticket.generation === this.generation
    );
  }
}

export async function readShellReplayRangeIfCurrent<T>(
  guard: ShellReplayRequestGuard,
  ticket: ShellReplayRequestTicket,
  read: () => Promise<T>
): Promise<T | null> {
  const value = await read();
  return guard.isCurrent(ticket) ? value : null;
}

export function scheduleShellReplayPrefetch(
  load: () => void,
  delayMs: number
): () => void {
  const timerId = setTimeout(load, delayMs);
  return () => clearTimeout(timerId);
}

export function shouldShowShellReplayLoadingPlaceholder(
  direction: ReplayWindowDirection | null
): boolean {
  return direction === "prepend" || direction === "append";
}
