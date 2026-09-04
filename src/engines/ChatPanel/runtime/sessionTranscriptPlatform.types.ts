import type { MutableRefObject } from "react";

import type { CursorIdeTurnSummary } from "@src/api/tauri/externalHistory";
import type { SessionLoadStatus } from "@src/engines/SessionCore";
import type { Session } from "@src/store/session";

export interface SessionTranscriptPlatformState {
  session: Session | undefined;
  cursorIdeTurnSummaries: CursorIdeTurnSummary[];
  isCursorIde: boolean;
  isAgentWorking: boolean;
  isAgentWorkingRef: MutableRefObject<boolean>;
  isExploring: boolean;
  loadStatus: SessionLoadStatus;
  loadError: string | null;
  isPendingCancel: boolean;
  isRolledBack: boolean;
  isHydrating: boolean;
  onReload: () => void;
  onReplyQuestion: (input: { reply: string; chunk_id: string }) => void;
  onIgnoreQuestion: (eventId: string) => void;
  capabilities: {
    canvasInline: boolean;
    turnMetadata: boolean;
  };
}
