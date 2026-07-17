import { atom } from "jotai";
import { atomFamily } from "jotai-family";

import type { TurnSummary } from "@src/engines/SessionCore/storage/sqliteCache";

export type TurnMetadataState = TurnSummary | null | undefined;

export function turnMetadataKey(sessionId: string, turnId: string): string {
  return `${sessionId}\u0000${turnId}`;
}

/**
 * One atom per round keeps a late metadata load from invalidating the whole
 * virtualized chat tree. `undefined` means not loaded, `null` means the turn
 * index loaded but has no matching round.
 */
export const turnMetadataAtomFamily = atomFamily((key: string) => {
  const stateAtom = atom<TurnMetadataState>(undefined);
  stateAtom.debugLabel = `chat/turnMetadata/${key}`;
  return stateAtom;
});
