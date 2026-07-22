import { atom } from "jotai";
import { atomFamily } from "jotai-family";

import type { ExternalReplayTurnSummary } from "@src/api/tauri/externalHistory";

export const externalReplayTurnSummariesAtomFamily = atomFamily(
  (sessionId: string) => {
    const sessionAtom = atom<ExternalReplayTurnSummary[]>([]);
    sessionAtom.debugLabel = `externalReplayTurnSummaries(${sessionId})`;
    return sessionAtom;
  }
);

/** @deprecated Use `externalReplayTurnSummariesAtomFamily`. */
export const cursorIdeTurnSummariesAtomFamily =
  externalReplayTurnSummariesAtomFamily;
