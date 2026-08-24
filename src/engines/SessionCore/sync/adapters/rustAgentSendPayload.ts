import type { AgentMessageResponse } from "@src/api/tauri/agent";

import type { AdapterSendInput, AdapterSendReceipt } from "../types";

/** Build the exact Tauri payload for a Rust-native agent turn. */
export function buildRustAgentSendMessageArgs(
  input: AdapterSendInput
): Record<string, unknown> {
  const {
    sessionId,
    content,
    displayText,
    model,
    accountId,
    mode,
    adeContext,
    imageDataUrls,
    isResume,
    clientMessageId,
    turnIntentId,
    turnIntentSource,
    directUserIntent,
    sessionRepoPath,
  } = input;
  const workspacePath = sessionRepoPath ?? undefined;

  return {
    sessionId,
    content,
    ...(displayText && displayText !== content ? { displayText } : {}),
    ...(model ? { model } : {}),
    ...(accountId ? { accountId } : {}),
    ...(mode ? { mode } : {}),
    ...(workspacePath ? { workspacePath } : {}),
    ...(imageDataUrls && imageDataUrls.length > 0
      ? { images: imageDataUrls }
      : {}),
    ...(adeContext ? { ideContext: adeContext } : {}),
    ...(isResume ? { isResume: true } : {}),
    ...(clientMessageId ? { clientMessageId } : {}),
    ...(turnIntentId ? { turnIntentId } : {}),
    ...(directUserIntent ? { markDirectUserIntervention: true } : {}),
    turnIntentSource,
  };
}

/** Parse the typed acknowledgement embedded in Rust's AgentResponse content. */
export function parseRustAgentSendReceipt(
  response: AgentMessageResponse
): AdapterSendReceipt {
  let payload: unknown;
  try {
    payload = JSON.parse(response.content);
  } catch {
    throw new Error("agent_send_message returned a non-JSON acknowledgement");
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as { duplicate?: unknown }).duplicate !== "boolean"
  ) {
    throw new Error(
      "agent_send_message acknowledgement is missing boolean duplicate"
    );
  }
  const turnIntentStatus = (payload as { turnIntentStatus?: unknown })
    .turnIntentStatus;
  if (typeof turnIntentStatus !== "string" || !turnIntentStatus) {
    throw new Error(
      "agent_send_message acknowledgement has invalid turnIntentStatus"
    );
  }
  const steered = (payload as { steered?: unknown }).steered;
  if (steered !== undefined && typeof steered !== "boolean") {
    throw new Error(
      "agent_send_message acknowledgement has invalid steered flag"
    );
  }
  const effectiveTurnIntentId = (payload as { effectiveTurnIntentId?: unknown })
    .effectiveTurnIntentId;
  if (typeof effectiveTurnIntentId !== "string" || !effectiveTurnIntentId) {
    throw new Error(
      "agent_send_message acknowledgement has invalid effectiveTurnIntentId"
    );
  }
  return {
    duplicate: (payload as { duplicate: boolean }).duplicate,
    ...(steered !== undefined ? { steered } : {}),
    turnIntentStatus,
    effectiveTurnIntentId,
  };
}
