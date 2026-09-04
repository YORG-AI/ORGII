import type { RefObject } from "react";

import type { ComposerInputRef } from "@src/components/ComposerInput";
import { projectOutgoingUserMessage } from "@src/engines/ChatPanel/hooks/useInputArea/projectOutgoingUserMessage";
import { dispatchCategoryAtom } from "@src/store/session/creatorStateAtom";
import type { SessionSource } from "@src/store/session/creatorStateAtom";
import {
  getInstrumentedStore,
  isStoreInitialized,
} from "@src/util/core/state/instrumentedStore";

import { formatUserInput } from "./useInputFormatter";

export interface PreparedLaunchInput {
  userInput: string;
  agentInput: string;
}

export interface PrepareLaunchInputOptions {
  editorContent: string;
  effectiveSource: SessionSource | null;
  composerInputRef: RefObject<ComposerInputRef | null>;
  /**
   * Capability gate for the Canvas interception. Defaults to reading the
   * creator's dispatch category: CLI agents have no `render_inline_canvas`
   * tool, so a `/canvas` draft must launch as ordinary text there.
   */
  allowCanvasInterception?: boolean;
}

function launchTargetsCliAgent(): boolean {
  if (!isStoreInitialized()) return false;
  try {
    return getInstrumentedStore().get(dispatchCategoryAtom) === "cli_agent";
  } catch {
    return false;
  }
}

export async function prepareLaunchInput(
  options: PrepareLaunchInputOptions
): Promise<PreparedLaunchInput> {
  const { editorContent, effectiveSource, composerInputRef } = options;
  const repoRef = effectiveSource?.repoPath
    ? { path: effectiveSource.repoPath }
    : undefined;

  const userInput = composerInputRef.current?.getTextWithPills
    ? (composerInputRef.current.getTextWithPills() || "").trim()
    : formatUserInput({ editorContent, composerInputRef, repo: repoRef })
        .userInput;

  const { waitForPendingPills } = await import("@src/util/contextPillContent");
  await waitForPendingPills();

  const terminalTexts = composerInputRef.current?.getTerminalPillTexts?.();
  const terminalEntries = terminalTexts ? Object.entries(terminalTexts) : [];
  const terminalBlocks = terminalEntries.map(([, text]) =>
    ["```", text, "```"].join("\n")
  );

  // `userInput` is the serialized DISPLAY form (pill tokens intact) and feeds
  // the synthetic user event. The new session's first LLM message must be the
  // shared agent projection — skill pills expanded, editor-internal `::base64`
  // payloads stripped, and a `/canvas` draft replaced by its tool contract —
  // never the raw serialization.
  const projection = projectOutgoingUserMessage({
    displayText: userInput,
    contextBlocks: terminalBlocks,
    allowCanvasInterception:
      options.allowCanvasInterception ?? !launchTargetsCliAgent(),
  });

  return {
    userInput: projection.displayContent,
    agentInput: projection.agentContent ?? projection.displayContent,
  };
}
