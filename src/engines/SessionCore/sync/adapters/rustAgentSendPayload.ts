import type { AdapterSendInput } from "../types";

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
