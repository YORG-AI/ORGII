import { enterAgentOrgSessionIntervention } from "@src/api/tauri/agent";
import type { CancelReason } from "@src/api/tauri/agent/session";
import { rpc } from "@src/api/tauri/rpc";
import { cliTurnLifecycleCoordinator } from "@src/hooks/cliSession/cliTurnLifecycleCoordinator";

import type { AdapterSendInput } from "../../types";

function newMessageId(): string {
  return crypto.randomUUID();
}

export async function sendCliMessage(input: AdapterSendInput): Promise<void> {
  const {
    sessionId,
    content,
    model,
    accountId,
    mode,
    imageDataUrls,
    adeContext,
    isResume,
  } = input;
  if (!isResume && content.trim()) {
    await enterAgentOrgSessionIntervention(sessionId);
  }
  const turnIntentId = input.turnIntentId ?? newMessageId();
  const clientMessageId = input.clientMessageId ?? newMessageId();
  const receipt = await rpc.cli.message({
    sessionId,
    content,
    turnIntentId,
    clientMessageId,
    ...(model ? { model } : {}),
    ...(accountId ? { accountId } : {}),
    ...(mode ? { mode } : {}),
    ...(imageDataUrls && imageDataUrls.length > 0
      ? { images: imageDataUrls }
      : {}),
    ...(adeContext ? { ideContext: adeContext } : {}),
  });
  cliTurnLifecycleCoordinator.registerReceipt(receipt);
}

export async function stopCliSession(
  sessionId: string,
  reason: CancelReason
): Promise<void> {
  await rpc.cli.cancel({ sessionId, reason });
}
