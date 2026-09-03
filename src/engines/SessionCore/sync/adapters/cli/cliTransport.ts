import type { CancelReason } from "@src/api/tauri/agent/session";
import { rpc } from "@src/api/tauri/rpc";
import { cliTurnLifecycleCoordinator } from "@src/hooks/cliSession/cliTurnLifecycleCoordinator";

import type { AdapterSendInput } from "../../types";

function newMessageId(): string {
  return crypto.randomUUID();
}

export async function sendCliMessage(input: AdapterSendInput): Promise<void> {
  if (input.agentOrgDirectSourceEventId) {
    throw new Error(
      "user_directed_target_invalid: CLI Sessions cannot execute Agent Org UserDirectedWork"
    );
  }
  const {
    sessionId,
    content,
    model,
    accountId,
    mode,
    imageDataUrls,
    adeContext,
  } = input;
  const turnIntentId = input.turnIntentId ?? newMessageId();
  const clientMessageId = input.clientMessageId ?? newMessageId();
  const receipt = await rpc.cli.message({
    request: {
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
    },
  });

  cliTurnLifecycleCoordinator.registerReceipt(receipt);
}

export async function stopCliSession(
  sessionId: string,
  reason: CancelReason
): Promise<void> {
  await rpc.cli.cancel({ sessionId, reason });
}
