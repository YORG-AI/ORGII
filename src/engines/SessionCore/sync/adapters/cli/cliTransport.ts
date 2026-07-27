import { enterAgentOrgSessionIntervention } from "@src/api/tauri/agent";
import type { CancelReason } from "@src/api/tauri/agent/session";
import { rpc } from "@src/api/tauri/rpc";
import { cliTurnLifecycleCoordinator } from "@src/hooks/cliSession/cliTurnLifecycleCoordinator";
import { createLogger } from "@src/hooks/logger";

import type { AdapterSendInput } from "../../types";

const log = createLogger("CliTransport");

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
    directUserIntent,
  } = input;
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
  if (directUserIntent) {
    void enterAgentOrgSessionIntervention(sessionId).catch((error) => {
      log.warn(
        "[sendCliMessage] accepted CLI turn but failed to persist intervention:",
        error
      );
    });
  }
}

export async function stopCliSession(
  sessionId: string,
  reason: CancelReason
): Promise<void> {
  await rpc.cli.cancel({ sessionId, reason });
}
