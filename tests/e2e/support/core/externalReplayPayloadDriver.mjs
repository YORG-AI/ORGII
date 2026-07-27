import { createHash } from "node:crypto";

import {
  REPLAY_MAX_EVENTS,
  REPLAY_MAX_IPC_BYTES,
  clickRenderedSelector,
  execJS,
  invokeE2E,
  invokeTauriCommand,
  renderedSelectorSnapshot,
  waitForRenderedSelector,
} from "./externalReplayUiDriver.mjs";

function replayLimits() {
  return {
    maxTurns: 1,
    maxEvents: REPLAY_MAX_EVENTS,
    maxIpcBytes: REPLAY_MAX_IPC_BYTES,
  };
}

export async function verifyLargePayloadRange({
  sessionId,
  expectedBytes,
  expectedSha256,
}) {
  const payloadWindow = await invokeTauriCommand(
    "external_replay_query_window",
    {
      sourceId: "codex_app",
      sessionId,
      turnIndex: 13,
      limits: replayLimits(),
    }
  );
  const wireBytes = Buffer.byteLength(JSON.stringify(payloadWindow));
  if (wireBytes >= REPLAY_MAX_IPC_BYTES) {
    throw new Error(
      `compact middle-turn window crossed the 4 MiB IPC cap: ${wireBytes} bytes`
    );
  }
  const payloadEvent = payloadWindow.events?.find((event) =>
    event?.payloadRefs?.some(
      (payloadRef) => payloadRef?.fieldPath === "result.output"
    )
  );
  const payloadRef = payloadEvent?.payloadRefs?.find(
    (candidate) => candidate?.fieldPath === "result.output"
  );
  if (!payloadEvent || !payloadRef) {
    throw new Error(
      `large shell output did not become a replay payload ref: ${JSON.stringify(
        payloadWindow.events?.map((event) => ({
          id: event?.id,
          payloadRefs: event?.payloadRefs,
        }))
      )}`
    );
  }
  if (
    payloadRef.truncated !== true ||
    Number(payloadRef.fullSizeBytes) !== expectedBytes ||
    Buffer.byteLength(String(payloadEvent?.result?.output ?? "")) >=
      expectedBytes
  ) {
    throw new Error(
      `large shell output was not compacted before IPC: ${JSON.stringify({
        wireBytes,
        payloadRef,
        previewBytes: Buffer.byteLength(
          String(payloadEvent?.result?.output ?? "")
        ),
      })}`
    );
  }

  // Prove the paged historical tool event reaches the rendered UI and can be
  // expanded through its real activity header. tauri-wd does not emit the
  // native `mouseenter` used by the terminal's icon-only chevron, so the
  // final Show-more hover/click remains a separate Computer Use gate.
  const activityGroupSelector = `[data-tool-call-event-id="${payloadEvent.id}"]`;
  const activityGroupExists = await browser
    .waitUntil(
      async () =>
        Boolean(await renderedSelectorSnapshot(activityGroupSelector)),
      { timeout: 5_000, interval: 100 }
    )
    .then(() => true)
    .catch(() => false);
  if (!activityGroupExists) {
    // tauri-wd 0.1.3 supports only one pending script evaluation at a time.
    const rendered = await execJS(`
          const list = document.querySelector(
            '[data-chat-view-root] [data-testid="chat-message-list"]'
          );
          const elements = Array.from(
            list?.querySelectorAll(
              '[data-tool-call-event-id], [class*="terminal"], [class*="summary"], [data-item-index]'
            ) ?? []
          );
          return {
            chatText: (list?.innerText || '').slice(0, 12000),
            elements: elements.slice(0, 80).map((element) => ({
              tag: element.tagName,
              className: element.getAttribute('class') || '',
              toolEventId:
                element.getAttribute('data-tool-call-event-id') || '',
              itemIndex: element.getAttribute('data-item-index') || '',
              text: (element.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 500),
            })),
          };
        `);
    const chatState = await invokeE2E("inspectChatState");
    throw new Error(
      `middle-turn payload event did not render its activity group: ${JSON.stringify(
        {
          rendered,
          chatState,
          payloadEventId: payloadEvent.id,
        }
      )}`
    );
  }
  const activityHeaderSelector = `${activityGroupSelector} .group\\/chat-block-header`;
  await clickRenderedSelector(activityHeaderSelector, {
    label: "middle-turn activity header",
  });
  const terminalSelector = '[class~="group/terminal"]';
  await waitForRenderedSelector(terminalSelector, {
    label: "middle-turn terminal",
  });
  const terminalText = String(
    (await renderedSelectorSnapshot(terminalSelector))?.text ?? ""
  );
  if (
    !terminalText.includes("Ran command") ||
    !terminalText.includes("printf")
  ) {
    throw new Error(
      `middle-turn terminal did not render after expanding its activity group: ${terminalText}`
    );
  }

  // The backend range API is the byte-accuracy oracle. Rebuild the body from
  // capped pieces and compare its hash with the deterministic JSONL fixture.
  const hash = createHash("sha256");
  let offset = 0;
  let eof = false;
  let rangeCount = 0;
  let firstText = "";
  let lastText = "";
  while (!eof) {
    const range = await invokeTauriCommand(
      "external_replay_read_payload_range",
      {
        sourceId: "codex_app",
        sessionId,
        generation:
          payloadRef.replayGeneration ?? payloadWindow.cursor?.generation,
        eventId: payloadRef.replaySourceEventId ?? payloadEvent.id,
        fieldPath: payloadRef.fieldPath,
        offset,
        maxBytes: 256 * 1024,
      }
    );
    const text = String(range?.text ?? "");
    if (rangeCount === 0) firstText = text;
    lastText = text;
    if (
      Number(range?.offset) !== offset ||
      Number(range?.nextOffset) <= offset ||
      Buffer.byteLength(text) > 256 * 1024 ||
      Number(range?.totalBytes) !== expectedBytes
    ) {
      throw new Error(
        `invalid payload range ${rangeCount}: ${JSON.stringify({
          offset,
          responseOffset: range?.offset,
          nextOffset: range?.nextOffset,
          textBytes: Buffer.byteLength(text),
          totalBytes: range?.totalBytes,
        })}`
      );
    }
    hash.update(text);
    offset = Number(range.nextOffset);
    eof = range.eof === true;
    rangeCount += 1;
    if (rangeCount > 64) {
      throw new Error("payload range reconstruction did not terminate");
    }
  }
  const actualSha256 = hash.digest("hex");
  if (
    offset !== expectedBytes ||
    actualSha256 !== expectedSha256 ||
    !firstText.startsWith("E2E bounded replay large payload start") ||
    !lastText.endsWith("E2E bounded replay large payload end")
  ) {
    throw new Error(
      `payload range reconstruction mismatch: ${JSON.stringify({
        offset,
        expectedBytes,
        rangeCount,
        actualSha256,
        expectedSha256,
        firstText: firstText.slice(0, 80),
        lastText: lastText.slice(-80),
      })}`
    );
  }
}
