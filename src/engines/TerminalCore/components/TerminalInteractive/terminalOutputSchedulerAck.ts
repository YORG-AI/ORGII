import { invokeTauri, isTauriReady } from "@src/util/platform/tauri/init";

import type { PaneScheduler } from "./terminalOutputSchedulerTypes";

export function scheduleAck(pane: PaneScheduler): void {
  if (pane.ackScheduled || pane.pendingAckBytes === 0) return;
  pane.ackScheduled = true;

  // Flush after the current write batch but before the next macrotask.
  queueMicrotask(() => {
    flushAck(pane);
  });
}

export function flushAck(pane: PaneScheduler): void {
  if (pane.pendingAckBytes > 0 && isTauriReady()) {
    invokeTauri("ack_pty_data", {
      sessionId: pane.sessionId,
      byteCount: pane.pendingAckBytes,
      queueDepth: pane.queueByteLength,
      renderMs: Math.round(pane.lastRenderMs),
    }).catch(() => undefined);
    pane.pendingAckBytes = 0;
  }
  pane.ackScheduled = false;
}
